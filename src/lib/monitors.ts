import { getDb } from "./db";
import type { Monitor, MonitorQuery, MonitorTerm } from "./types";

type MonitorRow = { id: number; name: string; query: string; folder_id: number | null };

/** Turn one term into an FTS5 phrase. Only word characters survive, so user input can't break the syntax. */
function phrase(t: MonitorTerm): string | null {
  const words = t.text.match(/[\p{L}\p{N}]+/gu);
  if (!words) return null;
  const p = `"${words.join(" ")}"`;
  return t.titleOnly ? `title : ${p}` : p;
}

function orGroup(terms: MonitorTerm[]): string | null {
  const parts = terms.map(phrase).filter((p): p is string => !!p);
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
}

/** Build the FTS5 MATCH expression for a query, or null if it has no usable positive terms. */
export function buildFtsQuery(q: MonitorQuery): string | null {
  const positive = q.groups.map(orGroup).filter((g): g is string => !!g);
  if (!positive.length) return null;
  const negative = orGroup(q.exclude);
  const expr = positive.join(" AND ");
  return negative ? `(${expr}) NOT ${negative}` : expr;
}

/** Validate and normalise untrusted query JSON from the client. */
export function normalizeQuery(input: unknown): MonitorQuery {
  const term = (t: unknown): MonitorTerm | null => {
    if (!t || typeof t !== "object") return null;
    const text = String((t as MonitorTerm).text ?? "").trim().slice(0, 200);
    return text ? { text, ...((t as MonitorTerm).titleOnly ? { titleOnly: true } : {}) } : null;
  };
  const list = (v: unknown) => (Array.isArray(v) ? v.map(term).filter((t): t is MonitorTerm => !!t) : []);
  const q = (input ?? {}) as Partial<MonitorQuery>;
  return {
    groups: (Array.isArray(q.groups) ? q.groups.map(list) : []).filter((g) => g.length),
    exclude: list(q.exclude),
  };
}

/**
 * WHERE clause (over `articles a JOIN feeds f`) selecting the articles a query matches. `byId` marks
 * clauses that pick articles by id, which count much faster through ID_INDEX (lib/db.ts).
 */
export function queryWhere(q: MonitorQuery, folderId: number | null): { sql: string; params: unknown[]; byId?: boolean } {
  const fts = buildFtsQuery(q);
  if (!fts) return { sql: "0", params: [] };
  const sql = "a.filtered = 0 AND a.id IN (SELECT rowid FROM articles_fts WHERE articles_fts MATCH ?)";
  return folderId ? { sql: `${sql} AND f.folder_id = ?`, params: [fts, folderId], byId: true } : { sql, params: [fts], byId: true };
}

function toMonitor(r: MonitorRow): Monitor {
  let query: MonitorQuery = { groups: [], exclude: [] };
  try {
    query = normalizeQuery(JSON.parse(r.query));
  } catch {
    // keep the empty query; the monitor simply matches nothing
  }
  return { id: r.id, name: r.name, query, folderId: r.folder_id };
}

export function listMonitors(): Monitor[] {
  return (getDb().prepare("SELECT id, name, query, folder_id FROM monitors ORDER BY position, name COLLATE NOCASE").all() as MonitorRow[]).map(
    toMonitor,
  );
}

export function getMonitor(id: number): Monitor | null {
  const r = getDb().prepare("SELECT id, name, query, folder_id FROM monitors WHERE id = ?").get(id) as MonitorRow | undefined;
  return r ? toMonitor(r) : null;
}

export function saveMonitor(m: { id?: number; name: string; query: MonitorQuery; folderId: number | null }): number {
  const db = getDb();
  const json = JSON.stringify(m.query);
  if (m.id) {
    db.prepare("UPDATE monitors SET name = ?, query = ?, folder_id = ? WHERE id = ?").run(m.name, json, m.folderId, m.id);
    return m.id;
  }
  return Number(
    db
      .prepare("INSERT INTO monitors (name, query, folder_id, position, created_at) VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM monitors), ?)")
      .run(m.name, json, m.folderId, Date.now()).lastInsertRowid,
  );
}

export function deleteMonitor(id: number) {
  getDb().prepare("DELETE FROM monitors WHERE id = ?").run(id);
}
