import { getDb, ID_INDEX } from "./db";
import { htmlToText } from "./html";
import { newFeedToken } from "./outputFeeds";
import { getCredential, getSettings } from "./settings";
import type { Tag, TagRef, TagSuggestions } from "./types";

const MAX_NAME = 60;

/** Trim and collapse whitespace; throws a user-facing error for empty or overlong names. */
export function cleanTagName(input: unknown): string {
  const name = String(input ?? "").replace(/\s+/g, " ").trim();
  if (!name) throw new Error("Enter a tag name");
  if (name.length > MAX_NAME) throw new Error(`Tag names can be at most ${MAX_NAME} characters`);
  return name;
}

type TagRow = { id: number; name: string; feed_token: string | null; count: number };

const TAG_SQL = `SELECT t.id, t.name, t.feed_token,
  (SELECT COUNT(*) FROM article_tags at JOIN articles a ${ID_INDEX} ON a.id = at.article_id WHERE at.tag_id = t.id AND a.filtered = 0) AS count
  FROM tags t`;

const toTag = (r: TagRow): Tag => ({ id: r.id, name: r.name, feedToken: r.feed_token, count: r.count });

export function listTags(): Tag[] {
  return (getDb().prepare(`${TAG_SQL} ORDER BY t.name COLLATE NOCASE`).all() as TagRow[]).map(toTag);
}

export function getTag(id: number): Tag | null {
  const r = getDb().prepare(`${TAG_SQL} WHERE t.id = ?`).get(id) as TagRow | undefined;
  return r ? toTag(r) : null;
}

function findTagId(name: string): number | null {
  const r = getDb().prepare("SELECT id FROM tags WHERE name = ?").get(name) as { id: number } | undefined;
  return r?.id ?? null;
}

export function createTag(input: { name: unknown; outputFeed?: boolean }): Tag {
  const name = cleanTagName(input.name);
  if (findTagId(name)) throw new Error(`A tag named “${name}” already exists`);
  const id = Number(
    getDb()
      .prepare("INSERT INTO tags (name, feed_token, created_at) VALUES (?, ?, ?)")
      .run(name, input.outputFeed ? newFeedToken() : null, Date.now()).lastInsertRowid,
  );
  return getTag(id)!;
}

/** The id of the tag with this name (case-insensitive), creating it if needed. */
export function ensureTag(input: unknown): number {
  const name = cleanTagName(input);
  return findTagId(name) ?? createTag({ name }).id;
}

export function updateTag(
  id: number,
  patch: { name?: unknown; outputFeed?: boolean; regenerateToken?: boolean },
): Tag {
  const db = getDb();
  const tag = getTag(id);
  if (!tag) throw new Error("Tag not found");
  if (patch.name !== undefined) {
    const name = cleanTagName(patch.name);
    const other = findTagId(name);
    if (other && other !== id) throw new Error(`A tag named “${name}” already exists`);
    db.prepare("UPDATE tags SET name = ? WHERE id = ?").run(name, id);
  }
  if (patch.outputFeed === false) db.prepare("UPDATE tags SET feed_token = NULL WHERE id = ?").run(id);
  else if (patch.regenerateToken || (patch.outputFeed && !tag.feedToken))
    db.prepare("UPDATE tags SET feed_token = ? WHERE id = ?").run(newFeedToken(), id);
  return getTag(id)!;
}

/**
 * Delete a tag (its article links go with it). Rules that assigned it lose that action; a rule
 * left without actions is disabled. Returns how many rules were changed.
 */
export function deleteTag(id: number): number {
  const db = getDb();
  let changed = 0;
  db.transaction(() => {
    const rules = db.prepare("SELECT id, definition FROM rules").all() as { id: number; definition: string }[];
    for (const r of rules) {
      const def = JSON.parse(r.definition) as { actions: { type: string; tagId?: number }[] };
      const actions = def.actions.filter((a) => !(a.type === "tag" && a.tagId === id));
      if (actions.length === def.actions.length) continue;
      changed++;
      db.prepare(`UPDATE rules SET definition = ?${actions.length ? "" : ", enabled = 0"} WHERE id = ?`).run(
        JSON.stringify({ ...def, actions }),
        r.id,
      );
    }
    db.prepare("DELETE FROM tags WHERE id = ?").run(id);
  })();
  return changed;
}

