import Parser from "rss-parser";
import crypto from "node:crypto";
import { getDb } from "./db";
import { fetchText, fetchTextWithRetry, isTransientError, isTransientStatus, sleep } from "./http";
import { firstImage, htmlToText, sanitizeHtml } from "./html";
import { purgeRuleMatches, runRulesForNewArticles } from "./automations";
import { applyFiltersToArticles, reapplyFilters } from "./filters";
import { indexArticles } from "./search";
import { getSettings } from "./settings";
import { YOUTUBE_FEED_LIKE, isYouTubeFeed, youTubeArticleHtml, youTubeVideoId } from "./youtube";
import { isGoogleNewsFeed, stripSource } from "./googleNews";
import type { FolderAutomations, LinkedAutomations } from "./types";

type MediaAttr = { $?: { url?: string; medium?: string; type?: string } };
type Item = Parser.Item & {
  "content:encoded"?: string;
  mediaContent?: MediaAttr[];
  mediaThumbnail?: MediaAttr | MediaAttr[];
  mediaGroup?: { "media:content"?: MediaAttr[]; "media:thumbnail"?: MediaAttr[]; "media:description"?: unknown };
  author?: string;
  "dc:creator"?: string;
  id?: string;
  /** Google News: the publisher, as `{ _: name, $: { url } }`. */
  source?: unknown;
};

const parser: Parser<Record<string, unknown>, Item> = new Parser({
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail"],
      ["media:group", "mediaGroup"],
      ["dc:creator", "dc:creator"],
      ["id", "id"],
      ["source", "source"],
    ],
  },
});

export type FeedRow = {
  id: number;
  folder_id: number | null;
  title: string;
  feed_url: string;
  site_url: string | null;
  icon_url: string | null;
  icon_checked: number;
  etag: string | null;
  last_modified: string | null;
  last_fetched_at: number | null;
  last_error: string | null;
};

function looksLikeFeed(text: string) {
  const head = text.slice(0, 2000).toLowerCase();
  return head.includes("<rss") || head.includes("<feed") || head.includes("<rdf:rdf");
}

function attr(tag: string, name: string) {
  return new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
}

function findFeedLinks(html: string, base: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = attr(tag, "rel")?.toLowerCase() ?? "";
    const type = attr(tag, "type")?.toLowerCase() ?? "";
    const href = attr(tag, "href");
    if (rel.includes("alternate") && /(rss|atom)\+xml|application\/feed\+json/.test(type) && href) {
      try {
        out.push(new URL(href, base).href);
      } catch {}
    }
  }
  return out;
}

export function findIcon(html: string, base: string): string | undefined {
  let best: { href: string; score: number } | undefined;
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attr(m[0], "rel")?.toLowerCase() ?? "";
    const href = attr(m[0], "href");
    if (!href || !rel.includes("icon")) continue;
    const score = rel.includes("apple-touch") ? 1 : rel === "icon" || rel === "shortcut icon" ? 2 : 0;
    if (!best || score > best.score) {
      try {
        best = { href: new URL(href, base).href, score };
      } catch {}
    }
  }
  return best?.href;
}

/** Given a site or feed URL, return the URL of an actual feed plus the fetched XML. */
export async function discoverFeed(
  input: string,
): Promise<{ feedUrl: string; xml: string; status: number; etag: string | null; lastModified: string | null; pageHtml?: string }> {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const res = await fetchText(url);
  if (res.status >= 400) throw new Error(`HTTP ${res.status} fetching ${url}`);
  if (looksLikeFeed(res.text)) return { feedUrl: res.url, xml: res.text, status: res.status, etag: res.etag, lastModified: res.lastModified };

  const candidates = findFeedLinks(res.text, res.url);
  const origin = new URL(res.url).origin;
  for (const p of ["/feed", "/rss", "/feed.xml", "/rss.xml", "/atom.xml", "/index.xml", "/feeds/posts/default"]) {
    candidates.push(origin + p);
  }
  for (const c of [...new Set(candidates)]) {
    try {
      const r = await fetchText(c, { timeoutMs: 10000 });
      if (r.status < 400 && looksLikeFeed(r.text)) {
        return { feedUrl: r.url, xml: r.text, status: r.status, etag: r.etag, lastModified: r.lastModified, pageHtml: res.text };
      }
    } catch {}
  }
  throw new Error("No RSS or Atom feed found at that address");
}

