import { getDb } from "./db";
import { htmlToText } from "./html";
import { getCredential } from "./settings";
import { hasOpenRouterKey, summarizeArticle } from "./summarize";
import { ensureTag, getTag, tagArticles } from "./tags";
import type {
  ActionResult, PushoverPriority, Rule, RuleAction, RuleCondition, RuleDefinition, RuleField, RuleMatch, RuleOp, RuleRunResult,
  RuleSummary, RuleTestResult, RuleTrigger,
} from "./types";

// ---------- providers ----------

export function providers() {
  return {
    email: !!(getCredential("sendgridApiKey") && getCredential("sendgridFrom")),
    pushover: !!(getCredential("pushoverAppToken") && getCredential("pushoverUserKey")),
    ai: hasOpenRouterKey(),
  };
}

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

// ---------- storage & validation ----------

const FIELDS: RuleField[] = ["title", "content", "title_or_content", "author", "url"];
const OPS: RuleOp[] = ["contains", "not_contains", "is", "regex"];

/** Validate untrusted condition rows (shared by rules and filters). Throws on an invalid regex. */
export function normalizeConditions(input: unknown): RuleCondition[] {
  return (Array.isArray(input) ? input : []).map((c) => {
    const cond: RuleCondition = {
      join: c?.join === "or" ? "or" : "and",
      field: FIELDS.includes(c?.field) ? c.field : "title_or_content",
      op: OPS.includes(c?.op) ? c.op : "contains",
      value: String(c?.value ?? "").slice(0, 500),
    };
    if (cond.op === "regex" && cond.value.trim()) {
      try {
        new RegExp(cond.value, "iu");
      } catch {
        throw new Error(`Invalid regular expression: ${cond.value}`);
      }
    }
    return cond;
  });
}

/**
 * Validate untrusted rule JSON. Throws an Error with a user-facing message. A tag action naming a
 * new tag creates it when `createTags` is set (saving or running a rule); otherwise its id stays 0.
 */
export function normalizeDefinition(input: unknown, { createTags = true }: { createTags?: boolean } = {}): RuleDefinition {
  const d = (input ?? {}) as Partial<RuleDefinition>;
  const t = (d.trigger ?? {}) as Partial<RuleTrigger>;
  const id = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);
  const trigger: RuleTrigger = { type: "new_article", feedId: id(t.feedId), folderId: id(t.feedId) ? null : id(t.folderId) };

  const conditions = normalizeConditions(d.conditions);

  const actions: RuleAction[] = (Array.isArray(d.actions) ? d.actions : []).map((a) => {
    if (a?.type === "email" || a?.type === "email_summary") {
      const to = String(a.to ?? "").trim();
      if (!EMAIL_RE.test(to)) throw new Error(`Enter a valid email address${to ? `: ${to}` : ""}`);
      return { type: a.type, to };
    }
    if (a?.type === "mark_read" || a?.type === "save" || a?.type === "summarize") return { type: a.type };
    if (a?.type === "pushover") {
      const priority = ([-1, 0, 1] as const).includes(a.priority as PushoverPriority) ? (a.priority as PushoverPriority) : 0;
      const device = String(a.device ?? "").trim();
      if (device && !/^[\w-]{1,25}(,[\w-]{1,25})*$/.test(device)) throw new Error("Pushover device names may only contain letters, numbers, _ and -");
      return { type: "pushover", priority, device };
    }
    if (a?.type === "tag") {
      const tagId = id(a.tagId);
      if (tagId && getTag(tagId)) return { type: "tag", tagId };
      const name = String(a.tagName ?? "").trim();
      if (!name) throw new Error("Choose a tag, or enter a name for a new one");
      return { type: "tag", tagId: createTags ? ensureTag(name) : 0 };
    }
    throw new Error("Unknown action type");
  });
  if (!actions.length) throw new Error("Add at least one action");

  return { trigger, conditions, wholeWords: !!d.wholeWords, actions };
}

