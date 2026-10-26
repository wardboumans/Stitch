import crypto from "node:crypto";
import { getDb } from "./db";

/**
 * Public "output feeds" for tags and folders, at /feeds/<kind>/<token><ext> without logging in;
 * the random token is the only access control. The extension picks the format: none or .xml for
 * RSS 2.0, .json for JSON Feed 1.1, .opml for OPML (a folder's feed subscriptions, or a tag's
 * articles as links).
 */
export type OutputFeedKind = "tag" | "folder";
export type OutputFeedFormat = "rss" | "json" | "opml";

export const newFeedToken = () => crypto.randomBytes(18).toString("base64url");

const EXT: Record<OutputFeedFormat, string> = { rss: "", json: ".json", opml: ".opml" };

const xml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!)
    // Control characters other than tab/newline are invalid in XML 1.0.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

type FeedRow = {
  id: number;
  title: string;
  url: string | null;
  author: string | null;
  excerpt: string | null;
  content: string | null;
  published_at: number;
  feed_title: string;
};

type Source = {
  title: string;
  description: string;
  rows: FeedRow[];
  /** Folder only: the folder's feeds, for OPML. */
  feeds?: { title: string; feed_url: string; site_url: string | null }[];
};

const ROW_SQL = `SELECT a.id, a.title, a.url, a.author, a.excerpt, COALESCE(a.full_content, a.content) AS content, a.published_at, f.title AS feed_title`;

function load(kind: OutputFeedKind, token: string): Source | null {
  const db = getDb();
  if (kind === "tag") {
    const tag = db.prepare("SELECT id, name FROM tags WHERE feed_token = ?").get(token) as { id: number; name: string } | undefined;
    if (!tag) return null;
    const rows = db
      .prepare(
        `${ROW_SQL} FROM article_tags at JOIN articles a ON a.id = at.article_id JOIN feeds f ON f.id = a.feed_id
         WHERE at.tag_id = ? AND a.filtered = 0 ORDER BY at.created_at DESC, a.id DESC LIMIT 50`,
      )
      .all(tag.id) as FeedRow[];
    return { title: tag.name, description: `Articles tagged “${tag.name}” in Stitch`, rows };
  }
  const folder = db.prepare("SELECT id, name FROM folders WHERE feed_token = ?").get(token) as { id: number; name: string } | undefined;
  if (!folder) return null;
  const rows = db
    .prepare(
      `${ROW_SQL} FROM articles a JOIN feeds f ON f.id = a.feed_id
       WHERE f.folder_id = ? AND a.filtered = 0 ORDER BY a.published_at DESC, a.id DESC LIMIT 50`,
    )
    .all(folder.id) as FeedRow[];
  const feeds = db
    .prepare("SELECT title, feed_url, site_url FROM feeds WHERE folder_id = ? ORDER BY position, title COLLATE NOCASE")
    .all(folder.id) as Source["feeds"];
  return { title: folder.name, description: `Articles from the “${folder.name}” folder in Stitch`, rows, feeds };
}

function rss(src: Source, self: string, origin: string): string {
  const items = src.rows
    .map(
      (r) => `    <item>
      <title>${xml(r.title)}</title>
${r.url ? `      <link>${xml(r.url)}</link>\n` : ""}      <guid isPermaLink="${r.url ? "true" : "false"}">${xml(r.url ?? `stitch-article-${r.id}`)}</guid>
      <pubDate>${new Date(r.published_at).toUTCString()}</pubDate>
${r.author ? `      <dc:creator>${xml(r.author)}</dc:creator>\n` : ""}      <source url="${xml(self)}">${xml(r.feed_title)}</source>
      <description>${xml(r.content || r.excerpt || "")}</description>
    </item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${xml(src.title)}</title>
    <link>${xml(origin)}</link>
    <description>${xml(src.description)}</description>
    <atom:link href="${xml(self)}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

function jsonFeed(src: Source, self: string, origin: string): string {
  return JSON.stringify(
    {
      version: "https://jsonfeed.org/version/1.1",
      title: src.title,
      description: src.description,
      home_page_url: origin,
      feed_url: self,
      items: src.rows.map((r) => ({
        id: r.url ?? `stitch-article-${r.id}`,
        ...(r.url ? { url: r.url } : {}),
        title: r.title,
        content_html: r.content || r.excerpt || "",
        ...(r.excerpt ? { summary: r.excerpt } : {}),
        date_published: new Date(r.published_at).toISOString(),
        ...(r.author ? { authors: [{ name: r.author }] } : {}),
        _stitch: { source: r.feed_title },
      })),
    },
    null,
    2,
  );
}

/** A folder's OPML lists its feeds (to subscribe elsewhere); a tag's lists its articles as links. */
function opml(src: Source): string {
  const outlines = src.feeds
    ? src.feeds.map(
        (f) =>
          `      <outline type="rss" text="${xml(f.title)}" title="${xml(f.title)}" xmlUrl="${xml(f.feed_url)}"${
            f.site_url ? ` htmlUrl="${xml(f.site_url)}"` : ""
          }/>`,
      )
    : src.rows
        .filter((r) => r.url)
        .map(
          (r) =>
            `      <outline type="link" text="${xml(r.title)}" url="${xml(r.url!)}" created="${new Date(r.published_at).toUTCString()}"/>`,
        );
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${xml(src.title)}</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
    <outline text="${xml(src.title)}" title="${xml(src.title)}">
${outlines.join("\n")}
    </outline>
  </body>
</opml>
`;
}

/**
 * Render an output feed, or null for an unknown token. XML is served as application/xml rather
 * than application/rss+xml so browsers show it instead of downloading it; readers sniff the content.
 */
export function renderOutputFeed(
  kind: OutputFeedKind,
  token: string,
  format: OutputFeedFormat,
  origin: string,
): { body: string; contentType: string } | null {
  const src = load(kind, token);
  if (!src) return null;
  const self = `${origin}/feeds/${kind}/${token}${EXT[format]}`;
  if (format === "json") return { body: jsonFeed(src, self, origin), contentType: "application/json; charset=utf-8" };
  return { body: format === "opml" ? opml(src) : rss(src, self, origin), contentType: "application/xml; charset=utf-8" };
}

/** Turn a folder's output feed on (keeping an existing link), off, or give it a new link. */
export function setFolderOutputFeed(folderId: number, patch: { outputFeed?: boolean; regenerateToken?: boolean }) {
  const db = getDb();
  if (patch.outputFeed === false) db.prepare("UPDATE folders SET feed_token = NULL WHERE id = ?").run(folderId);
  else if (patch.regenerateToken) db.prepare("UPDATE folders SET feed_token = ? WHERE id = ?").run(newFeedToken(), folderId);
  else if (patch.outputFeed)
    db.prepare("UPDATE folders SET feed_token = ? WHERE id = ? AND feed_token IS NULL").run(newFeedToken(), folderId);
}
