// Shared between server and client — keep free of Node imports.

export type Scope =
  | { kind: "all" }
  | { kind: "saved" }
  | { kind: "archive" }
  | { kind: "tagged" }
  | { kind: "tag"; id: number }
  | { kind: "feed"; id: number }
  | { kind: "folder"; id: number }
  | { kind: "monitor"; id: number }
  | { kind: "search"; q: string };

/** One keyword or phrase in a monitoring feed. */
export type MonitorTerm = { text: string; titleOnly?: boolean };

/**
 * A monitoring feed query: every group must match (AND), any term within a group may match (OR),
 * and articles matching any excluded term are dropped (NOT).
 */
export type MonitorQuery = { groups: MonitorTerm[][]; exclude: MonitorTerm[] };

export type Monitor = { id: number; name: string; query: MonitorQuery; folderId: number | null };

export type SidebarMonitor = { id: number; name: string; unread: number };

export type MonitorPreview = { count: number; items: ArticleListItem[]; fts: string | null };

export type SidebarFeed = {
  id: number;
  folderId: number | null;
  title: string;
  feedUrl: string;
  siteUrl: string | null;
  iconUrl: string | null;
  unread: number;
  lastError: string | null;
  lastFetchedAt: number | null;
};

/** `feedToken` is set while the folder's public RSS output feed is on. */
export type SidebarFolder = { id: number; name: string; collapsed: boolean; unread: number; feeds: SidebarFeed[]; feedToken: string | null };

/** Rules and filters that target a feed or folder; they are deleted along with it. */
export type LinkedAutomations = { rules: { id: number; name: string }[]; filters: number };

/** What deleting a folder removes: its own rules and filters, and (if its feeds go too) theirs. */
export type FolderAutomations = { folder: LinkedAutomations; feeds: LinkedAutomations };

/** One refresh of a feed. `status` is the HTTP status, null when no response arrived; `error` is null on success. */
export type FeedFetch = {
  id: number;
  fetchedAt: number;
  durationMs: number;
  status: number | null;
  attempts: number;
  newArticles: number;
  error: string | null;
};

/** Everything the feed properties dialog shows. Article counts exclude filtered articles. */
export type FeedProperties = {
  id: number;
  title: string;
  feedUrl: string;
  siteUrl: string | null;
  iconUrl: string | null;
  folderId: number | null;
  createdAt: number;
  lastFetchedAt: number | null;
  lastError: string | null;
  articles: number;
  unread: number;
  postsThisWeek: number;
  lastPostAt: number | null;
  refreshIntervalMinutes: number;
  automations: LinkedAutomations;
  log: FeedFetch[];
};

export type GoogleNewsPreview = {
  feedUrl: string;
  items: { title: string; source: string | null; url: string | null; publishedAt: number | null }[];
};

/** `count` is how many visible articles carry the tag; `feedToken` is set while its RSS output feed is on. */
export type Tag = { id: number; name: string; feedToken: string | null; count: number };

export type TagRef = { id: number; name: string };

export type TagSuggestions = { suggestions: string[]; ai: boolean; error: string | null };

export type Sidebar = {
  monitors: SidebarMonitor[];
  tags: Tag[];
  folders: SidebarFolder[];
  unfiled: SidebarFeed[];
  totalUnread: number;
  savedCount: number;
  archivedCount: number;
  refreshing: boolean;
};

export type ArticleListItem = {
  id: number;
  feedId: number;
  feedTitle: string;
  feedIcon: string | null;
  title: string;
  url: string | null;
  author: string | null;
  excerpt: string;
  imageUrl: string | null;
  publishedAt: number;
  isRead: boolean;
  isSaved: boolean;
  isArchived: boolean;
};

export type ArticleDetail = ArticleListItem & {
  siteUrl: string | null;
  content: string;
  fullContent: string | null;
  summary: string | null;
  contentLength: number;
  tags: TagRef[];
};

