"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bookmark,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleCheck,
  ExternalLink,
  FileText,
  Link2,
  Loader2,
  Mail,
  MoreHorizontal,
  RefreshCw,
  Sparkles,
  Tag as TagIcon,
  X,
} from "lucide-react";
import { api, hostname, timeAgo } from "@/lib/client";
import { isGoogleNewsLink } from "@/lib/googleNews";
import type {
  AppSettings,
  ArticleDetail,
  ArticleListItem,
  Tag,
  TagRef,
} from "@/lib/types";
import { TagPicker } from "./Tags";
import { AppLink, IconButton, Menu } from "./ui";

/** Render the model's markdown bullets as React nodes (no raw HTML from the LLM reaches the DOM). */
function SummaryText({ text }: { text: string }) {
  const inline = (s: string): ReactNode[] =>
    s
      .split(/(\*\*[^*]+\*\*)/g)
      .map((part, i) =>
        part.startsWith("**") && part.endsWith("**") ? (
          <strong key={i}>{part.slice(2, -2)}</strong>
        ) : (
          part
        ),
      );
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const bullets = lines.filter((l) => /^[-*•]\s+/.test(l));
  if (bullets.length && bullets.length >= lines.length - 1) {
    return (
      <ul className="list-disc space-y-1.5 pl-5">
        {lines.map((l, i) =>
          /^[-*•]\s+/.test(l) ? (
            <li key={i}>{inline(l.replace(/^[-*•]\s+/, ""))}</li>
          ) : (
            <p key={i} className="-ml-5">
              {inline(l)}
            </p>
          ),
        )}
      </ul>
    );
  }
  return (
    <div className="space-y-2">
      {lines.map((l, i) => (
        <p key={i}>{inline(l)}</p>
      ))}
    </div>
  );
}

/** Articles built from a YouTube video (see lib/youtube.ts) start with its embedded player. */
const isVideo = (html: string) => /^<iframe[^>]+youtube-nocookie\.com\/embed\//.test(html);

