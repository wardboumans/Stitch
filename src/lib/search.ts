import { getDb } from "./db";
import { htmlToText } from "./html";

/** (Re)index one article's plain text. The FTS table is contentless, so we write rows ourselves. */
export function indexArticle(id: number, title: string, html: string | null) {
  indexArticles([{ id, title, text: html ? htmlToText(html) : "" }]);
}

/** (Re)index articles whose plain text is already at hand. */
export function indexArticles(rows: { id: number; title: string; text: string }[]) {
  const db = getDb();
  const del = db.prepare("DELETE FROM articles_fts WHERE rowid = ?");
  const ins = db.prepare("INSERT INTO articles_fts (rowid, title, body) VALUES (?, ?, ?)");
  for (const r of rows) {
    del.run(r.id);
    ins.run(r.id, r.title, r.text);
  }
}

/** Turn free text into a safe FTS5 query: every term quoted, last term prefix-matched. */
export function toFtsQuery(input: string): string | null {
  const terms = input
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter(Boolean);
  if (!terms.length) return null;
  return terms.map((t, i) => `"${t}"${i === terms.length - 1 ? "*" : ""}`).join(" ");
}
