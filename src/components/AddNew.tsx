"use client";

import { useEffect, useState } from "react";
import { FileInput, Loader2, Newspaper, Rss, ScanSearch, Search, TvMinimalPlay, X } from "lucide-react";
import { api, readStored, timeAgo, writeStored } from "@/lib/client";
import { GOOGLE_NEWS_EDITIONS, GOOGLE_NEWS_ICON, defaultEdition } from "@/lib/googleNews";
import type { GoogleNewsPreview, Sidebar } from "@/lib/types";
import { OpmlTools } from "./Dialogs";
import { FeedIcon, inputClass, primaryButton } from "./ui";

export type AddTab = "feed" | "youtube" | "google-news" | "monitor" | "import";

const TABS: { id: AddTab; label: string; icon: React.ReactNode }[] = [
  { id: "feed", label: "Web feed", icon: <Rss size={17} /> },
  { id: "youtube", label: "YouTube", icon: <TvMinimalPlay size={17} /> },
  { id: "google-news", label: "Google News", icon: <Newspaper size={17} /> },
  { id: "monitor", label: "Monitoring feed", icon: <ScanSearch size={17} /> },
  { id: "import", label: "Import feeds", icon: <FileInput size={17} /> },
];

/** Takes the sidebar's place while adding something. */
export function AddPanel({ tab, onTab }: { tab: AddTab; onTab: (t: AddTab) => void }) {
  return (
    <aside className="flex h-full w-full flex-col bg-sidebar">
      <header className="flex h-12 shrink-0 items-center px-4 pt-1">
        <h2 className="text-[15px] font-bold">Add new</h2>
      </header>
      <nav className="pt-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onTab(t.id)}
            className={`mx-2 flex h-9 w-[calc(100%-1rem)] items-center gap-3 rounded-md px-3 text-[14px] ${
              tab === t.id ? "bg-active font-bold text-accent" : "text-fg hover:bg-hover"
            }`}
          >
            <span className="text-muted">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </nav>
    </aside>
  );
}