/** Rules whose actions assign this tag, for the delete confirmation. */
export function rulesUsingTag(id: number): { id: number; name: string }[] {
  return (getDb().prepare("SELECT id, name, definition FROM rules").all() as { id: number; name: string; definition: string }[])
    .filter((r) => (JSON.parse(r.definition) as { actions: { type: string; tagId?: number }[] }).actions.some((a) => a.type === "tag" && a.tagId === id))
    .map(({ id, name }) => ({ id, name }));
}

// ---------- article tags ----------

export function articleTags(articleId: number): TagRef[] {
  return getDb()
    .prepare("SELECT t.id, t.name FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = ? ORDER BY t.name COLLATE NOCASE")
    .all(articleId) as TagRef[];
}

/** Tag articles; already-tagged ones are left alone. Returns how many links were added. */
export function tagArticles(tagId: number, articleIds: number[]): number {
  const db = getDb();
  const insert = db.prepare("INSERT OR IGNORE INTO article_tags (article_id, tag_id, created_at) VALUES (?, ?, ?)");
  const now = Date.now();
  let added = 0;
  db.transaction(() => {
    for (const id of articleIds) added += insert.run(id, tagId, now).changes;
  })();
  return added;
}

export function untagArticle(tagId: number, articleId: number) {
  getDb().prepare("DELETE FROM article_tags WHERE article_id = ? AND tag_id = ?").run(articleId, tagId);
}

// ---------- suggestions ----------

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** AI suggestions per article, so reopening the flyout doesn't call the model again. */
const g = globalThis as unknown as { __stitchTagAi?: Map<number, string[]> };
const aiCache = (g.__stitchTagAi ??= new Map());

async function aiSuggestions(title: string, text: string, existing: string[]): Promise<string[]> {
  const key = getCredential("openrouterApiKey");
  if (!key) return [];
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
      "X-Title": "Stitch",
    },
    body: JSON.stringify({
      model: getSettings().openrouterModel,
      messages: [
        {
          role: "system",
          content:
            "You suggest tags for organizing saved articles. Reply with only a JSON array of 3 to 5 short tags " +
            "(1 to 3 words each, lowercase unless a proper noun). Describe the topic, not the publication. " +
            (existing.length ? `Reuse these existing tags where they fit: ${JSON.stringify(existing.slice(0, 200))}.` : ""),
        },
        { role: "user", content: `Title: ${title}\n\n${text.slice(0, 8000)}` },
      ],
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter error ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const reply = data.choices?.[0]?.message?.content ?? "";
  const match = /\[[\s\S]*\]/.exec(reply);
  if (!match) return [];
  try {
    const list = JSON.parse(match[0]) as unknown[];
    return list
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.replace(/\s+/g, " ").trim())
      .filter((x) => x && x.length <= MAX_NAME)
      .slice(0, 6);
  } catch {
    return [];
  }
}

/**
 * Tags to offer for an article: existing tags whose name appears in its title or text, then
 * (with an OpenRouter key) the model's suggestions. Tags already on the article are left out.
 */
export async function suggestTags(articleId: number): Promise<TagSuggestions> {
  const a = getDb().prepare("SELECT title, content, full_content FROM articles WHERE id = ?").get(articleId) as
    | { title: string; content: string | null; full_content: string | null }
    | undefined;
  if (!a) throw new Error("Article not found");
  const text = htmlToText(a.full_content || a.content || "");
  const hay = `${a.title}\n${text}`;
  const all = listTags().map((t) => t.name);
  const applied = new Set(articleTags(articleId).map((t) => t.name.toLowerCase()));

  const out: string[] = [];
  const add = (name: string) => {
    // Prefer the existing tag's spelling when the model suggests a known tag.
    const known = all.find((t) => t.toLowerCase() === name.toLowerCase()) ?? name;
    const k = known.toLowerCase();
    if (!applied.has(k) && !out.some((x) => x.toLowerCase() === k)) out.push(known);
  };
  for (const name of all)
    if (new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(name)}(?![\\p{L}\\p{N}])`, "iu").test(hay)) add(name);

  const ai = !!getCredential("openrouterApiKey");
  let error: string | null = null;
  if (ai) {
    try {
      let list = aiCache.get(articleId);
      if (!list) {
        list = await aiSuggestions(a.title, text, all);
        aiCache.set(articleId, list);
        if (aiCache.size > 500) aiCache.delete(aiCache.keys().next().value!);
      }
      list.forEach(add);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  return { suggestions: out.slice(0, 10), ai, error };
}
