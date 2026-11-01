"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  Check,
  CheckCircle2,
  Copy,
  Filter as FilterIcon,
  ListChecks,
  Loader2,
  Pencil,
  RefreshCw,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { api, timeAgo } from "@/lib/client";
import type { FeedFetch, FeedProperties, SidebarFolder } from "@/lib/types";
import { describeAutomations } from "./Dialogs";
import { Dialog, FeedIcon, inputClass, primaryButton, secondaryButton } from "./ui";

export type FeedPropertiesTab = "about" | "automations" | "log";

const TABS: { id: FeedPropertiesTab; label: string }[] = [
  { id: "about", label: "About" },
  { id: "automations", label: "Automations" },
  { id: "log", label: "Refresh log" },
];

/** "14:09" today, "Oct 20, 14:09" on other days. */
function when(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

function outcome(f: Pick<FeedFetch, "status" | "error" | "attempts">): { ok: boolean; label: string } {
  const tries = f.attempts > 1 ? ` after ${f.attempts} attempts` : "";
  if (f.error) return { ok: false, label: `${f.error}${tries}` };
  if (f.status === 304) return { ok: true, label: `Success – Not modified (304)${tries}` };
  return { ok: true, label: `Success (${f.status ?? "OK"})${tries}` };
}

function StatusIcon({ ok, label }: { ok: boolean; label: string }) {
  return ok ? (
    <CheckCircle2 size={17} className="shrink-0 text-accent" aria-label={label} />
  ) : (
    <XCircle size={17} className="shrink-0 text-danger" aria-label={label} />
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy"
      onClick={async () => {
        await navigator.clipboard.writeText(value).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg"
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
    </button>
  );
}

function Field({ label, hint, action, children }: { label: string; hint?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-line py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
        <div className="mt-1 break-words text-sm">{children}</div>
      </div>
      {action}
    </div>
  );
}

/**
 * Feed details (addresses, folder, activity, last refresh), the rules and filters that target it,
 * and its refresh log. `onChanged` reloads the sidebar and lists after a rename, move or refresh.
 */
export function FeedPropertiesDialog({
  feedId,
  initialTab = "about",
  folders,
  onClose,
  onChanged,
  onUnfollow,
  onAutomate,
}: {
  feedId: number;
  initialTab?: FeedPropertiesTab;
  folders: SidebarFolder[];
  onClose: () => void;
  onChanged: () => void;
  onUnfollow: (feed: { id: number; title: string }) => void;
  onAutomate: (section: "rules" | "filters") => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [props, setProps] = useState<FeedProperties | null>(null);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [savingFullText, setSavingFullText] = useState(false);

  const load = () =>
    api<FeedProperties>(`/api/feeds/${feedId}/properties`)
      .then(setProps)
      .catch((e) => setErr(e instanceof Error ? e.message : "Could not load feed"));

  useEffect(() => {
    load();
    // load only depends on feedId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedId]);

  const patch = async (json: Record<string, unknown>) => {
    await api(`/api/feeds/${feedId}`, { method: "PATCH", json });
    await load();
    onChanged();
  };

  async function saveTitle() {
    const title = editing?.trim();
    setEditing(null);
    if (title && title !== props?.title) await patch({ title }).catch(() => {});
  }

  async function saveAutoFullText(autoFullText: boolean) {
    setSavingFullText(true);
    setErr("");
    try {
      await patch({ autoFullText });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save full article setting");
    } finally {
      setSavingFullText(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await api("/api/refresh", { method: "POST", json: { feedId } });
      await load();
      onChanged();
    } finally {
      setRefreshing(false);
    }
  }

  const header = (
    <div className="relative mb-5 flex items-start gap-4 pr-10">
      <FeedIcon src={props?.iconUrl ?? null} title={props?.title ?? ""} size={52} />
      <div className="min-w-0 flex-1">
        {editing !== null ? (
          <input
            autoFocus
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveTitle();
              if (e.key === "Escape") {
                // Cancel the rename without closing the dialog.
                e.stopPropagation();
                setEditing(null);
              }
            }}
            className={`${inputClass} text-lg font-bold`}
            aria-label="Feed title"
          />
        ) : (
          <div className="flex items-center gap-2">
            <h2 className="min-w-0 truncate text-xl font-bold">{props?.title ?? "Feed properties"}</h2>
            {props && (
              <button
                type="button"
                title="Rename"
                onClick={() => setEditing(props.title)}
                className="rounded-md p-1 text-muted hover:bg-hover hover:text-fg"
              >
                <Pencil size={16} />
              </button>
            )}
          </div>
        )}
        {props && (
          <p className="mt-1 text-sm text-muted">
            {props.articles} article{props.articles === 1 ? "" : "s"} &nbsp;|&nbsp; {props.postsThisWeek} post
            {props.postsThisWeek === 1 ? "" : "s"} this week
          </p>
        )}
      </div>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute -right-2 -top-2 rounded-full bg-hover p-2 text-muted hover:text-fg"
      >
        <X size={18} />
      </button>
    </div>
  );

  const last = props?.log[0];
  const lastOutcome = props && (last ? outcome(last) : props.lastError ? { ok: false, label: props.lastError } : null);

  return (
    <Dialog title={props?.title ?? "Feed properties"} onClose={onClose} width={640} header={header}>
      <div>
        <div role="tablist" className="mb-2 flex gap-5 border-b border-line text-sm">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px border-b-2 pb-2 ${tab === t.id ? "border-accent text-accent" : "border-transparent text-muted hover:text-fg"}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {err && <p className="py-6 text-sm text-danger">{err}</p>}
        {!props && !err && (
          <div className="flex justify-center py-10 text-muted">
            <Loader2 size={20} className="animate-spin" />
          </div>
        )}

        {props && tab === "about" && (
          <div>
            {props.siteUrl && (
              <Field label="Website" action={<CopyButton value={props.siteUrl} />}>
                <a href={props.siteUrl} target="_blank" rel="noreferrer" className="hover:text-accent hover:underline">
                  {props.siteUrl}
                </a>
              </Field>
            )}
            <Field label="Feed address" action={<CopyButton value={props.feedUrl} />}>
              <a href={props.feedUrl} target="_blank" rel="noreferrer" className="hover:text-accent hover:underline">
                {props.feedUrl}
              </a>
            </Field>
            <Field label="Date followed">
              {new Date(props.createdAt).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })}
            </Field>
            <Field label="Folder">
              <select
                value={props.folderId ?? ""}
                onChange={(e) => patch({ folderId: e.target.value ? Number(e.target.value) : null }).catch(() => {})}
                className={`${inputClass} mt-0.5 max-w-xs`}
              >
                <option value="">No folder</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Last post">
              {props.lastPostAt ? (
                <span title={new Date(props.lastPostAt).toLocaleString()}>{timeAgo(props.lastPostAt)} ago</span>
              ) : (
                <span className="text-muted">No articles</span>
              )}
            </Field>
            <Field label="Articles">
              {props.articles} stored, {props.unread} unread
            </Field>
            <Field label="Update interval" hint="Every feed refreshes on the interval set in Settings.">
              Every {props.refreshIntervalMinutes} min
            </Field>
            <label className="flex items-start gap-3 border-b border-line py-3">
              <input
                type="checkbox"
                checked={props.autoFullText}
                disabled={savingFullText}
                onChange={(e) => saveAutoFullText(e.target.checked)}
                className="mt-1 h-4 w-4 accent-[var(--accent)] disabled:opacity-50"
              />
              <span className="text-sm">
                <span className="font-semibold">Auto fetch article</span>
                <span className="mt-0.5 block text-xs text-muted">
                  Load the full article when you open a short teaser. The global setting enables this for all feeds.
                </span>
              </span>
            </label>
            <Field
              label="Last refreshed"
              action={
                <span className="flex">
                  <button
                    type="button"
                    title="Refresh now"
                    disabled={refreshing}
                    onClick={refresh}
                    className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg disabled:opacity-50"
                  >
                    <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
                  </button>
                  <button
                    type="button"
                    title="Refresh log"
                    onClick={() => setTab("log")}
                    className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg"
                  >
                    <ListChecks size={16} />
                  </button>
                </span>
              }
            >
              {props.lastFetchedAt ? (
                <span className="flex items-center gap-2">
                  {when(props.lastFetchedAt)}
                  {lastOutcome && (
                    <>
                      <StatusIcon {...lastOutcome} />
                      <span className={`font-semibold ${lastOutcome.ok ? "text-accent" : "text-danger"}`}>{lastOutcome.label}</span>
                    </>
                  )}
                </span>
              ) : (
                <span className="text-muted">Never</span>
              )}
            </Field>
          </div>
        )}

        {props && tab === "automations" && (
          <div className="py-3 text-sm">
            {describeAutomations(props.automations) ? (
              <>
                {props.automations.rules.length > 0 && (
                  <>
                    <h3 className="mb-2 font-semibold">Rules</h3>
                    <ul className="mb-4 space-y-1.5">
                      {props.automations.rules.map((r) => (
                        <li key={r.id} className="flex items-center gap-2">
                          <Zap size={14} className="text-muted" /> {r.name}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {props.automations.filters > 0 && (
                  <p className="mb-4 flex items-center gap-2">
                    <FilterIcon size={14} className="text-muted" />
                    {props.automations.filters === 1 ? "1 filter" : `${props.automations.filters} filters`} hide articles in this feed.
                  </p>
                )}
              </>
            ) : (
              <p className="mb-4 text-muted">No rules or filters target this feed. Rules and filters for all feeds or its folder still apply.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => onAutomate("rules")} className={secondaryButton}>
                <Zap size={15} /> Create rule…
              </button>
              <button type="button" onClick={() => onAutomate("filters")} className={secondaryButton}>
                <FilterIcon size={15} /> Filter articles…
              </button>
            </div>
          </div>
        )}

        {props && tab === "log" && (
          <div className="py-2">
            {props.log.length ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left font-semibold">
                    <th className="py-2 pr-3">Refreshed</th>
                    <th className="py-2 pr-3 text-right">Latency</th>
                    <th className="py-2 pr-3 text-right">New articles</th>
                    <th className="py-2 text-center">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {props.log.map((f) => {
                    const o = outcome(f);
                    return (
                      <tr key={f.id} className="border-t border-line align-top even:bg-hover/40">
                        <td className="py-2.5 pr-3 tabular-nums">
                          {when(f.fetchedAt)}
                          {!o.ok && <div className="mt-0.5 text-xs text-danger">{o.label}</div>}
                          {o.ok && f.attempts > 1 && <div className="mt-0.5 text-xs text-muted">After {f.attempts} attempts</div>}
                        </td>
                        <td className="py-2.5 pr-3 text-right tabular-nums">{(f.durationMs / 1000).toFixed(3)} s</td>
                        <td className="py-2.5 pr-3 text-right tabular-nums">{f.newArticles}</td>
                        <td className="py-2.5" title={o.label}>
                          <span className="flex items-center justify-center gap-1.5 text-xs text-muted">
                            <StatusIcon {...o} />
                            {f.status ?? "—"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="py-4 text-sm text-muted">No refreshes logged yet.</p>
            )}
          </div>
        )}
      </div>

      <div className="mt-6 flex justify-between gap-2">
        <button
          type="button"
          disabled={!props}
          onClick={() => props && onUnfollow({ id: props.id, title: props.title })}
          className={secondaryButton.replace("text-fg", "text-danger")}
        >
          Unfollow
        </button>
        <button type="button" autoFocus onClick={onClose} className={primaryButton}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