function mediaUrl(item: Item): string | undefined {
  const pick = (list?: MediaAttr | MediaAttr[]) => {
    const arr = Array.isArray(list) ? list : list ? [list] : [];
    return arr.find((m) => m.$?.url && (!m.$.medium || m.$.medium === "image") && (!m.$.type || m.$.type.startsWith("image")))?.$?.url;
  };
  return (
    pick(item.mediaThumbnail) ||
    pick(item.mediaContent) ||
    pick(item.mediaGroup?.["media:thumbnail"]) ||
    pick(item.mediaGroup?.["media:content"]) ||
    (item.enclosure?.url && (item.enclosure.type ?? "image").startsWith("image") ? item.enclosure.url : undefined)
  );
}

/** Feeds put odd shapes in text fields (Atom authors arrive as `{ name: [...] }`); flatten to a string. */
function text(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return text(o.name ?? o._ ?? o["#"] ?? o.$);
  }
  return null;
}

function itemDate(item: Item, now: number): number {
  const raw = item.isoDate || item.pubDate;
  const t = raw ? Date.parse(raw) : NaN;
  if (Number.isNaN(t)) return now;
  return Math.min(t, now);
}

/**
 * Parse feed XML and insert new articles. Returns the number of new articles. `initial` (adding
 * the feed) imports every item, however old; retention applies from the next refresh on.
 */