export function ArticleView({
  item,
  settings,
  tags,
  onToggleSave,
  onToggleRead,
  onToggleArchive,
  onTagsChanged,
  onOpenTag,
  onPrev,
  onNext,
  onBack,
}: {
  item: ArticleListItem;
  settings: AppSettings | null;
  /** Every tag, for the tag picker. */
  tags: Tag[];
  onToggleSave: () => void;
  onToggleRead: () => void;
  onToggleArchive: () => void;
  onTagsChanged: () => void;
  onOpenTag: (id: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onBack?: () => void;
}) {
  const [detail, setDetail] = useState<ArticleDetail | null>(null);
  const [showFull, setShowFull] = useState(false);
  const [fullState, setFullState] = useState<"idle" | "loading" | "error">(
    "idle",
  );
  const [fullError, setFullError] = useState("");
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryState, setSummaryState] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [summaryError, setSummaryError] = useState("");
  // A cached summary opens with the article; the toolbar button toggles it.
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [needKey, setNeedKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const summaryAbort = useRef<AbortController | null>(null);

  const id = item.id;
  const autoFullText = settings?.autoFullText ?? true;

  // The parent keys this component by article id, so state starts fresh for each article.
  useEffect(() => {
    let cancelled = false;
    api<ArticleDetail>(`/api/articles/${id}`).then((d) => {
      if (cancelled) return;
      setDetail(d);
      setSummary(d.summary);
      if (d.fullContent) setShowFull(true);
      // The feed only gave us a teaser: pull the full article automatically. YouTube items are
      // a player plus description; the watch page has nothing more to extract. Google News
      // links only redirect in a browser, so there's nothing to fetch from the server.
      else if ((autoFullText || d.feedAutoFullText) && d.url && d.contentLength < 600 && !isVideo(d.content) && !isGoogleNewsLink(d.url))
        loadFullText(d.id, () => cancelled);
    });
    return () => {
      cancelled = true;
      summaryAbort.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function loadFullText(
    articleId: number,
    isCancelled: () => boolean = () => false,
  ) {
    setFullState("loading");
    try {
      const { html } = await api<{ html: string }>(
        `/api/articles/${articleId}/fulltext`,
        { method: "POST" },
      );
      if (isCancelled()) return;
      setDetail((d) =>
        d && d.id === articleId ? { ...d, fullContent: html } : d,
      );
      setShowFull(true);
      setFullState("idle");
    } catch (e) {
      if (isCancelled()) return;
      setFullState("error");
      setFullError(e instanceof Error ? e.message : "Failed");
    }
  }

  function toggleFull() {
    if (!detail) return;
    if (showFull) setShowFull(false);
    else if (detail.fullContent) setShowFull(true);
    else loadFullText(detail.id);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "f" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (
        (e.target as HTMLElement).closest(
          "input, textarea, select, [role=dialog]",
        )
      )
        return;
      toggleFull();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function summarize() {
    if (!detail) return;
    summaryAbort.current?.abort();
    const ctrl = new AbortController();
    summaryAbort.current = ctrl;
    setSummary("");
    setSummaryState("loading");
    try {
      const res = await fetch(`/api/articles/${detail.id}/summarize`, {
        method: "POST",
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Summary failed (${res.status})`);
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += value;
        setSummary(text);
      }
      setSummaryState("idle");
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setSummaryState("error");
      setSummaryError(e instanceof Error ? e.message : "Summary failed");
      setSummary(null);
    }
  }

  /** Toolbar button: generate a summary, or show/hide the one already made. */
  function onSummarizeClick() {
    if (!hasKey) {
      setNeedKey((v) => !v);
      return;
    }
    if (summary) {
      setSummaryOpen((o) => !o);
      return;
    }
    setSummaryOpen(true);
    summarize();
  }

  async function copyLink() {
    if (!item.url) return;
    await navigator.clipboard.writeText(item.url).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const html = detail
    ? showFull && detail.fullContent
      ? detail.fullContent
      : detail.content
    : "";
  const showHero = !!item.imageUrl && !!detail && !/<(img|iframe)\b/i.test(html);
  const site = hostname(detail?.siteUrl ?? item.url);
  const hasKey = settings?.hasOpenRouterKey ?? false;

  return (
    <article className="relative flex h-full min-w-0 flex-col bg-bg">
      <div className="flex h-[52px] shrink-0 items-center gap-0.5 px-3 sm:px-8">
        {onBack && (
          <IconButton
            label="Back to list"
            onClick={onBack}
            className="md:hidden"
          >
            <ArrowLeft size={20} />
          </IconButton>
        )}
        <IconButton
          label={item.isSaved ? "Remove from Saved (s)" : "Save for later (s)"}
          onClick={onToggleSave}
          active={item.isSaved}
        >
          <Bookmark size={19} fill={item.isSaved ? "currentColor" : "none"} />
        </IconButton>
        <TagPicker
          articleId={id}
          allTags={tags}
          applied={detail?.tags ?? null}
          hasAiKey={hasKey}
          onApplied={(t: TagRef[]) =>
            setDetail((d) => (d ? { ...d, tags: t } : d))
          }
          onTagsChanged={onTagsChanged}
        />
        <IconButton
          label={item.isRead ? "Mark as unread (m)" : "Mark as read (m)"}
          onClick={onToggleRead}
        >
          {item.isRead ? <Circle size={19} /> : <CircleCheck size={19} />}
        </IconButton>
        <IconButton
          label={
            item.isArchived
              ? "Remove from Archive (e)"
              : "Move to Archive, kept forever (e)"
          }
          onClick={onToggleArchive}
          active={item.isArchived}
        >
          {item.isArchived ? (
            <ArchiveRestore size={19} />
          ) : (
            <Archive size={19} />
          )}
        </IconButton>
        <button
          type="button"
          onClick={toggleFull}
          disabled={!item.url}
          aria-pressed={showFull}
          title={
            showFull
              ? "Show the feed's version (f)"
              : "Load the full article (f)"
          }
          className={`inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm hover:bg-hover hover:text-fg disabled:opacity-40 ${
            showFull ? "text-accent" : "text-muted"
          }`}
        >
          {fullState === "loading" ? (
            <Loader2 size={18} className="animate-spin" />
          ) : (
            <FileText size={18} />
          )}
          <span className="hidden lg:inline">Full article</span>
        </button>
        <button
          type="button"
          onClick={onSummarizeClick}
          disabled={!detail}
          aria-pressed={summaryOpen && !!summary}
          title={
            !hasKey
              ? "Summarize with AI (needs an OpenRouter API key in Settings)"
              : summaryOpen && summary
                ? "Hide summary"
                : summary
                  ? "Show summary"
                  : "Summarize with AI"
          }
          className={`inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm hover:bg-hover hover:text-fg disabled:opacity-40 ${
            summaryOpen && summary ? "text-accent" : "text-muted"
          }`}
        >
          {summaryState === "loading" ? (
            <Loader2 size={18} className="animate-spin" />
          ) : (
            <Sparkles size={18} />
          )}
          <span className="hidden lg:inline">Summarize</span>
        </button>
        <Menu
          label="More"
          align="left"
          items={[
            {
              label: "Open original (v)",
              icon: <ExternalLink size={14} />,
              onSelect: () =>
                item.url && window.open(item.url, "_blank", "noopener"),
            },
            {
              label: copied ? "Copied!" : "Copy link",
              icon: <Link2 size={14} />,
              onSelect: copyLink,
            },
            {
              label: "Email link",
              icon: <Mail size={14} />,
              onSelect: () =>
                item.url &&
                (window.location.href = `mailto:?subject=${encodeURIComponent(item.title)}&body=${encodeURIComponent(item.url)}`),
            },
          ]}
          trigger={
            <span className="flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg">
              <MoreHorizontal size={19} />
            </span>
          }
        />
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[680px] px-5 pb-32 pt-6 sm:px-8">
          <h1 className="text-[28px] font-bold leading-[1.2] tracking-[-0.01em] sm:text-[32px]">
            {item.url ? (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-accent"
              >
                {item.title}
              </a>
            ) : (
              item.title
            )}
          </h1>
          {site && (
            <a
              href={detail?.siteUrl ?? item.url ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-block text-sm text-accent hover:underline"
            >
              {site}
            </a>
          )}
          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            <span>{item.feedTitle}</span>
            {item.author && <span>by {item.author}</span>}
            <span title={new Date(item.publishedAt).toLocaleString()}>
              {timeAgo(item.publishedAt)}
            </span>
          </p>
          {!!detail?.tags.length && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {detail.tags.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onOpenTag(t.id)}
                  className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-0.5 text-xs font-semibold text-muted hover:border-accent hover:text-accent"
                >
                  <TagIcon size={12} /> {t.name}
                </button>
              ))}
            </div>
          )}

          {needKey && (
            <p className="mt-6 flex items-start gap-2 rounded-md border border-line bg-sidebar px-4 py-3 text-sm text-muted">
              <Sparkles size={16} className="mt-0.5 shrink-0 text-accent" />
              <span>
                Summaries need an OpenRouter API key. Add one in{" "}
                <AppLink href="/settings/ai" className="text-accent underline">
                  Settings → AI summaries
                </AppLink>
                .
              </span>
            </p>
          )}
          {summaryState === "error" && (
            <p className="mt-6 text-sm text-danger">{summaryError}</p>
          )}
          {summaryOpen &&
            summary !== null &&
            (summary || summaryState === "loading") && (
              <div className="mt-6 rounded-lg border border-line bg-sidebar px-5 py-4 text-[15px] leading-relaxed">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-accent">
                  <Sparkles size={13} /> Summary
                  <span className="flex-1" />
                  <button
                    type="button"
                    title="Regenerate summary"
                    aria-label="Regenerate summary"
                    onClick={summarize}
                    disabled={summaryState === "loading"}
                    className="rounded p-1 text-muted hover:bg-hover hover:text-fg disabled:opacity-40"
                  >
                    <RefreshCw
                      size={14}
                      className={
                        summaryState === "loading" ? "animate-spin" : ""
                      }
                    />
                  </button>
                  <button
                    type="button"
                    title="Hide summary"
                    aria-label="Hide summary"
                    onClick={() => setSummaryOpen(false)}
                    className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
                  >
                    <X size={14} />
                  </button>
                </div>
                {summary ? (
                  <SummaryText text={summary} />
                ) : (
                  <p className="text-muted">Thinking…</p>
                )}
              </div>
            )}

          {showHero && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.imageUrl!}
              alt=""
              referrerPolicy="no-referrer"
              className="mt-6 w-full rounded-md object-cover"
            />
          )}

          {fullState === "error" && (
            <p className="mt-6 rounded-md border border-line bg-sidebar px-4 py-3 text-sm text-muted">
              Couldn’t load the full article ({fullError}). Showing the feed’s
              content instead.
            </p>
          )}
          {fullState === "loading" && !showFull && (
            <p className="mt-6 flex items-center gap-2 text-sm text-muted">
              <Loader2 size={14} className="animate-spin" /> Loading full
              article…
            </p>
          )}

          {detail ? (
            <div
              className="article-body mt-6"
              dangerouslySetInnerHTML={{
                __html:
                  html ||
                  "<p><em>This item has no content. Open the original to read it.</em></p>",
              }}
            />
          ) : (
            <div className="mt-8 space-y-3">
              {[90, 100, 95, 70].map((w, i) => (
                <div
                  key={i}
                  className="h-4 animate-pulse rounded bg-hover"
                  style={{ width: `${w}%` }}
                />
              ))}
            </div>
          )}

          {item.url && detail && (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-10 inline-flex items-center gap-2 rounded-md border border-line px-4 py-2 text-sm font-semibold hover:bg-hover"
            >
              Visit website <ExternalLink size={15} />
            </a>
          )}
        </div>
      </div>

      <div className="absolute bottom-5 right-5 flex flex-col gap-2">
        <button
          type="button"
          title="Previous article (k)"
          onClick={onPrev}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-elevated text-fg shadow-pop hover:bg-hover"
        >
          <ChevronUp size={22} />
        </button>
        <button
          type="button"
          title="Next article (j)"
          onClick={onNext}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-elevated text-fg shadow-pop hover:bg-hover"
        >
          <ChevronDown size={22} />
        </button>
      </div>
    </article>
  );
}
