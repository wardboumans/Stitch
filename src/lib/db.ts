import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * Version 1: the baseline schema. Never edit it — databases created before migrations existed are
 * at this version (user_version 0 or 1). Schema changes go in MIGRATIONS below.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  collapsed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS feeds (
  id INTEGER PRIMARY KEY,
  folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  feed_url TEXT NOT NULL UNIQUE,
  site_url TEXT,
  icon_url TEXT,
  icon_checked INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  etag TEXT,
  last_modified TEXT,
  last_fetched_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY,
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  url TEXT,
  title TEXT NOT NULL,
  author TEXT,
  content TEXT,
  excerpt TEXT,
  image_url TEXT,
  published_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  read_at INTEGER,
  is_saved INTEGER NOT NULL DEFAULT 0,
  -- Hidden by a filter (see lib/filters.ts). Recomputed whenever filters change.
  filtered INTEGER NOT NULL DEFAULT 0,
  saved_at INTEGER,
  full_content TEXT,
  summary TEXT,
  UNIQUE (feed_id, guid)
);

CREATE INDEX IF NOT EXISTS idx_articles_feed_read ON articles(feed_id, is_read);
CREATE INDEX IF NOT EXISTS idx_articles_feed_unread ON articles(feed_id, is_read, filtered);
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at, id);
CREATE INDEX IF NOT EXISTS idx_articles_saved ON articles(is_saved, saved_at);

-- Contentless FTS index holding plain text; rows are written from app code (see lib/search.ts).
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  title, body,
  content = '', contentless_delete = 1,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS articles_fts_delete AFTER DELETE ON articles BEGIN
  DELETE FROM articles_fts WHERE rowid = old.id;
END;

-- Monitoring feeds: saved keyword queries over all articles (or one folder). query is MonitorQuery JSON.
CREATE TABLE IF NOT EXISTS monitors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Automation rules. definition is RuleDefinition JSON (trigger, conditions, actions).
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  definition TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- One row per article a rule fired on. The title is copied so the log survives article retention.
CREATE TABLE IF NOT EXISTS rule_matches (
  id INTEGER PRIMARY KEY,
  rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  article_id INTEGER REFERENCES articles(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  matched_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_rule_matches_rule ON rule_matches(rule_id, matched_at);

-- Filters hide articles (mode "remove") or hide everything else (mode "keep"). definition is FilterDefinition JSON.
CREATE TABLE IF NOT EXISTS filters (
  id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  definition TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function open(): Database.Database {
  const file = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "reader.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

/**
 * Versioned schema changes on top of the baseline, tracked in PRAGMA user_version. Each runs once,
 * in a transaction, in order. Append new ones; never edit or reorder a released migration.
 */
const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 2,
    sql: `
-- Tags for organizing articles (lib/tags.ts). feed_token is set while the tag's public RSS output feed is on.
CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  pinned INTEGER NOT NULL DEFAULT 1,
  feed_token TEXT UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE article_tags (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (article_id, tag_id)
) WITHOUT ROWID;
CREATE INDEX idx_article_tags_tag ON article_tags(tag_id, created_at);

-- Archived articles are kept forever: retention never purges them.
ALTER TABLE articles ADD COLUMN archived_at INTEGER;
CREATE INDEX idx_articles_archived ON articles(archived_at) WHERE archived_at IS NOT NULL;
`,
  },
  {
    version: 3,
    sql: `
-- Tag pinning was dropped: every tag is listed in the sidebar.
ALTER TABLE tags DROP COLUMN pinned;
`,
  },
  {
    version: 4,
    sql: `
-- Set while the folder's public RSS output feed is on (lib/outputFeeds.ts).
ALTER TABLE folders ADD COLUMN feed_token TEXT;
CREATE UNIQUE INDEX idx_folders_feed_token ON folders(feed_token) WHERE feed_token IS NOT NULL;
`,
  },
  {
    version: 5,
    sql: `
-- Refresh log: one row per fetch of a feed (lib/feeds.ts). status is the HTTP status, NULL when
-- no response arrived (network error, timeout). error is NULL on success. Trimmed per feed.
CREATE TABLE feed_fetches (
  id INTEGER PRIMARY KEY,
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  fetched_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  status INTEGER,
  attempts INTEGER NOT NULL DEFAULT 1,
  new_articles INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX idx_feed_fetches_feed ON feed_fetches(feed_id, fetched_at);
`,
  },
  {
    version: 6,
    sql: `
-- Covers the columns that id lookups (FTS matches, tags) filter and sort on, so counting or paging
-- them doesn't read whole article rows. SQLite prefers the rowid for those, so queries name it
-- with INDEXED BY (ID_INDEX).
CREATE INDEX idx_articles_state ON articles(id, feed_id, is_read, filtered, published_at);
`,
  },
];

/** Index for queries that select articles by id (`a.id IN (...)`); see migration 6. */
export const ID_INDEX = "INDEXED BY idx_articles_state";

const BASELINE_VERSION = 1;
export const SCHEMA_VERSION = MIGRATIONS.reduce((v, m) => Math.max(v, m.version), BASELINE_VERSION);

function migrate(db: Database.Database) {
  db.exec(SCHEMA);
  let current = db.pragma("user_version", { simple: true }) as number;
  if (current < BASELINE_VERSION) db.pragma(`user_version = ${(current = BASELINE_VERSION)}`);
  if (current > SCHEMA_VERSION)
    throw new Error(`Database schema version ${current} is newer than this build supports (${SCHEMA_VERSION}); upgrade Stitch.`);
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
    console.log(`[stitch] migrated database to schema version ${m.version}`);
  }
}

const g = globalThis as unknown as { __readerDb?: Database.Database; __readerSchemaVersion?: number };

export function getDb(): Database.Database {
  if (!g.__readerDb) g.__readerDb = open();
  // The connection outlives dev hot reloads, so migrate again when a newer migration appears. Only
  // upward: a stale module copy from before the reload (e.g. the scheduler's) must not re-check.
  if ((g.__readerSchemaVersion ?? 0) < SCHEMA_VERSION) {
    migrate(g.__readerDb);
    g.__readerSchemaVersion = SCHEMA_VERSION;
  }
  return g.__readerDb;
}