async function storeItems(
  feed: FeedRow,
  xml: string,
  { initial = false }: { initial?: boolean } = {},
): Promise<{ added: number; ids: number[]; title?: string; siteUrl?: string }> {
  const parsed = await parser.parseString(xml);
  const db = getDb();
  const now = Date.now();
  const siteUrl = siteFromChannelLink(text(parsed.link), feed.feed_url) || feed.site_url || undefined;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO articles (feed_id, guid, url, title, author, content, excerpt, image_url, published_at, created_at)
    VALUES (@feed_id, @guid, @url, @title, @author, @content, @excerpt, @image_url, @published_at, @created_at)
  `);
  // Most items of a refresh are stored already; spot them before the costly sanitizing.
  // `empty`: YouTube videos stored before Stitch built their player + description have an empty
  // body; fill it in when they show up in the feed again.
  const stored = db.prepare("SELECT id, COALESCE(content, '') = '' AS empty FROM articles WHERE feed_id = ? AND guid = ?");
  const fillVideo = db.prepare("UPDATE articles SET content = ?, excerpt = ? WHERE id = ?");

  // On refresh, items older than the retention window are skipped: purgeOld() deletes read ones,
  // and without their rows INSERT OR IGNORE would re-add them as unread on the next fetch. A new
  // feed imports everything, so it never starts out empty.
  const cutoff = initial ? null : retentionCutoff(isYouTubeFeed(feed.feed_url));
  const googleNews = isGoogleNewsFeed(feed.feed_url);

  let added = 0;
  const toIndex: { id: number; title: string; text: string }[] = [];
  db.transaction(() => {
    for (const item of parsed.items) {
      const publishedAt = itemDate(item, now);
      if (cutoff && publishedAt < cutoff) continue;
      const rawLink = text(item.link);
      const link = rawLink ? safeUrl(rawLink, siteUrl ?? feed.feed_url) : undefined;
      // YouTube entries have no body: build one from the video (player + description).
      const videoId = youTubeVideoId(text(item.id), link ?? null);
      const rawHtml = videoId
        ? youTubeArticleHtml(videoId, text(item.mediaGroup?.["media:description"]))
        : text(item["content:encoded"]) || text(item.content) || text(item.summary) || "";
      // Google News names the publisher separately; show it as the author, not in the title.
      const source = googleNews ? text(item.source) : null;
      const rawTitle = stripSource(text(item.title), source);
      const guid =
        text(item.guid) || text(item.id) || link || crypto.createHash("sha1").update(`${rawTitle ?? ""}|${rawHtml.slice(0, 500)}`).digest("hex");
      const existing = stored.get(feed.id, guid) as { id: number; empty: number } | undefined;
      if (existing) {
        if (videoId && existing.empty && rawHtml)
          fillVideo.run(sanitizeHtml(rawHtml, link ?? siteUrl), htmlToText(rawHtml).slice(0, 400), existing.id);
        continue;
      }
      const plain = htmlToText(rawHtml);
      const content = rawHtml ? sanitizeHtml(rawHtml, link ?? siteUrl) : "";
      const title = (rawTitle && htmlToText(rawTitle)) || plain.slice(0, 80) || "(untitled)";
      const r = insert.run({
        feed_id: feed.id,
        guid,
        url: link ?? null,
        title,
        author: source || text(item.creator) || text(item["dc:creator"]) || text(item.author),
        content,
        // A Google News description is the headline again plus related coverage: no excerpt.
        excerpt: googleNews ? "" : plain.slice(0, 400),
        image_url: mediaUrl(item) || firstImage(rawHtml, link ?? siteUrl) || null,
        published_at: publishedAt,
        created_at: now,
      });
      if (r.changes) {
        added++;
        toIndex.push({ id: Number(r.lastInsertRowid), title, text: content ? htmlToText(content) : "" });
      }
    }
    indexArticles(toIndex);
  })();

  const ids = toIndex.map((a) => a.id);
  // Hide filtered articles before anything else (counts, rules) sees them.
  applyFiltersToArticles(ids);
  return { added, ids, title: parsed.title?.trim() || undefined, siteUrl };
}

/** Some feeds put their own feed URL in the channel <link>; fall back to the site origin then. */
function siteFromChannelLink(link: string | null, feedUrl: string): string | undefined {
  const url = link ? safeUrl(link, feedUrl) : undefined;
  if (url && url !== feedUrl && !/\/(feed|rss)\/?$|\.(xml|rss|atom)$/i.test(new URL(url).pathname)) return url;
  try {
    return new URL(url ?? feedUrl).origin + "/";
  } catch {
    return undefined;
  }
}

function safeUrl(u: string, base: string) {
  try {
    return new URL(u.trim(), base).href;
  } catch {
    return undefined;
  }
}

async function resolveIcon(siteUrl: string | undefined, pageHtml?: string): Promise<string | null> {
  if (!siteUrl) return null;
  try {
    const html = pageHtml ?? (await fetchText(siteUrl, { accept: "text/html", timeoutMs: 8000 })).text;
    return findIcon(html, siteUrl) ?? new URL("/favicon.ico", siteUrl).href;
  } catch {
    try {
      return new URL("/favicon.ico", siteUrl).href;
    } catch {
      return null;
    }
  }
}

/** `iconUrl` replaces the icon found on the site (e.g. a YouTube channel's avatar). */
export async function addFeed(input: string, folderId: number | null, titleOverride?: string, opts: { iconUrl?: string | null } = {}) {
  const db = getDb();
  const startedAt = Date.now();
  const found = await discoverFeed(input);
  const existing = db.prepare("SELECT * FROM feeds WHERE feed_url = ?").get(found.feedUrl) as FeedRow | undefined;
  if (existing) return { feed: existing, added: 0, existed: true };

  const pos = (db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM feeds").get() as { p: number }).p;
  const id = Number(
    db
      .prepare("INSERT INTO feeds (folder_id, title, feed_url, position, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(folderId, titleOverride || found.feedUrl, found.feedUrl, pos, Date.now()).lastInsertRowid,
  );
  let feed = db.prepare("SELECT * FROM feeds WHERE id = ?").get(id) as FeedRow;
  try {
    const { added, title, siteUrl } = await storeItems(feed, found.xml, { initial: true });
    const icon = opts.iconUrl || (await resolveIcon(siteUrl, found.pageHtml));
    db.prepare(
      "UPDATE feeds SET title = ?, site_url = ?, icon_url = ?, icon_checked = 1, etag = ?, last_modified = ?, last_fetched_at = ?, last_error = NULL WHERE id = ?",
    ).run(titleOverride || title || new URL(found.feedUrl).hostname, siteUrl ?? null, icon, found.etag, found.lastModified, Date.now(), id);
    logFetch(id, { startedAt, status: found.status, attempts: 1, newArticles: added, error: null });
    feed = db.prepare("SELECT * FROM feeds WHERE id = ?").get(id) as FeedRow;
    return { feed, added, existed: false };
  } catch (e) {
    db.prepare("DELETE FROM feeds WHERE id = ?").run(id);
    throw e;
  }
}

const FETCH_LOG_PER_FEED = 100;

function logFetch(
  feedId: number,
  entry: { startedAt: number; status: number | null; attempts: number; newArticles: number; error: string | null },
) {
  getDb()
    .prepare("INSERT INTO feed_fetches (feed_id, fetched_at, duration_ms, status, attempts, new_articles, error) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(feedId, entry.startedAt, Date.now() - entry.startedAt, entry.status, entry.attempts, entry.newArticles, entry.error);
}

/** Keep the newest FETCH_LOG_PER_FEED log rows of each feed. */
function purgeFetchLog() {
  getDb()
    .prepare(
      `DELETE FROM feed_fetches WHERE id IN (
         SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY feed_id ORDER BY id DESC) AS n FROM feed_fetches) WHERE n > ?
       )`,
    )
    .run(FETCH_LOG_PER_FEED);
}

/**
 * Fetch one feed (conditional GET) and store new items, retrying transient failures. Errors are
 * recorded on the feed, not thrown. Every refresh (after retries) is written to the refresh log.
 */
export async function refreshFeed(feed: FeedRow): Promise<number> {
  return (await fetchFeed(feed, { attempts: 3 })) as number;
}

const RETRY_LATER = Symbol("retry later");

/**
 * With `deferTransient`, a transient failure (network error, timeout, 429, 5xx) records nothing
 * and returns RETRY_LATER, so refreshAll can retry it after the other feeds. `priorAttempts`
 * counts those earlier attempts in the log.
 */
async function fetchFeed(
  feed: FeedRow,
  { attempts, deferTransient = false, priorAttempts = 0 }: { attempts: number; deferTransient?: boolean; priorAttempts?: number },
): Promise<number | typeof RETRY_LATER> {
  const db = getDb();
  const log = { startedAt: Date.now(), status: null as number | null, attempts: priorAttempts + 1 };
  try {
    const res = await fetchTextWithRetry(
      feed.feed_url,
      { etag: feed.etag, lastModified: feed.last_modified },
      { attempts, onRetry: () => log.attempts++ },
    );
    log.status = res.status;
    if (deferTransient && isTransientStatus(res.status)) return RETRY_LATER;
    if (res.status === 304) {
      db.prepare("UPDATE feeds SET last_fetched_at = ?, last_error = NULL WHERE id = ?").run(Date.now(), feed.id);
      logFetch(feed.id, { ...log, newArticles: 0, error: null });
      return 0;
    }
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    // Rules only fire for feeds that already had articles, so a new feed's backlog never triggers them.
    const hadArticles = !!getDb().prepare("SELECT 1 FROM articles WHERE feed_id = ? LIMIT 1").get(feed.id);
    const { added, ids, title, siteUrl } = await storeItems(feed, res.text);
    let icon = feed.icon_url;
    if (!feed.icon_checked) icon = await resolveIcon(siteUrl);
    db.prepare(
      `UPDATE feeds SET etag = ?, last_modified = ?, last_fetched_at = ?, last_error = NULL, site_url = COALESCE(?, site_url),
       icon_url = ?, icon_checked = 1, title = CASE WHEN title = feed_url AND ? IS NOT NULL THEN ? ELSE title END WHERE id = ?`,
    ).run(res.etag, res.lastModified, Date.now(), siteUrl ?? null, icon, title ?? null, title ?? null, feed.id);
    if (hadArticles && ids.length) {
      // Delivery problems are logged on the rule, never recorded as a feed error.
      await runRulesForNewArticles(feed, ids).catch((e) => console.error("[stitch] rules failed", e));
    }
    logFetch(feed.id, { ...log, newArticles: added, error: null });
    return added;
  } catch (e) {
    // Only fetch errors are deferred (no response yet); parse and storage errors are final.
    if (deferTransient && log.status === null && isTransientError(e)) return RETRY_LATER;
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    db.prepare("UPDATE feeds SET last_fetched_at = ?, last_error = ? WHERE id = ?").run(Date.now(), msg, feed.id);
    // The feed may have been unfollowed while it was being fetched.
    try {
      logFetch(feed.id, { ...log, newArticles: 0, error: msg });
    } catch {}
    return 0;
  }
}

const g = globalThis as unknown as { __refreshing?: Promise<number> };

/** Run `fn` over `items`, at most `limit` at a time. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Refresh every feed with limited concurrency. Concurrent callers share one run. Feeds that fail
 * transiently are retried after all the others, so a slow or flaky server never holds up the rest.
 */
export function refreshAll(): Promise<number> {
  if (g.__refreshing) return g.__refreshing;
  g.__refreshing = (async () => {
    const feeds = getDb().prepare("SELECT * FROM feeds").all() as FeedRow[];
    let total = 0;
    const retry: FeedRow[] = [];
    await pool(feeds, 6, async (f) => {
      const r = await fetchFeed(f, { attempts: 1, deferTransient: true });
      if (r === RETRY_LATER) retry.push(f);
      else total += r;
    });
    if (retry.length) {
      await sleep(2000);
      await pool(retry, 6, async (f) => {
        total += (await fetchFeed(f, { attempts: 2, priorAttempts: 1 })) as number;
      });
    }
    purgeOld();
    purgeRuleMatches();
    purgeFetchLog();
    return total;
  })().finally(() => {
    g.__refreshing = undefined;
  });
  return g.__refreshing;
}

export function isRefreshing() {
  return !!g.__refreshing;
}

// Rules and filters keep their target feed or folder inside the JSON definition, so no foreign key
// removes them with it (and ids can be reused, which would attach them to a new feed or folder).
type Target = "feedId" | "folderId";
const inList = (ids: number[]) => `IN (${ids.map(() => "?").join(",")})`;
const rulesFor = (t: Target, ids: number[]) => `FROM rules WHERE json_extract(definition, '$.trigger.${t}') ${inList(ids)}`;
const filtersFor = (t: Target, ids: number[]) => `FROM filters WHERE json_extract(definition, '$.target.${t}') ${inList(ids)}`;

function linkedAutomations(t: Target, ids: number[]): LinkedAutomations {
  if (!ids.length) return { rules: [], filters: 0 };
  const db = getDb();
  return {
    rules: db.prepare(`SELECT id, name ${rulesFor(t, ids)} ORDER BY position, id`).all(...ids) as LinkedAutomations["rules"],
    filters: (db.prepare(`SELECT COUNT(*) AS n ${filtersFor(t, ids)}`).get(...ids) as { n: number }).n,
  };
}

function deleteLinkedAutomations(t: Target, ids: number[]) {
  if (!ids.length) return;
  const db = getDb();
  db.prepare(`DELETE ${rulesFor(t, ids)}`).run(...ids);
  db.prepare(`DELETE ${filtersFor(t, ids)}`).run(...ids);
}

const folderFeedIds = (folderId: number) =>
  (getDb().prepare("SELECT id FROM feeds WHERE folder_id = ?").all(folderId) as { id: number }[]).map((r) => r.id);

export function feedAutomations(feedId: number): LinkedAutomations {
  return linkedAutomations("feedId", [feedId]);
}

export function folderAutomations(folderId: number): FolderAutomations {
  return { folder: linkedAutomations("folderId", [folderId]), feeds: linkedAutomations("feedId", folderFeedIds(folderId)) };
}

/** Unfollow a feed: deletes it with its articles and the rules and filters that target it. */
export function deleteFeed(feedId: number) {
  const db = getDb();
  db.transaction(() => {
    deleteLinkedAutomations("feedId", [feedId]);
    db.prepare("DELETE FROM feeds WHERE id = ?").run(feedId);
  })();
}

/**
 * Delete a folder and the rules and filters that target it. Its feeds either move to the top level
 * or are deleted too (with their articles, rules and filters).
 */
export function deleteFolder(folderId: number, deleteFeeds: boolean) {
  const db = getDb();
  db.transaction(() => {
    deleteLinkedAutomations("folderId", [folderId]);
    if (deleteFeeds) {
      deleteLinkedAutomations("feedId", folderFeedIds(folderId));
      db.prepare("DELETE FROM feeds WHERE folder_id = ?").run(folderId);
    }
    db.prepare("DELETE FROM folders WHERE id = ?").run(folderId);
  })();
  // A removed folder filter may have been the only thing hiding articles in the kept feeds.
  reapplyFilters();
}

/** Publish-date cutoff for retention, or null when articles are kept forever. YouTube feeds have their own setting. */
function retentionCutoff(youtube = false): number | null {
  const s = getSettings();
  const days = youtube ? s.youtubeRetentionDays : s.retentionDays;
  return days && days > 0 ? Date.now() - days * 86400000 : null;
}

/**
 * Delete read articles older than the retention window, unless they're saved, archived or tagged.
 * YouTube feeds use their own window.
 */
export function purgeOld() {
  const purge = (cutoff: number | null, youtube: boolean) => {
    if (!cutoff) return;
    getDb()
      .prepare(
        `DELETE FROM articles WHERE is_read = 1 AND is_saved = 0 AND published_at < ?
           AND archived_at IS NULL AND id NOT IN (SELECT article_id FROM article_tags)
           AND feed_id ${youtube ? "IN" : "NOT IN"} (SELECT id FROM feeds WHERE feed_url LIKE ?)`,
      )
      .run(cutoff, YOUTUBE_FEED_LIKE);
  };
  purge(retentionCutoff(), false);
  purge(retentionCutoff(true), true);
}

// Register the newest refreshAll for the background scheduler. In `next dev` the scheduler keeps
// the module graph it started with, while route handlers load fresh copies of this file after
// every edit; each copy overwrites this, so scheduled refreshes always run current code.
(globalThis as unknown as { __stitchRefreshAll?: () => Promise<number> }).__stitchRefreshAll = refreshAll;