type RuleRow = { id: number; name: string; enabled: number; definition: string };

function toRule(r: RuleRow): Rule {
  const def = JSON.parse(r.definition) as RuleDefinition;
  return { id: r.id, name: r.name, enabled: !!r.enabled, ...def };
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function listRules(): RuleSummary[] {
  const db = getDb();
  const today = startOfToday();
  const rows = db.prepare("SELECT id, name, enabled, definition FROM rules ORDER BY position, name COLLATE NOCASE").all() as RuleRow[];
  const counts = db.prepare("SELECT COUNT(*) AS n FROM rule_matches WHERE rule_id = ? AND matched_at >= ?");
  const lastErr = db.prepare("SELECT error FROM rule_matches WHERE rule_id = ? ORDER BY matched_at DESC, id DESC LIMIT 1");
  return rows.map((r) => ({
    ...toRule(r),
    matchesToday: (counts.get(r.id, today) as { n: number }).n,
    lastError: (lastErr.get(r.id) as { error: string | null } | undefined)?.error ?? null,
  }));
}

export function getRule(id: number): Rule | null {
  const r = getDb().prepare("SELECT id, name, enabled, definition FROM rules WHERE id = ?").get(id) as RuleRow | undefined;
  return r ? toRule(r) : null;
}

export function recentMatches(ruleId: number, limit = 10): RuleMatch[] {
  return (
    getDb()
      .prepare("SELECT id, article_id, title, matched_at, status, error FROM rule_matches WHERE rule_id = ? ORDER BY matched_at DESC, id DESC LIMIT ?")
      .all(ruleId, limit) as { id: number; article_id: number | null; title: string; matched_at: number; status: RuleMatch["status"]; error: string | null }[]
  ).map((m) => ({ id: m.id, articleId: m.article_id, title: m.title, matchedAt: m.matched_at, status: m.status, error: m.error }));
}

export function saveRule(r: { id?: number; name: string; enabled: boolean; definition: RuleDefinition }): number {
  const db = getDb();
  const json = JSON.stringify(r.definition);
  if (r.id) {
    db.prepare("UPDATE rules SET name = ?, enabled = ?, definition = ? WHERE id = ?").run(r.name, r.enabled ? 1 : 0, json, r.id);
    return r.id;
  }
  return Number(
    db
      .prepare("INSERT INTO rules (name, enabled, definition, position, created_at) VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM rules), ?)")
      .run(r.name, r.enabled ? 1 : 0, json, Date.now()).lastInsertRowid,
  );
}

export function setRuleEnabled(id: number, enabled: boolean) {
  getDb().prepare("UPDATE rules SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}

export function deleteRule(id: number) {
  getDb().prepare("DELETE FROM rules WHERE id = ?").run(id);
}

// ---------- matching ----------

export type RuleArticle = {
  id: number;
  title: string;
  url: string | null;
  author: string | null;
  content: string | null;
  excerpt: string | null;
  feed_title: string;
  published_at: number;
  _text?: string;
};

export const ARTICLE_SQL = `SELECT a.id, a.title, a.url, a.author, COALESCE(a.full_content, a.content) AS content, a.excerpt, a.published_at, f.title AS feed_title
  FROM articles a JOIN feeds f ON f.id = a.feed_id`;

function fieldText(a: RuleArticle, field: RuleField): string {
  const body = () => (a._text ??= htmlToText(a.content ?? ""));
  switch (field) {
    case "title":
      return a.title;
    case "content":
      return body();
    case "title_or_content":
      return `${a.title}\n${body()}`;
    case "author":
      return a.author ?? "";
    case "url":
      return a.url ?? "";
  }
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Filters test the same few patterns against thousands of articles: compile each once. null
// marks an invalid pattern.
const regexCache = new Map<string, RegExp | null>();
function cachedRegex(source: string): RegExp | null {
  let re = regexCache.get(source);
  if (re === undefined) {
    try {
      re = new RegExp(source, "iu");
    } catch {
      re = null;
    }
    if (regexCache.size >= 500) regexCache.clear();
    regexCache.set(source, re);
  }
  return re;
}

function contains(hay: string, needle: string, wholeWords: boolean) {
  if (!wholeWords) return hay.toLowerCase().includes(needle.toLowerCase());
  return cachedRegex(`(?<![\\p{L}\\p{N}])${escapeRegex(needle)}(?![\\p{L}\\p{N}])`)!.test(hay);
}

function testCondition(c: RuleCondition, a: RuleArticle, wholeWords: boolean): boolean {
  const value = c.value.trim();
  const hay = fieldText(a, c.field);
  switch (c.op) {
    case "contains":
      return contains(hay, value, wholeWords);
    case "not_contains":
      return !contains(hay, value, wholeWords);
    case "is":
      return hay.trim().toLowerCase() === value.toLowerCase();
    case "regex":
      return cachedRegex(c.value)?.test(hay) ?? false;
  }
}

/** Conditions with an empty value are ignored; no conditions matches everything. AND binds tighter than OR. */
export function ruleMatches(def: RuleDefinition, a: RuleArticle): boolean {
  return conditionsMatch(def.conditions, def.wholeWords, a);
}

export function conditionsMatch(conditions: RuleCondition[], wholeWords: boolean, a: RuleArticle): boolean {
  const active = conditions.filter((c) => c.value.trim());
  if (!active.length) return true;
  const groups: RuleCondition[][] = [[]];
  active.forEach((c, i) => {
    if (i > 0 && c.join === "or") groups.push([]);
    groups[groups.length - 1].push(c);
  });
  return groups.some((g) => g.every((c) => testCondition(c, a, wholeWords)));
}

function triggerApplies(t: RuleTrigger, feed: { id: number; folder_id: number | null }) {
  if (t.feedId) return t.feedId === feed.id;
  if (t.folderId) return t.folderId === feed.folder_id;
  return true;
}

// ---------- actions ----------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

async function failureText(res: Response) {
  const body = await res.text().catch(() => "");
  try {
    const j = JSON.parse(body);
    const errs = j.errors?.map((e: { message?: string } | string) => (typeof e === "string" ? e : e.message)).filter(Boolean);
    if (errs?.length) return `${res.status}: ${errs.join("; ")}`;
  } catch {}
  return `${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`;
}

/** The model's markdown bullets (see DEFAULT_SUMMARY_PROMPT) as email HTML. */
function summaryHtml(summary: string) {
  const inline = (s: string) => esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const lines = summary.split("\n").map((l) => l.trim()).filter(Boolean);
  const bullet = /^[-*•]\s+/;
  if (!lines.some((l) => bullet.test(l))) return lines.map((l) => `<p style="margin:0 0 6px">${inline(l)}</p>`).join("");
  return `<ul style="margin:0;padding-left:20px">${lines.map((l) => `<li style="margin:0 0 4px">${inline(l.replace(bullet, ""))}</li>`).join("")}</ul>`;
}

/** With `summaries`, an article's AI summary replaces its excerpt. */
async function sendEmail(to: string, ruleName: string, articles: RuleArticle[], summaries?: Map<number, string>) {
  const key = getCredential("sendgridApiKey");
  const from = getCredential("sendgridFrom");
  if (!key || !from) throw new Error("SendGrid isn't set up: add an API key and sender address in Settings → Notifications");

  const subject =
    articles.length === 1 ? `[${ruleName}] ${clip(articles[0].title, 150)}` : `[${ruleName}] ${articles.length} new articles`;
  const shown = articles.slice(0, 50);
  const bodyText = (a: RuleArticle) => summaries?.get(a.id) ?? clip(a.excerpt ?? "", 300);
  const bodyHtml = (a: RuleArticle) => {
    const s = summaries?.get(a.id);
    return s ? summaryHtml(s) : esc(clip(a.excerpt ?? "", 300));
  };
  const text =
    shown.map((a) => `${a.title}\n${a.feed_title}${a.url ? `\n${a.url}` : ""}\n${bodyText(a)}`).join("\n\n---\n\n") +
    (articles.length > shown.length ? `\n\n…and ${articles.length - shown.length} more.` : "") +
    `\n\nSent by the Stitch rule “${ruleName}”.`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:640px">
${shown
  .map(
    (a) => `<div style="margin:0 0 20px">
  <a href="${esc(a.url ?? "#")}" style="font-size:17px;font-weight:700;color:#1b8576;text-decoration:none">${esc(a.title)}</a>
  <div style="color:#6b6b69;font-size:13px;margin:4px 0">${esc(a.feed_title)}</div>
  <div style="color:#1d1d1c;font-size:14px;line-height:1.5">${bodyHtml(a)}</div>
</div>`,
  )
  .join("\n")}
${articles.length > shown.length ? `<p>…and ${articles.length - shown.length} more.</p>` : ""}
<p style="color:#9a9a97;font-size:12px">Sent by the Stitch rule “${esc(ruleName)}”.</p></div>`;

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, name: "Stitch" },
      subject,
      content: [
        { type: "text/plain", value: text },
        { type: "text/html", value: html },
      ],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status !== 202 && !res.ok) throw new Error(`SendGrid ${await failureText(res)}`);
}

async function pushover(params: Record<string, string>) {
  const res = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Pushover ${await failureText(res)}`);
}

/** Up to three matches are pushed individually; more than that become one summary push. */
async function sendPushover(action: Extract<RuleAction, { type: "pushover" }>, ruleName: string, articles: RuleArticle[]) {
  const token = getCredential("pushoverAppToken");
  const user = getCredential("pushoverUserKey");
  if (!token || !user) throw new Error("Pushover isn't set up: add an app token and user key in Settings → Notifications");
  const base: Record<string, string> = { token, user, priority: String(action.priority) };
  if (action.device) base.device = action.device;

  if (articles.length <= 3) {
    for (const a of articles) {
      const p: Record<string, string> = {
        ...base,
        title: clip(a.title, 250),
        message: clip(`${a.feed_title} · ${ruleName}${a.excerpt ? `\n${a.excerpt}` : ""}`, 1024),
      };
      if (a.url && a.url.length <= 512) {
        p.url = a.url;
        p.url_title = "Open article";
      }
      await pushover(p);
    }
    return;
  }
  await pushover({
    ...base,
    title: clip(`${ruleName}: ${articles.length} new articles`, 250),
    message: clip(articles.map((a) => `• ${a.title}`).join("\n"), 1024),
  });
}

function actionLabel(a: RuleAction) {
  switch (a.type) {
    case "tag":
      return `Tag “${getTag(a.tagId)?.name ?? "deleted tag"}”`;
    case "email":
      return `Email to ${a.to}`;
    case "email_summary":
      return `Email AI summary to ${a.to}`;
    case "pushover":
      return "Pushover notification";
    case "mark_read":
      return "Mark as read";
    case "save":
      return "Add to Read later";
    case "summarize":
      return "AI summary";
  }
}

/** Actions that notify someone; "Send test" runs only these. */
const NOTIFY_ACTIONS: RuleAction["type"][] = ["email", "email_summary", "pushover"];

function assignTag(tagId: number, articles: RuleArticle[]): number {
  if (!getTag(tagId)) throw new Error("The tag no longer exists");
  return tagArticles(tagId, articles.map((a) => a.id));
}

/** Run `sql` (params: now, article id) for each article; returns how many rows changed. */
function updateArticles(sql: string, articles: RuleArticle[]): number {
  const db = getDb();
  const stmt = db.prepare(sql);
  const now = Date.now();
  return db.transaction(() => articles.reduce((n, a) => n + stmt.run(now, a.id).changes, 0))();
}

const markRead = (articles: RuleArticle[]) =>
  updateArticles("UPDATE articles SET is_read = 1, read_at = ? WHERE id = ? AND is_read = 0", articles);
const saveForLater = (articles: RuleArticle[]) =>
  updateArticles("UPDATE articles SET is_saved = 1, saved_at = ? WHERE id = ? AND is_saved = 0", articles);

/** A rule summarizes at most this many matches per run (newest first); the rest keep their excerpt. */
const MAX_RULE_SUMMARIES = 20;
const SUMMARY_CONCURRENCY = 4;

type Summaries = { summaries: Map<number, string>; error: string | null };

/** Summaries for the newest matches, reusing ones already stored on the article. */
async function summarizeArticles(articles: RuleArticle[]): Promise<Summaries> {
  if (!hasOpenRouterKey()) return { summaries: new Map(), error: "No OpenRouter API key: add one in Settings → AI summaries" };
  const todo = articles.slice(0, MAX_RULE_SUMMARIES);
  const summaries = new Map<number, string>();
  const errors: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const a = todo[next++];
      try {
        summaries.set(a.id, await summarizeArticle(a.id));
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
  };
  await Promise.all(Array.from({ length: SUMMARY_CONCURRENCY }, worker));
  const error = errors.length ? `${errors.length} of ${todo.length} summaries failed: ${errors[0]}` : null;
  return { summaries, error };
}

async function runActions(name: string, def: RuleDefinition, articles: RuleArticle[]): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  // "AI summary" and "Email AI summary" in one rule share the same summaries.
  let summaries: Promise<Summaries> | undefined;
  const getSummaries = () => (summaries ??= summarizeArticles(articles));
  for (const action of def.actions) {
    try {
      switch (action.type) {
        case "tag":
          assignTag(action.tagId, articles);
          break;
        case "mark_read":
          markRead(articles);
          break;
        case "save":
          saveForLater(articles);
          break;
        case "summarize": {
          const s = await getSummaries();
          if (s.error) throw new Error(s.error);
          break;
        }
        case "email":
          await sendEmail(action.to, name, articles);
          break;
        case "email_summary": {
          // Articles whose summary failed fall back to their excerpt; only fail if none worked.
          const s = await getSummaries();
          if (s.error && !s.summaries.size) throw new Error(s.error);
          await sendEmail(action.to, name, articles, s.summaries);
          break;
        }
        case "pushover":
          await sendPushover(action, name, articles);
          break;
      }
      results.push({ action: actionLabel(action), ok: true });
    } catch (e) {
      results.push({ action: actionLabel(action), ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

// ---------- running ----------

/**
 * Run enabled "new article" rules against articles that were just added to a feed.
 * Matches are batched per rule, so one refresh produces at most one email per rule.
 */
export async function runRulesForNewArticles(feed: { id: number; folder_id: number | null }, articleIds: number[]) {
  if (!articleIds.length) return;
  const db = getDb();
  const rules = (db.prepare("SELECT id, name, enabled, definition FROM rules WHERE enabled = 1").all() as RuleRow[])
    .map(toRule)
    .filter((r) => triggerApplies(r.trigger, feed));
  if (!rules.length) return;

  const articles = db
    .prepare(`${ARTICLE_SQL} WHERE a.filtered = 0 AND a.id IN (${articleIds.map(() => "?").join(",")}) ORDER BY a.published_at DESC`)
    .all(...articleIds) as RuleArticle[];
  const log = db.prepare("INSERT INTO rule_matches (rule_id, article_id, title, matched_at, status, error) VALUES (?, ?, ?, ?, ?, ?)");

  for (const rule of rules) {
    const matched = articles.filter((a) => ruleMatches(rule, a));
    if (!matched.length) continue;
    const results = await runActions(rule.name, rule, matched);
    const failed = results.filter((r) => !r.ok);
    const status = !failed.length ? "sent" : failed.length === results.length ? "failed" : "partial";
    const error = failed.length ? failed.map((f) => `${f.action}: ${f.error}`).join(" | ") : null;
    if (error) console.error(`[stitch] rule "${rule.name}" delivery failed: ${error}`);
    const now = Date.now();
    db.transaction(() => {
      for (const a of matched) log.run(rule.id, a.id, a.title, now, status, error);
    })();
  }
}

/**
 * Send a test for a (possibly unsaved) rule using the newest article it matches in its trigger
 * scope, falling back to the newest article in scope so delivery can be checked either way.
 */
function triggerArticles(t: RuleTrigger, limit: number): RuleArticle[] {
  const where = "WHERE a.filtered = 0" + (t.feedId ? " AND a.feed_id = ?" : t.folderId ? " AND f.folder_id = ?" : "");
  const params = t.feedId ? [t.feedId] : t.folderId ? [t.folderId] : [];
  return getDb().prepare(`${ARTICLE_SQL} ${where} ORDER BY a.published_at DESC LIMIT ?`).all(...params, limit) as RuleArticle[];
}

/**
 * Send a test for a (possibly unsaved) rule's notification actions using the newest article it
 * matches in its trigger scope, falling back to the newest article in scope so delivery can be
 * checked either way. Tag, mark read, Read later and AI summary actions are skipped ("Run rule"
 * applies the first three); "Email AI summary" still summarizes the test article.
 */
export async function testRule(name: string, def: RuleDefinition): Promise<RuleTestResult> {
  const candidates = triggerArticles(def.trigger, 300);
  const hit = candidates.find((a) => ruleMatches(def, a));
  const article = hit ?? candidates[0];
  if (!article) return { article: null, matched: false, results: [] };
  const notify = { ...def, actions: def.actions.filter((a) => NOTIFY_ACTIONS.includes(a.type)) };
  const results = await runActions(`${name || "Test rule"} (test)`, notify, [article]);
  return { article: { id: article.id, title: article.title }, matched: !!hit, results };
}

export const RUN_RULE_LIMIT = 5000;

/**
 * Apply a rule's tag, mark read and Read later actions to the existing articles it matches (newest
 * first, up to RUN_RULE_LIMIT). Notifications and AI summaries only run for new articles.
 */
export function runRuleOnExisting(def: RuleDefinition): RuleRunResult {
  const candidates = triggerArticles(def.trigger, RUN_RULE_LIMIT);
  const matched = candidates.filter((a) => ruleMatches(def, a));
  const result: RuleRunResult = { checked: candidates.length, matched: matched.length, tagged: 0, markedRead: 0, saved: 0 };
  for (const action of def.actions) {
    if (action.type === "tag") result.tagged += assignTag(action.tagId, matched);
    else if (action.type === "mark_read") result.markedRead += markRead(matched);
    else if (action.type === "save") result.saved += saveForLater(matched);
  }
  return result;
}

/** Keep the match log from growing forever. */
export function purgeRuleMatches() {
  getDb().prepare("DELETE FROM rule_matches WHERE matched_at < ?").run(Date.now() - 30 * 86400000);
}

/** Send a sample email / push with the current credentials, for the Settings page's test buttons. */
export async function sendTestNotification(channel: "email" | "pushover", to?: string): Promise<void> {
  const sample: RuleArticle = {
    id: 0,
    title: "Stitch test notification",
    url: null,
    author: null,
    content: null,
    excerpt: "If you can read this, Stitch can reach you. Rules will deliver new matching articles here.",
    feed_title: "Stitch",
    published_at: Date.now(),
  };
  if (channel === "email") {
    if (!to || !EMAIL_RE.test(to)) throw new Error("Enter the address to send the test to");
    await sendEmail(to, "Settings test", [sample]);
  } else {
    await sendPushover({ type: "pushover", priority: 0, device: "" }, "Settings test", [sample]);
  }
}
