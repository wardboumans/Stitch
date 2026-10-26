import { getDb, ID_INDEX } from "./db";
import { feedAutomations, isRefreshing } from "./feeds";
import {
  buildFtsQuery,
  getMonitor,
  listMonitors,
  queryWhere,
} from "./monitors";
import { toFtsQuery } from "./search";
import { getSettings } from "./settings";
import { articleTags, listTags } from "./tags";
import type {
  ArticleDetail,
  ArticleListItem,
  ArticlePage,
  FeedProperties,
  MonitorPreview,
  NewArticlesCheck,
  MonitorQuery,
  Scope,
  Sidebar,
  SidebarFeed,
  SidebarFolder,
} from "./types";

/** `byId`: the clause selects articles by id (FTS matches, tags), so it goes through ID_INDEX. */
type Where = { sql: string; params: unknown[]; byId?: boolean };

export function parseScope(
  params: URLSearchParams | Record<string, unknown>,
): Scope | null {
  const get = (k: string) =>
    params instanceof URLSearchParams
      ? params.get(k)
      : ((params[k] as string | undefined) ?? null);
  const kind = get("scope") ?? "all";
  const id = Number(get("id"));
  switch (kind) {
    case "all":
    case "saved":
    case "archive":
    case "tagged":
      return { kind };
    case "feed":
    case "folder":
    case "monitor":
    case "tag":
      return Number.isInteger(id) && id > 0 ? { kind, id } : null;
    case "search": {
      const q = String(get("q") ?? "").trim();
      return q ? { kind, q } : null;
    }
  }
  return null;
}

export function getSidebar(): Sidebar {
  const db = getDb();
  const counts = new Map(
    (
      db
        .prepare(
          "SELECT feed_id, COUNT(*) AS n FROM articles WHERE is_read = 0 AND filtered = 0 GROUP BY feed_id",
        )
        .all() as { feed_id: number; n: number }[]
    ).map((r) => [r.feed_id, r.n]),
  );
  const feeds: SidebarFeed[] = (
    db
      .prepare(
        "SELECT id, folder_id, title, feed_url, site_url, icon_url, last_error, last_fetched_at FROM feeds ORDER BY position, title COLLATE NOCASE",
      )
      .all() as {
      id: number;
      folder_id: number | null;
      title: string;
      feed_url: string;
      site_url: string | null;
      icon_url: string | null;
      last_error: string | null;
      last_fetched_at: number | null;
    }[]
  ).map((f) => ({
    id: f.id,
    folderId: f.folder_id,
    title: f.title,
    feedUrl: f.feed_url,
    siteUrl: f.site_url,
    iconUrl: f.icon_url,
    unread: counts.get(f.id) ?? 0,
    lastError: f.last_error,
    lastFetchedAt: f.last_fetched_at,
  }));

  const folders: SidebarFolder[] = (
    db
      .prepare(
        "SELECT id, name, collapsed, feed_token FROM folders ORDER BY position, name COLLATE NOCASE",
      )
      .all() as {
        id: number;
        name: string;
        collapsed: number;
        feed_token: string | null;
      }[]
  ).map((f) => {
    const own = feeds.filter((x) => x.folderId === f.id);
    return {
      id: f.id,
      name: f.name,
      collapsed: !!f.collapsed,
      feedToken: f.feed_token,
      feeds: own,
      unread: own.reduce((s, x) => s + x.unread, 0),
    };
  });

  const monitors = listMonitors().map((m) => {
    const where = queryWhere(m.query, m.folderId);
    return { id: m.id, name: m.name, unread: countWhere(where, true) };
  });

  return {
    monitors,
    tags: listTags(),
    folders,
    unfiled: feeds.filter((f) => f.folderId === null),
    totalUnread: feeds.reduce((s, f) => s + f.unread, 0),
    savedCount: (
      db
        .prepare("SELECT COUNT(*) AS n FROM articles WHERE is_saved = 1")
        .get() as { n: number }
    ).n,
    archivedCount: (
      db
        .prepare("SELECT COUNT(*) AS n FROM articles WHERE archived_at IS NOT NULL AND filtered = 0")
        .get() as { n: number }
    ).n,
    refreshing: isRefreshing(),
  };
}

