"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownUp,
  Check,
  Filter as FilterIcon,
  FolderInput,
  Info,
  LayoutList,
  Newspaper,
  Pencil,
  RefreshCw,
  Trash2,
  Zap,
} from "lucide-react";
import { api, readStored, writeStored } from "@/lib/client";
import {
  scopeToParams,
  type AppSettings,
  type ArticleListItem,
  type ArticlePage,
  type LinkedAutomations,
  type Scope,
  type Sidebar,
  type SidebarFeed,
  type SidebarFolder,
  type SidebarMonitor,
  type NewArticlesCheck,
  type Tag,
} from "@/lib/types";
import {
  AddFeedPage,
  AddPanel,
  YouTubePage,
  GoogleNewsPage,
  AddTabsMobile,
  ImportPage,
  type AddTab,
} from "./AddNew";
import { ArticleList, type ListLayout } from "./ArticleList";
import {
  AutomatePanel,
  AutomateTabsMobile,
  RulesPage,
  type AutomateSection,
} from "./Automations";
import { FeedPropertiesDialog, type FeedPropertiesTab } from "./FeedProperties";
import { FiltersPage } from "./Filters";
import { ArticleView } from "./ArticleView";
import {
  DeleteFolderDialog,
  FolderPropertiesDialog,
  PromptDialog,
  describeAutomations,
} from "./Dialogs";
import {
  SETTINGS_SECTIONS,
  SettingsPage,
  SettingsPanel,
  SettingsTabsMobile,
  type SettingsSection,
} from "./SettingsPage";
import { MonitorEditor } from "./MonitorEditor";
import { Rail, type Theme } from "./Rail";
import { SavedPanel, SidebarPanel } from "./SidebarPanel";
import { ManageTagsDialog, TagDialog } from "./Tags";
import { ConfirmHost, confirmDialog } from "./ConfirmDialog";
import type { MenuItem } from "./ui";
import { primaryButton } from "./ui";

/** Reading feeds, or the "Add new" pages (web feed, monitoring feed editor, import). */
type Mode =
  | { kind: "read" }
  | { kind: "add"; tab: AddTab; monitorId?: number }
  | {
      kind: "automate";
      section: AutomateSection;
      /** Set by a feed/folder menu's "Create rule…" / "Filter articles…" to open a new item aimed at it. */
      presetFeedId?: number;
      presetFolderId?: number;
    }
  | { kind: "settings"; section: SettingsSection };

type DialogState =
  | null
  | { kind: "rename-feed"; feed: SidebarFeed }
  | { kind: "feed-properties"; feedId: number; tab?: FeedPropertiesTab }
  | { kind: "folder-properties"; folder: SidebarFolder }
  | { kind: "delete-folder"; folder: SidebarFolder }
  | { kind: "new-folder"; moveFeedId?: number }
  | { kind: "tag"; tag?: Tag }
  | { kind: "manage-tags" };

/** Scopes shown in the Saved section (the Saved panel replaces the feed sidebar for these). */
const SAVED_KINDS: Scope["kind"][] = ["saved", "archive", "tagged", "tag"];

function scopeFromLocation(): Scope {
  const p = new URLSearchParams(window.location.search);
  const id = Number(
    p.get("feed") ?? p.get("folder") ?? p.get("monitor") ?? p.get("tag"),
  );
  if (p.has("feed") && id) return { kind: "feed", id };
  if (p.has("folder") && id) return { kind: "folder", id };
  if (p.has("monitor") && id) return { kind: "monitor", id };
  if (p.has("tag") && id) return { kind: "tag", id };
  if (p.has("saved")) return { kind: "saved" };
  if (p.has("archive")) return { kind: "archive" };
  if (p.has("tagged")) return { kind: "tagged" };
  if (p.has("q")) return { kind: "search", q: p.get("q") ?? "" };
  return { kind: "all" };
}

function scopeToLocation(scope: Scope): string {
  switch (scope.kind) {
    case "all":
      return "/";
    case "saved":
      return "/?saved";
    case "archive":
      return "/?archive";
    case "tagged":
      return "/?tagged";
    case "tag":
      return `/?tag=${scope.id}`;
    case "feed":
      return `/?feed=${scope.id}`;
    case "folder":
      return `/?folder=${scope.id}`;
    case "monitor":
      return `/?monitor=${scope.id}`;
    case "search":
      return `/?q=${encodeURIComponent(scope.q)}`;
  }
}

/** /automate/<section> and /settings/<section> open those pages; every other path is the reader. */
function modeFromLocation(): Mode {
  const path = window.location.pathname;
  const a = /^\/automate(?:\/(rules|filters))?\/?$/.exec(path);
  if (a)
    return {
      kind: "automate",
      section: a[1] === "filters" ? "filters" : "rules",
    };
  const s = /^\/settings(?:\/([a-z]+))?\/?$/.exec(path);
  if (s) {
    const section =
      SETTINGS_SECTIONS.find((x) => x.id === s[1])?.id ?? "general";
    return { kind: "settings", section };
  }
  return { kind: "read" };
}

/** Phone layout (below Tailwind's md breakpoint): the article and the nav drawer cover the screen. */
const isPhone = () => window.matchMedia("(max-width: 767px)").matches;

/** An open article on a phone has a history entry of its own, so the back button closes it. */
const articleInHistory = () => !!window.history.state?.article;

/** How far from the left edge a swipe may start to pull the nav drawer open. */
const DRAWER_EDGE = 32;