/** Tab strip shown instead of the panel on small screens. */
export function AddTabsMobile({ tab, onTab }: { tab: AddTab; onTab: (t: AddTab) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-line px-2 py-2 md:hidden">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onTab(t.id)}
          className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm ${tab === t.id ? "bg-active font-bold text-accent" : "text-muted"}`}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Folder picker shared by the add pages; "new" shows a name field. */
function useFolderField(sidebar: Sidebar | null, defaultFolderId: number | null) {
  const [folder, setFolder] = useState<string>(defaultFolderId ? String(defaultFolderId) : "");
  const [newFolder, setNewFolder] = useState("");
  const field = (
    <>
      <label className="block">
        <span className="mb-1.5 block text-sm font-semibold">Folder</span>
        <select value={folder} onChange={(e) => setFolder(e.target.value)} className={inputClass}>
          <option value="">No folder</option>
          {sidebar?.folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
          <option value="new">+ New folder…</option>
        </select>
      </label>
      {folder === "new" && <input value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="Folder name" className={inputClass} required />}
    </>
  );
  /** The chosen folder's id, creating the new folder first if needed. */
  const resolve = async (): Promise<number | null> => {
    if (folder === "new" && newFolder.trim()) return (await api<{ id: number }>("/api/folders", { method: "POST", json: { name: newFolder } })).id;
    return folder && folder !== "new" ? Number(folder) : null;
  };
  return { field, resolve };
}

type AddPageProps = {
  sidebar: Sidebar | null;
  defaultFolderId: number | null;
  onAdded: (feedId: number) => void;
};

function useAddFeed(onAdded: (feedId: number) => void) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const add = async (folderId: () => Promise<number | null>, json: Record<string, unknown>, fallback: string) => {
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ feed: { id: number } }>("/api/feeds", { method: "POST", json: { ...json, folderId: await folderId() } });
      onAdded(r.feed.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : fallback);
      setBusy(false);
    }
  };
  return { busy, err, add };
}

export function AddFeedPage({ sidebar, defaultFolderId, onAdded }: AddPageProps) {
  const [url, setUrl] = useState("");
  const folder = useFolderField(sidebar, defaultFolderId);
  const { busy, err, add } = useAddFeed(onAdded);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[560px] px-6 py-6 sm:px-8">
        <h1 className="mb-6 text-[17px] font-bold">Follow a website or feed</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add(folder.resolve, { url }, "Could not add feed");
          }}
          className="space-y-4"
        >
          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold">Website or feed URL</span>
            <input autoFocus required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="e.g. hackaday.com or https://example.com/feed.xml" className={inputClass} />
            <span className="mt-1.5 block text-xs text-muted">Paste a site address and Stitch will find its RSS or Atom feed.</span>
          </label>
          {folder.field}
          {err && <p className="text-sm text-danger">{err}</p>}
          <button type="submit" disabled={busy} className={`${primaryButton} w-full py-2.5`}>
            {busy && <Loader2 size={15} className="animate-spin" />} {busy ? "Finding feed…" : "Follow"}
          </button>
        </form>
      </div>
    </div>
  );
}

export function YouTubePage({ sidebar, defaultFolderId, onAdded }: AddPageProps) {
  const [input, setInput] = useState("");
  const folder = useFolderField(sidebar, defaultFolderId);
  const { busy, err, add } = useAddFeed(onAdded);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[560px] px-6 py-6 sm:px-8">
        <h1 className="mb-6 text-[17px] font-bold">Follow a YouTube channel or playlist</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add(folder.resolve, { url: input, source: "youtube" }, "Could not add the channel or playlist");
          }}
          className="space-y-4"
        >
          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold">Channel or playlist</span>
            <input
              autoFocus
              required
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="e.g. @veritasium or a youtube.com link"
              className={inputClass}
            />
            <span className="mt-1.5 block text-xs leading-relaxed text-muted">
              A channel link or <code>@handle</code>, a playlist or show link (or a video link with <code>list=</code>), or a channel or playlist ID. New
              videos arrive as articles with the player and description. YouTube’s feeds list the newest 15 videos, so older ones in a long
              playlist don’t appear. How long read videos are kept is set under Settings → General.
            </span>
          </label>
          {folder.field}
          {err && <p className="text-sm text-danger">{err}</p>}
          <button type="submit" disabled={busy} className={`${primaryButton} w-full py-2.5`}>
            {busy && <Loader2 size={15} className="animate-spin" />} {busy ? "Finding the channel…" : "Follow"}
          </button>
        </form>
      </div>
    </div>
  );
}

const SEARCH_TIPS: { hint: string; example: string }[] = [
  { hint: "Use quotes for an exact match of names", example: '"Nikola Tesla"' },
  { hint: "Use intitle: to search for keywords in titles", example: 'intitle:"electric vehicles"' },
  { hint: "Use a minus sign to exclude keywords", example: '"Nikola Tesla" -experiment' },
  { hint: "Use OR to match any of several keywords", example: '"Nikola Tesla" OR "Thomas Edison"' },
  { hint: "Use site: to search one news site", example: "climate site:nos.nl" },
  { hint: "Use when: to limit results to recent news", example: "spacex when:7d" },
];

/** Search Google News, preview the newest results, and follow the search as a feed. */
export function GoogleNewsPage({ sidebar, defaultFolderId, onAdded }: AddPageProps) {
  const [query, setQuery] = useState("");
  const [edition, setEdition] = useState(() => readStored("googleNewsEdition", defaultEdition(navigator.language)));
  const [preview, setPreview] = useState<{ key: string; data?: GoogleNewsPreview; error?: string } | null>(null);
  const folder = useFolderField(sidebar, defaultFolderId);
  const { busy, err, add } = useAddFeed(onAdded);

  const q = query.trim();
  const key = `${edition}|${q}`;
  // Only show the preview for the current search; anything else is still loading.
  const current = q && preview?.key === key ? preview : null;

  useEffect(() => {
    if (!q) return;
    const timer = setTimeout(() => {
      api<GoogleNewsPreview>(`/api/google-news?${new URLSearchParams({ q, edition })}`)
        .then((data) => setPreview({ key, data }))
        .catch((e) => setPreview({ key, error: e instanceof Error ? e.message : "Could not reach Google News" }));
    }, 500);
    return () => clearTimeout(timer);
  }, [q, edition, key]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[760px] px-6 py-6 sm:px-8">
        <h1 className="mb-6 text-[17px] font-bold">Follow a Google News search</h1>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type to begin your search"
              className={`${inputClass} py-2.5 pl-10 pr-9`}
              aria-label="Google News search"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-fg"
              >
                <X size={16} />
              </button>
            )}
          </div>
          <select
            value={edition}
            onChange={(e) => {
              setEdition(e.target.value);
              writeStored("googleNewsEdition", e.target.value);
            }}
            className={`${inputClass} sm:w-56`}
            aria-label="Language and region"
          >
            {GOOGLE_NEWS_EDITIONS.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </div>

        {!q && (
          <section className="mt-8">
            <h2 className="mb-4 text-[17px] font-bold">Search smarter</h2>
            <ul className="space-y-4">
              {SEARCH_TIPS.map((t) => (
                <li key={t.example}>
                  <p className="mb-1.5 text-xs text-muted">{t.hint}</p>
                  <button
                    type="button"
                    onClick={() => setQuery(t.example)}
                    className="rounded-md border border-line bg-bg px-3 py-1.5 font-mono text-[13px] hover:border-accent hover:text-accent"
                  >
                    {t.example}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {q && (
          <section className="mt-6">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                add(folder.resolve, { url: q, source: "google-news", edition }, "Could not follow the search");
              }}
              className="flex flex-col gap-4 rounded-lg border border-line p-4 sm:flex-row sm:items-start"
            >
              <FeedIcon src={GOOGLE_NEWS_ICON} title="Google News" size={40} />
              <div className="min-w-0 flex-1 space-y-3">
                <div>
                  <h2 className="truncate text-[17px] font-bold">{q}</h2>
                  <p className="text-sm text-muted">New results for this search arrive as articles.</p>
                </div>
                {folder.field}
                {err && <p className="text-sm text-danger">{err}</p>}
              </div>
              <button type="submit" disabled={busy} className={primaryButton}>
                {busy && <Loader2 size={15} className="animate-spin" />} Follow
              </button>
            </form>

            {!current && (
              <div className="flex justify-center py-10 text-muted">
                <Loader2 size={20} className="animate-spin" />
              </div>
            )}
            {current?.error && <p className="py-6 text-sm text-danger">{current.error}</p>}
            {current?.data && !current.data.items.length && <p className="py-6 text-sm text-muted">No recent news matches this search.</p>}
            {current?.data && current.data.items.length > 0 && (
              <ul className="mt-2">
                {current.data.items.map((it, i) => (
                  <li key={i} className="border-b border-line py-4">
                    {it.url ? (
                      <a href={it.url} target="_blank" rel="noreferrer" className="font-semibold hover:text-accent">
                        {it.title}
                      </a>
                    ) : (
                      <span className="font-semibold">{it.title}</span>
                    )}
                    <p className="mt-1 text-xs text-muted">
                      {[it.source, it.publishedAt && timeAgo(it.publishedAt)].filter(Boolean).join(" · ")}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

export function ImportPage({ onImported }: { onImported: () => void }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[560px] px-6 py-6 sm:px-8">
        <h1 className="mb-6 text-[17px] font-bold">Import feeds</h1>
        <OpmlTools onImported={onImported} />
      </div>
    </div>
  );
}