/** Details, article stats and the refresh log of one feed, or null if it doesn't exist. */
export function feedProperties(id: number): FeedProperties | null {
  const db = getDb();
  const f = db
    .prepare(
      "SELECT id, folder_id, title, feed_url, site_url, icon_url, created_at, last_fetched_at, last_error FROM feeds WHERE id = ?",
    )
    .get(id) as
    | {
        id: number;
        folder_id: number | null;
        title: string;
        feed_url: string;
        site_url: string | null;
        icon_url: string | null;
        created_at: number;
        last_fetched_at: number | null;
        last_error: string | null;
      }
    | undefined;
  if (!f) return null;

  const where = scopeWhere({ kind: "feed", id });
  const stats = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(a.is_read = 0), 0) AS unread, COALESCE(SUM(a.published_at >= ?), 0) AS week,
              MAX(a.published_at) AS last
       FROM articles a JOIN feeds f ON f.id = a.feed_id WHERE ${where.sql}`,
    )
    .get(Date.now() - 7 * 86400000, ...where.params) as { n: number; unread: number; week: number; last: number | null };

  const log = (
    db
      .prepare(
        "SELECT id, fetched_at, duration_ms, status, attempts, new_articles, error FROM feed_fetches WHERE feed_id = ? ORDER BY id DESC LIMIT 100",
      )
      .all(id) as {
      id: number;
      fetched_at: number;
      duration_ms: number;
      status: number | null;
      attempts: number;
      new_articles: number;
      error: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    fetchedAt: r.fetched_at,
    durationMs: r.duration_ms,
    status: r.status,
    attempts: r.attempts,
    newArticles: r.new_articles,
    error: r.error,
  }));

  return {
    id: f.id,
    title: f.title,
    feedUrl: f.feed_url,
    siteUrl: f.site_url,
    iconUrl: f.icon_url,
    folderId: f.folder_id,
    createdAt: f.created_at,
    lastFetchedAt: f.last_fetched_at,
    lastError: f.last_error,
    articles: stats.n,
    unread: stats.unread,
    postsThisWeek: stats.week,
    lastPostAt: stats.last,
    // Same clamp as the scheduler (lib/scheduler.ts).
    refreshIntervalMinutes: Math.max(5, getSettings().refreshIntervalMinutes || 30),
    automations: feedAutomations(id),
    log,
  };
}

const articlesFrom = (where: Where) => `articles a ${where.byId ? `${ID_INDEX} ` : ""}JOIN feeds f ON f.id = a.feed_id`;

function countWhere(where: Where, unreadOnly: boolean): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM ${articlesFrom(where)} WHERE ${where.sql}${unreadOnly ? " AND a.is_read = 0" : ""}`,
      )
      .get(...where.params) as { n: number }
  ).n;
}

/**
 * One page of list rows. Id-selected scopes pick the page's ids through the covering index first,
 * so only the rows on the page are read, not every match.
 */
function selectRows(where: Where, order: string, limit: number): ListRow[] {
  const sql = where.byId
    ? `SELECT ${LIST_COLUMNS} FROM articles a JOIN feeds f ON f.id = a.feed_id WHERE a.id IN (
         SELECT a.id FROM ${articlesFrom(where)} WHERE ${where.sql} ORDER BY ${order} LIMIT ?
       ) ORDER BY ${order}`
    : `SELECT ${LIST_COLUMNS} FROM ${articlesFrom(where)} WHERE ${where.sql} ORDER BY ${order} LIMIT ?`;
  return getDb().prepare(sql).all(...where.params, limit) as ListRow[];
}

/** WHERE clause + params selecting the visible (not filtered) articles in a scope. */
export function scopeWhere(scope: Scope): Where {
  const w = scopeWhereRaw(scope);
  return { sql: `(${w.sql}) AND a.filtered = 0`, params: w.params, byId: w.byId };
}