function applyTheme(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function AppShell() {
  const [sidebar, setSidebar] = useState<Sidebar | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [scope, setScope] = useState<Scope>(scopeFromLocation);
  const [unreadOnly, setUnreadOnly] = useState(() =>
    readStored("stitch-unread-only", true),
  );
  const [oldestFirst, setOldestFirst] = useState(() =>
    readStored("stitch-oldest-first", false),
  );
  const [layout, setLayout] = useState<ListLayout>(() =>
    readStored<ListLayout>("stitch-layout", "titles"),
  );
  const [theme, setTheme] = useState<Theme>(() => {
    const t = document.documentElement.dataset.theme;
    return t === "light" || t === "dark" ? t : "system";
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    readStored("stitch-sidebar-collapsed", false),
  );
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStored("stitch-sidebar-width", 340),
  );
  const [listWidth, setListWidth] = useState(() =>
    readStored("stitch-list-width", 380),
  );
  const [navOpen, setNavOpen] = useState(false);
  /** While the nav drawer is dragged by a swipe: how far open it is (0–1). */
  const [drawerDrag, setDrawerDrag] = useState<number | null>(null);
  const [mode, setModeState] = useState<Mode>(modeFromLocation);

  const searchMode = scope.kind === "search";
  const savedView = SAVED_KINDS.includes(scope.kind);
  // Saved and search views list everything; "unread only" applies to feed views.
  const effectiveUnreadOnly = unreadOnly && !savedView && !searchMode;

  // The list belongs to one query; when the query changes, the stale list is simply ignored
  // until the new one arrives (no reset-in-effect needed).
  const queryKey = JSON.stringify([scope, effectiveUnreadOnly, oldestFirst]);
  type ListState = {
    key: string;
    items: ArticleListItem[];
    cursor: string | null;
    unread: number;
    /** Newest article id when the list loaded; newer ones count as "new". */
    highWater: number;
    newCount: number;
  };
  const [list, setList] = useState<ListState | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selection, setSelection] = useState<{
    key: string;
    id: number;
  } | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);

  const current = list?.key === queryKey ? list : null;
  const items = useMemo(() => current?.items ?? [], [current]);
  const cursor = current?.cursor ?? null;
  const hasMore = !!cursor;
  const loading = !current || loadingMore;
  const scopeUnread = current?.unread ?? 0;
  const newCount = current?.newCount ?? 0;
  const highWater = current?.highWater ?? null;
  const selectedId = selection?.key === queryKey ? selection.id : null;

  // ---------- persistence ----------
  useEffect(() => {
    writeStored("stitch-unread-only", unreadOnly);
    writeStored("stitch-oldest-first", oldestFirst);
    writeStored("stitch-layout", layout);
    writeStored("stitch-sidebar-collapsed", sidebarCollapsed);
    writeStored("stitch-sidebar-width", sidebarWidth);
    writeStored("stitch-list-width", listWidth);
  }, [
    unreadOnly,
    oldestFirst,
    layout,
    sidebarCollapsed,
    sidebarWidth,
    listWidth,
  ]);

  useEffect(() => {
    api<AppSettings>("/api/settings")
      .then(setSettings)
      .catch(() => {});
    const onPop = () => {
      setScope(scopeFromLocation());
      setModeState(modeFromLocation());
      // Back from an article's entry: close it (the list's own entry has no article flag).
      if (isPhone() && !articleInHistory()) setSelection(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // ---------- data loading ----------
  const applySidebar = useCallback((s: Sidebar) => {
    setSidebar(s);
    return s;
  }, []);

  const loadSidebar = useCallback(
    () => api<Sidebar>("/api/sidebar").then(applySidebar),
    [applySidebar],
  );

  // Stepping through a list marks an article read per keypress; reload the sidebar's counts once
  // the burst settles instead of after every article.
  const sidebarTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const loadSidebarSoon = useCallback(() => {
    clearTimeout(sidebarTimer.current);
    sidebarTimer.current = setTimeout(() => loadSidebar().catch(() => {}), 800);
  }, [loadSidebar]);
  useEffect(() => () => clearTimeout(sidebarTimer.current), []);

  const fetchPage = useCallback(
    (after: string | null): Promise<ArticlePage> => {
      if (scope.kind === "search" && !scope.q)
        return Promise.resolve({
          items: [],
          nextCursor: null,
          unread: 0,
          highWater: 0,
        });
      const p = scopeToParams(scope);
      if (effectiveUnreadOnly) p.set("unread", "1");
      if (oldestFirst) p.set("sort", "oldest");
      if (after) p.set("cursor", after);
      return api<ArticlePage>(`/api/articles?${p}`);
    },
    [scope, effectiveUnreadOnly, oldestFirst],
  );

  useEffect(() => {
    let cancelled = false;
    fetchPage(null)
      .then(
        (page) =>
          !cancelled &&
          setList({
            key: queryKey,
            items: page.items,
            cursor: page.nextCursor,
            unread: page.unread ?? 0,
            highWater: page.highWater,
            newCount: 0,
          }),
      )
      .catch(
        () =>
          !cancelled &&
          setList({
            key: queryKey,
            items: [],
            cursor: null,
            unread: 0,
            highWater: 0,
            newCount: 0,
          }),
      );
    return () => {
      cancelled = true;
    };
  }, [fetchPage, queryKey, reloadToken]);

  const loadMore = useCallback(() => {
    if (!current?.cursor || loadingMore) return;
    const key = current.key;
    setLoadingMore(true);
    fetchPage(current.cursor)
      .then((page) =>
        setList((l) =>
          l && l.key === key
            ? {
                ...l,
                items: [
                  ...l.items,
                  ...page.items.filter(
                    (i) => !l.items.some((x) => x.id === i.id),
                  ),
                ],
                cursor: page.nextCursor,
                unread: page.unread ?? l.unread,
              }
            : l,
        ),
      )
      .finally(() => setLoadingMore(false));
  }, [current, loadingMore, fetchPage]);

  const reloadList = useCallback(() => setReloadToken((t) => t + 1), []);

  const reloadAll = useCallback(() => {
    loadSidebar();
    reloadList();
  }, [loadSidebar, reloadList]);

  // Poll the sidebar: quickly while a refresh runs (e.g. after OPML import), otherwise once a minute.
  const refreshing = !!sidebar?.refreshing;
  useEffect(() => {
    const tick = () =>
      api<Sidebar>("/api/sidebar")
        .then(applySidebar)
        .catch(() => {});
    tick();
    const t = setInterval(tick, refreshing ? 3000 : 60000);
    return () => clearInterval(t);
  }, [applySidebar, refreshing]);

  // Ask whether the current view got articles newer than the list (and keep its unread count
  // live). Checked on load of the list, whenever the sidebar totals change, and once a minute.
  const totalUnread = sidebar?.totalUnread;
  useEffect(() => {
    if (highWater === null || (scope.kind === "search" && !scope.q)) return;
    const key = queryKey;
    const p = scopeToParams(scope);
    if (effectiveUnreadOnly) p.set("unread", "1");
    p.set("after", String(highWater));
    const check = () =>
      api<NewArticlesCheck>(`/api/articles/new?${p}`)
        .then((r) =>
          setList((l) =>
            l && l.key === key && l.highWater === highWater
              ? { ...l, newCount: r.newCount, unread: r.unread }
              : l,
          ),
        )
        .catch(() => {});
    check();
    const t = setInterval(check, 60000);
    return () => clearInterval(t);
  }, [queryKey, highWater, scope, effectiveUnreadOnly, totalUnread]);

  // ---------- navigation ----------
  /**
   * Switch between the reader, "Add new" and Automate, keeping the URL in sync: Automate lives at
   * /automate/<section>; everything else shows the current scope's URL. Presets aren't put in the
   * URL, so reloading never reopens a half-made rule or filter.
   */
  const setMode = useCallback(
    (m: Mode) => {
      setModeState(m);
      const url =
        m.kind === "automate"
          ? `/automate/${m.section}`
          : m.kind === "settings"
            ? `/settings/${m.section}`
            : scopeToLocation(scope);
      if (url !== window.location.pathname + window.location.search)
        window.history.pushState(null, "", url);
    },
    [scope],
  );

  const select = useCallback((s: Scope) => {
    setScope(s);
    setModeState({ kind: "read" });
    setNavOpen(false);
    const url = scopeToLocation(s);
    if (url !== window.location.pathname + window.location.search)
      window.history.pushState(null, "", url);
  }, []);

  // ---------- article state ----------
  const patchItem = (id: number, patch: Partial<ArticleListItem>) =>
    setList(
      (l) =>
        l && {
          ...l,
          items: l.items.map((a) => (a.id === id ? { ...a, ...patch } : a)),
        },
    );
  const setScopeUnread = (fn: (n: number) => number) =>
    setList((l) => l && { ...l, unread: fn(l.unread) });
  const setSelectedId = useCallback(
    (id: number | null) =>
      setSelection(id === null ? null : { key: queryKey, id }),
    [queryKey],
  );

  const setRead = useCallback(
    async (a: ArticleListItem, isRead: boolean) => {
      if (a.isRead === isRead) return;
      patchItem(a.id, { isRead });
      setScopeUnread((n) => Math.max(0, n + (isRead ? -1 : 1)));
      await api(`/api/articles/${a.id}`, { method: "PATCH", json: { isRead } });
      loadSidebarSoon();
    },
    [loadSidebarSoon],
  );

  const toggleSave = useCallback(
    async (a: ArticleListItem) => {
      patchItem(a.id, { isSaved: !a.isSaved });
      await api(`/api/articles/${a.id}`, {
        method: "PATCH",
        json: { isSaved: !a.isSaved },
      });
      loadSidebarSoon();
    },
    [loadSidebarSoon],
  );

  /** Archiving also takes the article out of Read later (see setArticleState). */
  const toggleArchive = useCallback(
    async (a: ArticleListItem) => {
      const isArchived = !a.isArchived;
      patchItem(
        a.id,
        isArchived ? { isArchived, isSaved: false } : { isArchived },
      );
      await api(`/api/articles/${a.id}`, {
        method: "PATCH",
        json: { isArchived },
      });
      loadSidebarSoon();
    },
    [loadSidebarSoon],
  );

  const open = useCallback(
    (a: ArticleListItem) => {
      // On phones the article covers the list like a page, so it gets a history entry and
      // Android's back button returns to the list. Stepping to the next article reuses it.
      if (isPhone() && !articleInHistory())
        window.history.pushState({ article: true }, "", window.location.href);
      setSelectedId(a.id);
      if (!a.isRead) setRead(a, true);
    },
    [setRead, setSelectedId],
  );

  const selected = useMemo(
    () => items.find((a) => a.id === selectedId) ?? null,
    [items, selectedId],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      if (!items.length) return;
      const idx = selected ? items.findIndex((a) => a.id === selected.id) : -1;
      const next = items[idx + dir] ?? (idx === -1 ? items[0] : null);
      if (next) open(next);
      if (dir === 1 && idx >= items.length - 3 && hasMore) loadMore();
    },
    [items, selected, open, hasMore, loadMore],
  );

  const markAllRead = useCallback(
    async (olderThanMs?: number) => {
      // Bounded by the newest article that existed when the list loaded, so anything that
      // arrived since (the "new articles" the button offers) stays unread.
      const maxId = highWater || items.reduce((m, a) => Math.max(m, a.id), 0);
      const body = {
        ...Object.fromEntries(scopeToParams(scope)),
        id: "id" in scope ? scope.id : undefined,
        maxId: maxId || undefined,
        olderThanMs,
      };
      await api("/api/articles/mark-read", { method: "POST", json: body });
      await loadSidebar();
      if (!olderThanMs) {
        setList(
          (l) =>
            l && {
              ...l,
              items: l.items.map((a) => ({ ...a, isRead: true })),
              unread: 0,
            },
        );
      }
      reloadList();
    },
    [items, highWater, scope, loadSidebar, reloadList],
  );

  const refreshFeeds = useCallback(async () => {
    setSidebar((s) => (s ? { ...s, refreshing: true } : s));
    await api("/api/refresh", { method: "POST", json: {} }).catch(() => {});
    reloadAll();
  }, [reloadAll]);

  // ---------- keyboard shortcuts ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (
        dialog ||
        mode.kind !== "read" ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        t.closest(
          "input, textarea, select, [contenteditable=true], [role=dialog]",
        )
      )
        return;
      const k = e.key;
      if (k === "j" || k === "n") step(1);
      else if (k === "k" || k === "p") step(-1);
      else if (k === "s" && selected) toggleSave(selected);
      else if (k === "e" && selected) toggleArchive(selected);
      else if (k === "m" && selected) setRead(selected, !selected.isRead);
      else if (k === "v" && selected?.url)
        window.open(selected.url, "_blank", "noopener");
      else if (k === "r") refreshFeeds();
      else if (k === "A" && e.shiftKey) markAllRead();
      else if (k === "/") {
        e.preventDefault();
        select({ kind: "search", q: "" });
      } else return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    dialog,
    mode.kind,
    step,
    selected,
    toggleSave,
    toggleArchive,
    setRead,
    refreshFeeds,
    markAllRead,
    select,
  ]);

  // ---------- nav drawer swipe (phones) ----------
  // Swipe right from the left edge pulls the drawer open; swipe left on it pushes it closed. The
  // drawer follows the finger and settles by how far (or how fast) it was dragged.
  useEffect(() => {
    let drag: { x: number; y: number; t: number; from: number } | null = null;
    let tracking = false;
    const drawerWidth = () => Math.min(380, window.innerWidth * 0.9);
    const progress = (x: number) =>
      drag
        ? Math.min(1, Math.max(0, drag.from + (x - drag.x) / drawerWidth()))
        : 0;
    const onStart = (e: TouchEvent) => {
      drag = null;
      tracking = false;
      if (!isPhone() || dialog || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (!navOpen && t.clientX > DRAWER_EDGE) return;
      drag = {
        x: t.clientX,
        y: t.clientY,
        t: e.timeStamp,
        from: navOpen ? 1 : 0,
      };
    };
    const onMove = (e: TouchEvent) => {
      if (!drag) return;
      const t = e.touches[0];
      const dx = t.clientX - drag.x;
      const dy = t.clientY - drag.y;
      if (!tracking) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        // A vertical scroll, or a swipe the wrong way, isn't ours.
        if (Math.abs(dy) > Math.abs(dx) || (drag.from ? dx > 0 : dx < 0)) {
          drag = null;
          return;
        }
        tracking = true;
      }
      setDrawerDrag(progress(t.clientX));
    };
    const onEnd = (e: TouchEvent) => {
      if (drag && tracking) {
        const x = e.changedTouches[0]?.clientX ?? drag.x;
        const velocity = (x - drag.x) / Math.max(1, e.timeStamp - drag.t);
        const p = progress(x);
        setNavOpen(velocity > 0.5 ? true : velocity < -0.5 ? false : p > 0.5);
        setDrawerDrag(null);
      }
      drag = null;
      tracking = false;
    };
    const opts = { passive: true };
    window.addEventListener("touchstart", onStart, opts);
    window.addEventListener("touchmove", onMove, opts);
    window.addEventListener("touchend", onEnd, opts);
    window.addEventListener("touchcancel", onEnd, opts);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [navOpen, dialog]);

  // ---------- sidebar & feed management ----------
  const allFeeds = useMemo(
    () =>
      sidebar
        ? [...sidebar.unfiled, ...sidebar.folders.flatMap((f) => f.feeds)]
        : [],
    [sidebar],
  );

  const moveFeed = async (feedId: number, folderId: number | null) => {
    await api(`/api/feeds/${feedId}`, { method: "PATCH", json: { folderId } });
    loadSidebar();
  };

  const unfollowFeed = async (feed: { id: number; title: string }) => {
    const lost = describeAutomations(
      await api<LinkedAutomations>(`/api/feeds/${feed.id}`),
    );
    if (
      !(await confirmDialog({
        title: "Unfollow feed?",
        message: (
          <>
            “{feed.title}” and all of its articles, including saved, archived
            and tagged ones, will be deleted.
            {lost && (
              <span className="mt-3 block text-danger">
                {lost} for this feed will also be deleted.
              </span>
            )}
          </>
        ),
        confirmLabel: "Unfollow",
        danger: true,
      }))
    )
      return;
    await api(`/api/feeds/${feed.id}`, { method: "DELETE" });
    if (scope.kind === "feed" && scope.id === feed.id) select({ kind: "all" });
    reloadAll();
  };

  const feedMenu = (feed: SidebarFeed): MenuItem[] => [
    {
      label: "Mark as read",
      icon: <Check size={14} />,
      onSelect: () =>
        api("/api/articles/mark-read", {
          method: "POST",
          json: { scope: "feed", id: feed.id },
        }).then(reloadAll),
    },
    {
      label: "Refresh",
      icon: <RefreshCw size={14} />,
      onSelect: () =>
        api("/api/refresh", { method: "POST", json: { feedId: feed.id } }).then(
          reloadAll,
        ),
    },
    {
      label: "Rename",
      icon: <Pencil size={14} />,
      onSelect: () => setDialog({ kind: "rename-feed", feed }),
    },
    {
      label: "Feed properties…",
      icon: <Info size={14} />,
      onSelect: () => setDialog({ kind: "feed-properties", feedId: feed.id }),
    },
    {
      label: "Filter articles…",
      icon: <FilterIcon size={14} />,
      onSelect: () =>
        setMode({
          kind: "automate",
          section: "filters",
          presetFeedId: feed.id,
        }),
    },
    {
      label: "Create rule…",
      icon: <Zap size={14} />,
      onSelect: () =>
        setMode({ kind: "automate", section: "rules", presetFeedId: feed.id }),
    },
    {
      label: "Unfollow",
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: () => unfollowFeed(feed),
    },
    { separator: true },
    { heading: "Move to" },
    ...(sidebar?.folders ?? [])
      .filter((f) => f.id !== feed.folderId)
      .map((f) => ({
        label: f.name,
        icon: <FolderInput size={14} />,
        onSelect: () => moveFeed(feed.id, f.id),
      })),
    ...(feed.folderId !== null
      ? [
          {
            label: "No folder",
            icon: <FolderInput size={14} />,
            onSelect: () => moveFeed(feed.id, null),
          },
        ]
      : []),
    {
      label: "New folder…",
      icon: <FolderInput size={14} />,
      onSelect: () => setDialog({ kind: "new-folder", moveFeedId: feed.id }),
    },
  ];

  const folderMenu = (folder: SidebarFolder): MenuItem[] => [
    {
      label: "Mark as read",
      icon: <Check size={14} />,
      onSelect: () =>
        api("/api/articles/mark-read", {
          method: "POST",
          json: { scope: "folder", id: folder.id },
        }).then(reloadAll),
    },
    {
      label: "Folder properties…",
      icon: <Pencil size={14} />,
      onSelect: () => setDialog({ kind: "folder-properties", folder }),
    },
    {
      label: "Create rule…",
      icon: <Zap size={14} />,
      onSelect: () =>
        setMode({
          kind: "automate",
          section: "rules",
          presetFolderId: folder.id,
        }),
    },
    {
      label: "Delete folder",
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: () => setDialog({ kind: "delete-folder", folder }),
    },
  ];

  const monitorMenu = (monitor: SidebarMonitor): MenuItem[] => [
    {
      label: "Mark as read",
      icon: <Check size={14} />,
      onSelect: () =>
        api("/api/articles/mark-read", {
          method: "POST",
          json: { scope: "monitor", id: monitor.id },
        }).then(reloadAll),
    },
    {
      label: "Edit monitoring feed",
      icon: <Pencil size={14} />,
      onSelect: () =>
        setMode({ kind: "add", tab: "monitor", monitorId: monitor.id }),
    },
    {
      label: "Delete",
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: async () => {
        if (
          !(await confirmDialog({
            title: "Delete monitoring feed?",
            message: (
              <>
                “{monitor.name}” will be removed from the sidebar. Articles are
                not affected.
              </>
            ),
            confirmLabel: "Delete",
            danger: true,
          }))
        )
          return;
        await api(`/api/monitors/${monitor.id}`, { method: "DELETE" });
        if (scope.kind === "monitor" && scope.id === monitor.id)
          select({ kind: "all" });
        loadSidebar();
      },
    },
  ];

  const deleteTag = async (tag: Tag) => {
    const { rules } = await api<{ rules: { id: number; name: string }[] }>(
      `/api/tags/${tag.id}`,
    );
    if (
      !(await confirmDialog({
        title: "Delete tag?",
        message: (
          <>
            “{tag.name}” will be removed from{" "}
            {tag.count === 1 ? "1 article" : `${tag.count} articles`}. The
            articles themselves are kept.
            {rules.length > 0 && (
              <span className="mt-3 block text-danger">
                {rules.length === 1 ? "The rule" : "The rules"}{" "}
                {rules.map((r) => `“${r.name}”`).join(", ")} will stop assigning
                it; a rule left with no actions is disabled.
              </span>
            )}
          </>
        ),
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return;
    await api(`/api/tags/${tag.id}`, { method: "DELETE" });
    setDialog((d) => (d?.kind === "tag" ? null : d));
    if (scope.kind === "tag" && scope.id === tag.id) select({ kind: "tagged" });
    reloadAll();
  };

  const tagMenu = (tag: Tag): MenuItem[] => [
    {
      label: "Mark as read",
      icon: <Check size={14} />,
      onSelect: () =>
        api("/api/articles/mark-read", {
          method: "POST",
          json: { scope: "tag", id: tag.id },
        }).then(reloadAll),
    },
    {
      label: "Edit tag…",
      icon: <Pencil size={14} />,
      onSelect: () => setDialog({ kind: "tag", tag }),
    },
    {
      label: "Delete tag",
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: () => deleteTag(tag),
    },
  ];

  const toggleFolder = async (folder: SidebarFolder) => {
    setSidebar(
      (s) =>
        s && {
          ...s,
          folders: s.folders.map((f) =>
            f.id === folder.id ? { ...f, collapsed: !f.collapsed } : f,
          ),
        },
    );
    await api(`/api/folders/${folder.id}`, {
      method: "PATCH",
      json: { collapsed: !folder.collapsed },
    });
  };

  const cycleTheme = () => {
    const next: Theme =
      theme === "system" ? "light" : theme === "light" ? "dark" : "system";
    setTheme(next);
    applyTheme(next);
    try {
      if (next === "system") localStorage.removeItem("stitch-theme");
      else localStorage.setItem("stitch-theme", next);
    } catch {}
  };

  // ---------- list header ----------
  const currentFeed =
    scope.kind === "feed" ? allFeeds.find((f) => f.id === scope.id) : undefined;
  const currentFolder =
    scope.kind === "folder"
      ? sidebar?.folders.find((f) => f.id === scope.id)
      : undefined;
  const currentMonitor =
    scope.kind === "monitor"
      ? sidebar?.monitors.find((m) => m.id === scope.id)
      : undefined;
  const currentTag =
    scope.kind === "tag"
      ? sidebar?.tags.find((t) => t.id === scope.id)
      : undefined;
  const title =
    scope.kind === "all"
      ? "All articles"
      : scope.kind === "saved"
        ? "Read later"
        : scope.kind === "archive"
          ? "Archive"
          : scope.kind === "tagged"
            ? "All tagged articles"
            : scope.kind === "search"
              ? "Search"
              : (currentFeed?.title ??
                currentFolder?.name ??
                currentMonitor?.name ??
                currentTag?.name ??
                "…");
  const titleMenu = currentFeed
    ? feedMenu(currentFeed)
    : currentFolder
      ? folderMenu(currentFolder)
      : currentMonitor
        ? monitorMenu(currentMonitor)
        : currentTag
          ? tagMenu(currentTag)
          : undefined;

  const viewMenu: MenuItem[] = [
    { heading: "Show" },
    {
      label: "Unread only",
      checked: unreadOnly,
      onSelect: () => setUnreadOnly(true),
    },
    {
      label: "All articles",
      checked: !unreadOnly,
      onSelect: () => setUnreadOnly(false),
    },
    { heading: "Sort" },
    {
      label: "Newest first",
      checked: !oldestFirst,
      onSelect: () => setOldestFirst(false),
    },
    {
      label: "Oldest first",
      checked: oldestFirst,
      icon: <ArrowDownUp size={14} />,
      onSelect: () => setOldestFirst(true),
    },
    { heading: "Layout" },
    {
      label: "Titles",
      checked: layout === "titles",
      icon: <LayoutList size={14} />,
      onSelect: () => setLayout("titles"),
    },
    {
      label: "Magazine",
      checked: layout === "magazine",
      icon: <Newspaper size={14} />,
      onSelect: () => setLayout("magazine"),
    },
    { separator: true },
    {
      label: "Refresh feeds",
      icon: <RefreshCw size={14} />,
      onSelect: refreshFeeds,
    },
  ];

  const markMenu: MenuItem[] = [
    { label: "Mark all as read", onSelect: () => markAllRead() },
    { label: "Older than one day", onSelect: () => markAllRead(86400000) },
    { label: "Older than one week", onSelect: () => markAllRead(7 * 86400000) },
  ];

  const view =
    mode.kind === "settings"
      ? "settings"
      : mode.kind === "automate"
        ? "automate"
        : mode.kind === "add"
          ? "add"
          : savedView
            ? "saved"
            : scope.kind === "search"
              ? "search"
              : "feeds";
  const openAdd = (tab: AddTab = "feed") => {
    setMode({ kind: "add", tab });
    setNavOpen(false);
  };
  const noFeeds =
    sidebar &&
    !sidebar.unfiled.length &&
    !sidebar.folders.some((f) => f.feeds.length);

  /** Drag handler for a pane splitter; the width is clamped and persisted via the effect above. */
  const startResize =
    (startW: number, setW: (w: number) => void, min: number, max: number) =>
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const body = document.body.style;
      body.userSelect = "none";
      body.cursor = "col-resize";
      const onMove = (ev: PointerEvent) =>
        setW(Math.min(max, Math.max(min, startW + ev.clientX - startX)));
      const onUp = () => {
        body.userSelect = "";
        body.cursor = "";
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };

  const splitter = (
    onPointerDown: (e: React.PointerEvent) => void,
    onReset: () => void,
  ) => (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      className="hidden w-1.5 shrink-0 cursor-col-resize items-center justify-center text-faint hover:bg-hover md:flex"
      title="Drag to resize · double-click to reset"
    >
      ⋮
    </div>
  );

  const rail = (
    <Rail
      view={view}
      totalUnread={sidebar?.totalUnread ?? 0}
      savedCount={sidebar?.savedCount ?? 0}
      theme={theme}
      sidebarCollapsed={sidebarCollapsed}
      onFeeds={() => {
        if (mode.kind === "read" && !savedView && !searchMode)
          return setSidebarCollapsed((c) => !c);
        // From Saved or Search (also by way of Automate etc.) Feeds goes to All articles.
        if (savedView || searchMode) select({ kind: "all" });
        else setMode({ kind: "read" });
        setSidebarCollapsed(false);
      }}
      onSaved={() => select({ kind: "saved" })}
      onSearch={() => select({ kind: "search", q: "" })}
      onAutomate={() => {
        setMode({
          kind: "automate",
          section: mode.kind === "automate" ? mode.section : "rules",
        });
        setNavOpen(false);
      }}
      onAdd={() => openAdd()}
      onSettings={() => {
        setMode({
          kind: "settings",
          section: mode.kind === "settings" ? mode.section : "general",
        });
        setNavOpen(false);
      }}
      onTheme={cycleTheme}
      onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
    />
  );
  const sidebarPanel = savedView ? (
    <SavedPanel
      sidebar={sidebar}
      scope={scope}
      actions={{
        select,
        newTag: () => setDialog({ kind: "tag" }),
        manageTags: () => setDialog({ kind: "manage-tags" }),
        tagMenu,
      }}
    />
  ) : (
    <SidebarPanel
      sidebar={sidebar}
      scope={scope}
      actions={{
        select,
        toggleFolder,
        newFolder: () => setDialog({ kind: "new-folder" }),
        refreshAll: refreshFeeds,
        openSettings: () => setMode({ kind: "settings", section: "general" }),
        feedMenu,
        feedLog: (feed) =>
          setDialog({ kind: "feed-properties", feedId: feed.id, tab: "log" }),
        folderMenu,
        monitorMenu,
      }}
    />
  );
  const addPanel =
    mode.kind === "add" ? (
      <AddPanel tab={mode.tab} onTab={(tab) => setMode({ kind: "add", tab })} />
    ) : mode.kind === "automate" ? (
      <AutomatePanel
        section={mode.section}
        onSection={(section) => setMode({ kind: "automate", section })}
      />
    ) : mode.kind === "settings" ? (
      <SettingsPanel
        section={mode.section}
        onSection={(section) => setMode({ kind: "settings", section })}
      />
    ) : null;

  const addContent =
    mode.kind === "settings" ? (
      <div className="flex min-w-0 flex-1 flex-col">
        <SettingsTabsMobile
          section={mode.section}
          onSection={(section) => setMode({ kind: "settings", section })}
        />
        <div className="min-h-0 flex-1">
          <SettingsPage
            section={mode.section}
            settings={settings}
            onSaved={setSettings}
            onImported={() => loadSidebar()}
          />
        </div>
      </div>
    ) : mode.kind === "automate" ? (
      <div className="flex min-w-0 flex-1 flex-col">
        <AutomateTabsMobile
          section={mode.section}
          onSection={(section) => setMode({ kind: "automate", section })}
        />
        <div className="min-h-0 flex-1">
          {mode.section === "rules" ? (
            <RulesPage
              key={`${mode.presetFeedId ?? ""}:${mode.presetFolderId ?? ""}`}
              sidebar={sidebar}
              onTagsChanged={loadSidebar}
              preset={
                mode.presetFeedId || mode.presetFolderId
                  ? { feedId: mode.presetFeedId, folderId: mode.presetFolderId }
                  : undefined
              }
            />
          ) : (
            <FiltersPage
              key={mode.presetFeedId ?? "all"}
              sidebar={sidebar}
              presetFeedId={mode.presetFeedId}
              onChanged={() => {
                loadSidebar();
                reloadList();
              }}
            />
          )}
        </div>
      </div>
    ) : mode.kind === "add" ? (
      <div className="flex min-w-0 flex-1 flex-col bg-bg">
        <AddTabsMobile
          tab={mode.tab}
          onTab={(tab) => setMode({ kind: "add", tab })}
        />
        <div className="min-h-0 flex-1">
          {mode.tab === "feed" && (
            <AddFeedPage
              sidebar={sidebar}
              defaultFolderId={scope.kind === "folder" ? scope.id : null}
              onAdded={async (feedId) => {
                await loadSidebar();
                select({ kind: "feed", id: feedId });
              }}
            />
          )}
          {mode.tab === "youtube" && (
            <YouTubePage
              sidebar={sidebar}
              defaultFolderId={scope.kind === "folder" ? scope.id : null}
              onAdded={async (feedId) => {
                await loadSidebar();
                select({ kind: "feed", id: feedId });
              }}
            />
          )}
          {mode.tab === "google-news" && (
            <GoogleNewsPage
              sidebar={sidebar}
              defaultFolderId={scope.kind === "folder" ? scope.id : null}
              onAdded={async (feedId) => {
                await loadSidebar();
                select({ kind: "feed", id: feedId });
              }}
            />
          )}
          {mode.tab === "monitor" && (
            <MonitorEditor
              key={mode.monitorId ?? "new"}
              sidebar={sidebar}
              monitorId={mode.monitorId}
              onSaved={async (id) => {
                await loadSidebar();
                select({ kind: "monitor", id });
                reloadList();
              }}
              onDeleted={async () => {
                await loadSidebar();
                select({ kind: "all" });
              }}
            />
          )}
          {mode.tab === "import" && (
            <ImportPage onImported={() => loadSidebar()} />
          )}
        </div>
      </div>
    ) : null;

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* Desktop: rail + sidebar */}
      <div className="hidden md:flex">
        {rail}
        {!sidebarCollapsed && (
          <>
            <div
              className="shrink-0 border-r border-line"
              style={{ width: sidebarWidth }}
            >
              {addPanel || sidebarPanel}
            </div>
            {splitter(
              startResize(sidebarWidth, setSidebarWidth, 200, 520),
              () => setSidebarWidth(340),
            )}
          </>
        )}
      </div>

      {/* Mobile: slide-over nav */}
      {(navOpen || drawerDrag !== null) && (
        <div
          className="fixed inset-0 z-40 md:hidden"
          onClick={() => setNavOpen(false)}
        >
          <div
            className="absolute inset-0 bg-black/40"
            style={{ opacity: drawerDrag ?? 1 }}
          />
          <div
            className={`relative flex h-full w-[min(380px,90vw)] shadow-pop ${drawerDrag === null ? "transition-transform duration-200" : ""}`}
            style={{
              transform: `translateX(${((drawerDrag ?? 1) - 1) * 100}%)`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {rail}
            <div className="min-w-0 flex-1">{sidebarPanel}</div>
          </div>
        </div>
      )}

      {addContent ?? (
        <>
          <div
            className="w-full shrink-0 border-r border-line md:w-[var(--list-w)]"
            style={{ "--list-w": `${listWidth}px` } as React.CSSProperties}
          >
            <ArticleList
              title={title}
              titleMenu={titleMenu}
              unread={scopeUnread}
              items={items}
              selectedId={selectedId}
              loading={loading}
              hasMore={hasMore}
              unreadOnly={effectiveUnreadOnly}
              layout={layout}
              showFeed={scope.kind !== "feed"}
              viewMenu={viewMenu}
              markMenu={markMenu}
              searchQuery={searchMode ? scope.q : null}
              newCount={newCount}
              onSearch={(q) => select({ kind: "search", q })}
              onCloseSearch={() => select({ kind: "all" })}
              onLoadMore={loadMore}
              onSelect={open}
              onToggleSave={toggleSave}
              onToggleRead={(a) => setRead(a, !a.isRead)}
              onMarkAllRead={() => markAllRead()}
              onShowAll={() => setUnreadOnly(false)}
              onReload={reloadAll}
              onOpenNav={() => setNavOpen(true)}
              emptyHint={
                noFeeds ? (
                  <div className="flex flex-col items-center gap-4">
                    <p className="text-muted">
                      You’re not following any feeds yet.
                    </p>
                    <button
                      type="button"
                      className={primaryButton}
                      onClick={() => openAdd()}
                    >
                      Add your first feed
                    </button>
                  </div>
                ) : scope.kind === "saved" ? (
                  <p className="text-muted">
                    Nothing saved yet. Use the bookmark icon to keep articles
                    for later.
                  </p>
                ) : scope.kind === "archive" ? (
                  <p className="text-muted">
                    The archive is empty. Archived articles are kept forever;
                    use the archive button above an article (or press e).
                  </p>
                ) : scope.kind === "tagged" || scope.kind === "tag" ? (
                  <p className="text-muted">
                    No tagged articles yet. Use the tag button above an article,
                    or an automation rule, to tag articles.
                  </p>
                ) : scope.kind === "monitor" ? (
                  <p className="text-muted">
                    No articles match this monitoring feed yet.
                  </p>
                ) : undefined
              }
            />
          </div>

          {splitter(startResize(listWidth, setListWidth, 280, 640), () =>
            setListWidth(380),
          )}

          <main
            className={`min-w-0 flex-1 ${selected ? "fixed inset-0 z-30 md:static" : "hidden md:block"}`}
          >
            {selected ? (
              <ArticleView
                key={selected.id}
                item={selected}
                settings={settings}
                tags={sidebar?.tags ?? []}
                onToggleSave={() => toggleSave(selected)}
                onToggleRead={() => setRead(selected, !selected.isRead)}
                onToggleArchive={() => toggleArchive(selected)}
                onTagsChanged={loadSidebar}
                onOpenTag={(id) => select({ kind: "tag", id })}
                onPrev={() => step(-1)}
                onNext={() => step(1)}
                onBack={() =>
                  articleInHistory()
                    ? window.history.back()
                    : setSelectedId(null)
                }
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-faint">
                {items.length ? "Select an article to read it" : ""}
              </div>
            )}
          </main>
        </>
      )}
      <ConfirmHost />
      {dialog?.kind === "feed-properties" && (
        <FeedPropertiesDialog
          key={dialog.feedId}
          feedId={dialog.feedId}
          initialTab={dialog.tab}
          folders={sidebar?.folders ?? []}
          onClose={() => setDialog(null)}
          onChanged={reloadAll}
          onUnfollow={(feed) => {
            // Close first so the confirmation isn't stacked on top of this dialog.
            setDialog(null);
            unfollowFeed(feed);
          }}
          onAutomate={(section) => {
            setDialog(null);
            setMode({ kind: "automate", section, presetFeedId: dialog.feedId });
          }}
        />
      )}
      {dialog?.kind === "rename-feed" && (
        <PromptDialog
          title="Rename feed"
          label="Title"
          initial={dialog.feed.title}
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            await api(`/api/feeds/${dialog.feed.id}`, {
              method: "PATCH",
              json: { title: v },
            });
            setDialog(null);
            reloadAll();
          }}
        />
      )}
      {dialog?.kind === "folder-properties" && (
        <FolderPropertiesDialog
          folder={dialog.folder}
          onClose={() => setDialog(null)}
          onChanged={loadSidebar}
        />
      )}
      {dialog?.kind === "delete-folder" && (
        <DeleteFolderDialog
          folder={dialog.folder}
          onClose={() => setDialog(null)}
          onDeleted={() => {
            const { folder } = dialog;
            setDialog(null);
            // Leave the folder's view, or one of its feeds' (they may have been deleted).
            if (
              (scope.kind === "folder" && scope.id === folder.id) ||
              (scope.kind === "feed" &&
                folder.feeds.some((f) => f.id === scope.id))
            )
              select({ kind: "all" });
            reloadAll();
          }}
        />
      )}
      {dialog?.kind === "tag" && (
        <TagDialog
          key={dialog.tag?.id ?? "new"}
          tag={dialog.tag}
          onClose={() => setDialog(null)}
          onDelete={dialog.tag ? () => deleteTag(dialog.tag!) : undefined}
          onSaved={(tag, keepOpen) => {
            if (!keepOpen) setDialog(null);
            loadSidebar();
            if (!dialog.tag) select({ kind: "tag", id: tag.id });
          }}
        />
      )}
      {dialog?.kind === "manage-tags" && (
        <ManageTagsDialog
          tags={sidebar?.tags ?? []}
          onClose={() => setDialog(null)}
          onNew={() => setDialog({ kind: "tag" })}
          onEdit={(tag) => setDialog({ kind: "tag", tag })}
          onDelete={deleteTag}
        />
      )}
      {dialog?.kind === "new-folder" && (
        <PromptDialog
          title="New folder"
          label="Name"
          initial=""
          confirmLabel="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            const { id } = await api<{ id: number }>("/api/folders", {
              method: "POST",
              json: { name: v },
            });
            if (dialog.moveFeedId)
              await api(`/api/feeds/${dialog.moveFeedId}`, {
                method: "PATCH",
                json: { folderId: id },
              });
            setDialog(null);
            loadSidebar();
          }}
        />
      )}
    </div>
  );
}