/** `highWater` is the newest article id when the list was loaded; anything above it arrived later. */
/** `unread` is null on pages after the first (the client keeps the first page's count). */
export type ArticlePage = { items: ArticleListItem[]; nextCursor: string | null; unread: number | null; highWater: number };

export type NewArticlesCheck = { newCount: number; unread: number };

export type AppSettings = {
  refreshIntervalMinutes: number;
  retentionDays: number;
  youtubeRetentionDays: number;
  openrouterModel: string;
  autoFullText: boolean;
  summaryPrompt: string;
  defaultSummaryPrompt: string;
  hasOpenRouterKey: boolean;
  credentials: Record<CredentialName, CredentialStatus>;
};

export type CredentialName = "openrouterApiKey" | "sendgridApiKey" | "sendgridFrom" | "pushoverAppToken" | "pushoverUserKey";

/** What the UI may know about a credential: never the secret itself. */
export type CredentialStatus = { set: boolean; source: "settings" | "env" | null; preview: string | null };

export function scopeToParams(scope: Scope): URLSearchParams {
  const p = new URLSearchParams({ scope: scope.kind });
  if (scope.kind === "feed" || scope.kind === "folder" || scope.kind === "monitor" || scope.kind === "tag") p.set("id", String(scope.id));
  if (scope.kind === "search") p.set("q", scope.q);
  return p;
}

// ---------- Automations ----------

export type RuleField = "title" | "content" | "title_or_content" | "author" | "url";
export type RuleOp = "contains" | "not_contains" | "is" | "regex";
/** `join` is ignored on the first condition; AND binds tighter than OR. */
export type RuleCondition = { join: "and" | "or"; field: RuleField; op: RuleOp; value: string };

/** "New article in feed": a single feed, a folder, or (both null) every feed. */
export type RuleTrigger = { type: "new_article"; feedId: number | null; folderId: number | null };

export type PushoverPriority = -1 | 0 | 1;
/**
 * `tag` assigns a tag to matching articles. In the editor `tagId` may be 0 with a `tagName`: saving
 * the rule creates that tag and stores its id. `save` adds to Read later; `summarize` stores an AI
 * summary on the article; `email_summary` emails the AI summaries instead of excerpts.
 */
export type RuleAction =
  | { type: "email"; to: string }
  | { type: "email_summary"; to: string }
  | { type: "pushover"; priority: PushoverPriority; device: string }
  | { type: "tag"; tagId: number; tagName?: string }
  | { type: "mark_read" }
  | { type: "save" }
  | { type: "summarize" };

export type RuleDefinition = { trigger: RuleTrigger; conditions: RuleCondition[]; wholeWords: boolean; actions: RuleAction[] };

export type Rule = { id: number; name: string; enabled: boolean } & RuleDefinition;

export type RuleSummary = Rule & { matchesToday: number; lastError: string | null };

export type RuleMatch = { id: number; articleId: number | null; title: string; matchedAt: number; status: "sent" | "partial" | "failed"; error: string | null };

export type RulesResponse = { rules: RuleSummary[]; providers: { email: boolean; pushover: boolean; ai: boolean } };

export type ActionResult = { action: string; ok: boolean; error?: string };

export type RuleTestResult = { article: { id: number; title: string } | null; matched: boolean; results: ActionResult[] };

/** Result of running a rule's tag / mark read / Read later actions over existing articles. */
export type RuleRunResult = { checked: number; matched: number; tagged: number; markedRead: number; saved: number };

// ---------- Filters ----------

/** "remove" hides articles matching the conditions; "keep" hides every article that doesn't match. */
export type FilterMode = "remove" | "keep";

export type FilterDefinition = {
  target: { feedId: number | null; folderId: number | null };
  mode: FilterMode;
  conditions: RuleCondition[];
  wholeWords: boolean;
};

export type Filter = { id: number; enabled: boolean } & FilterDefinition;

/** `hidden` counts articles currently hidden in the filter's target (by any filter). */
export type FilterSummary = Filter & { hidden: number };

export type FilterPreview = { checked: number; hidden: number; samples: string[] };