function scopeWhereRaw(scope: Scope): Where {
  switch (scope.kind) {
    case "all":
      return { sql: "1 = 1", params: [] };
    case "saved":
      return { sql: "a.is_saved = 1", params: [] };
    case "archive":
      return { sql: "a.archived_at IS NOT NULL", params: [] };
    case "tagged":
      return { sql: "a.id IN (SELECT article_id FROM article_tags)", params: [], byId: true };
    case "tag":
      return {
        sql: "a.id IN (SELECT article_id FROM article_tags WHERE tag_id = ?)",
        params: [scope.id],
        byId: true,
      };
    case "feed":
      return { sql: "a.feed_id = ?", params: [scope.id] };
    case "folder":
      return { sql: "f.folder_id = ?", params: [scope.id] };
    case "monitor": {
      const m = getMonitor(scope.id);
      return m ? queryWhere(m.query, m.folderId) : { sql: "0", params: [] };
    }
    case "search": {
      const q = toFtsQuery(scope.q);
      return q
        ? {
            sql: "a.id IN (SELECT rowid FROM articles_fts WHERE articles_fts MATCH ?)",
            params: [q],
            byId: true,
          }
        : { sql: "0", params: [] };
    }
  }
}

const LIST_COLUMNS = `
  a.id, a.feed_id, f.title AS feed_title, f.icon_url AS feed_icon, a.title, a.url, a.author,
  substr(a.excerpt, 1, 240) AS excerpt, a.image_url, a.published_at, a.is_read, a.is_saved, a.saved_at, a.archived_at`;

type ListRow = {
  id: number;
  feed_id: number;
  feed_title: string;
  feed_icon: string | null;
  title: string;
  url: string | null;
  author: string | null;
  excerpt: string | null;
  image_url: string | null;
  published_at: number;
  is_read: number;
  is_saved: number;
  saved_at: number | null;
  archived_at: number | null;
};

function toItem(r: ListRow): ArticleListItem {
  return {
    id: r.id,
    feedId: r.feed_id,
    feedTitle: r.feed_title,
    feedIcon: r.feed_icon,
    title: r.title,
    url: r.url,
    author: r.author,
    excerpt: r.excerpt ?? "",
    imageUrl: r.image_url,
    publishedAt: r.published_at,
    isRead: !!r.is_read,
    isSaved: !!r.is_saved,
    isArchived: r.archived_at !== null,
  };
}

export function listArticles(
  scope: Scope,
  opts: {
    unreadOnly: boolean;
    oldestFirst: boolean;
    cursor?: string | null;
    limit?: number;
  },
): ArticlePage {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 40, 100);
  const where = scopeWhere(scope);
  // Saved and archived items are ordered by when they were saved or archived; everything else by publish date.
  const key =
    scope.kind === "saved"
      ? "a.saved_at"
      : scope.kind === "archive"
        ? "a.archived_at"
        : "a.published_at";
  const dir = opts.oldestFirst ? "ASC" : "DESC";
  const cmp = opts.oldestFirst ? ">" : "<";

  const clauses = [where.sql];
  const params = [...where.params];
  if (opts.unreadOnly) clauses.push("a.is_read = 0");
  if (opts.cursor) {
    const [k, id] = opts.cursor.split(":").map(Number);
    clauses.push(`(${key} ${cmp} ? OR (${key} = ? AND a.id ${cmp} ?))`);
    params.push(k, k, id);
  }

  const rows = selectRows(
    { sql: clauses.join(" AND "), params, byId: where.byId },
    `${key} ${dir}, a.id ${dir}`,
    limit + 1,
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const lastKey = last
    ? scope.kind === "saved"
      ? (last.saved_at ?? 0)
      : scope.kind === "archive"
        ? (last.archived_at ?? 0)
        : last.published_at
    : 0;

  const highWater = (
    db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM articles").get() as {
      m: number;
    }
  ).m;
  return {
    items: page.map(toItem),
    nextCursor: hasMore && last ? `${lastKey}:${last.id}` : null,
    // Further pages keep the count from the first; the new-articles check keeps it current.
    unread: opts.cursor ? null : countWhere(where, true),
    highWater,
  };
}

/**
 * How many articles in a scope arrived after the list was loaded (ids are assigned in insert
 * order), plus the scope's current unread count, for the "new articles" button.
 */
export function checkNewArticles(
  scope: Scope,
  afterId: number,
  unreadOnly: boolean,
): NewArticlesCheck {
  const where = scopeWhere(scope);
  const fresh = {
    sql: `${where.sql} AND a.id > ?${unreadOnly ? " AND a.is_read = 0" : ""}`,
    params: [...where.params, afterId],
  };
  return {
    newCount: countWhere(fresh, false),
    unread: countWhere(where, true),
  };
}

/** Live preview for the monitoring-feed editor: total matches and the newest few. */
export function previewQuery(
  query: MonitorQuery,
  folderId: number | null,
): MonitorPreview {
  const where = queryWhere(query, folderId);
  const rows = selectRows(where, "a.published_at DESC, a.id DESC", 20);
  return {
    count: countWhere(where, false),
    items: rows.map(toItem),
    fts: buildFtsQuery(query),
  };
}

export function getArticle(id: number): ArticleDetail | null {
  const r = getDb()
    .prepare(
      `SELECT ${LIST_COLUMNS}, f.site_url, a.content, a.full_content, a.summary
       FROM articles a JOIN feeds f ON f.id = a.feed_id WHERE a.id = ?`,
    )
    .get(id) as
    | (ListRow & {
        site_url: string | null;
        content: string | null;
        full_content: string | null;
        summary: string | null;
      })
    | undefined;
  if (!r) return null;
  const content = r.content ?? "";
  return {
    ...toItem(r),
    siteUrl: r.site_url,
    content,
    fullContent: r.full_content,
    summary: r.summary,
    contentLength: content.replace(/<[^>]+>/g, "").length,
    tags: articleTags(r.id),
  };
}

/** Archiving moves an article out of Read later; it then stays in the archive (kept forever) until removed. */
export function setArticleState(
  id: number,
  patch: { isRead?: boolean; isSaved?: boolean; isArchived?: boolean },
) {
  const db = getDb();
  const now = Date.now();
  if (patch.isRead !== undefined)
    db.prepare("UPDATE articles SET is_read = ?, read_at = ? WHERE id = ?").run(
      patch.isRead ? 1 : 0,
      patch.isRead ? now : null,
      id,
    );
  if (patch.isSaved !== undefined)
    db.prepare(
      "UPDATE articles SET is_saved = ?, saved_at = ? WHERE id = ?",
    ).run(patch.isSaved ? 1 : 0, patch.isSaved ? now : null, id);
  if (patch.isArchived === true)
    db.prepare(
      "UPDATE articles SET archived_at = COALESCE(archived_at, ?), is_saved = 0, saved_at = NULL WHERE id = ?",
    ).run(now, id);
  else if (patch.isArchived === false)
    db.prepare("UPDATE articles SET archived_at = NULL WHERE id = ?").run(id);
}

/**
 * Mark everything in a scope read. `maxId` bounds it to articles the client had already
 * loaded, so items that arrived meanwhile stay unread. `olderThanMs` limits to older items.
 */
export function markScopeRead(
  scope: Scope,
  opts: { maxId?: number; olderThanMs?: number },
): number {
  const where = scopeWhere(scope);
  const clauses = [where.sql, "a.is_read = 0"];
  const params = [...where.params];
  if (opts.maxId) {
    clauses.push("a.id <= ?");
    params.push(opts.maxId);
  }
  if (opts.olderThanMs) {
    clauses.push("a.published_at < ?");
    params.push(Date.now() - opts.olderThanMs);
  }
  return getDb()
    .prepare(
      `UPDATE articles SET is_read = 1, read_at = ? WHERE id IN (SELECT a.id FROM articles a JOIN feeds f ON f.id = a.feed_id WHERE ${clauses.join(" AND ")})`,
    )
    .run(Date.now(), ...params).changes;
}
