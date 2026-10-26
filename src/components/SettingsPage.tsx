"use client";

import { useState, type ReactNode } from "react";
import {
  Bell,
  Check,
  FileInput,
  Keyboard,
  Loader2,
  RotateCcw,
  LogOut,
  Send,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { api } from "@/lib/client";
import type { AppSettings, CredentialName } from "@/lib/types";
import { OpmlTools } from "./Dialogs";
import { inputClass, primaryButton, secondaryButton } from "./ui";

export type SettingsSection =
  "general" | "ai" | "notifications" | "import" | "shortcuts";

export const SETTINGS_SECTIONS: {
  id: SettingsSection;
  label: string;
  icon: ReactNode;
  description: string;
}[] = [
  {
    id: "general",
    label: "General",
    icon: <SlidersHorizontal size={17} />,
    description:
      "How often feeds refresh, how long articles are kept, and full-text loading.",
  },
  {
    id: "ai",
    label: "AI summaries",
    icon: <Sparkles size={17} />,
    description:
      "OpenRouter API key and the model used by the Summarize button.",
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: <Bell size={17} />,
    description: "SendGrid and Pushover credentials used by rules.",
  },
  {
    id: "import",
    label: "Import & export",
    icon: <FileInput size={17} />,
    description: "Move your subscriptions between readers with OPML.",
  },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    icon: <Keyboard size={17} />,
    description: "Keys for reading without the mouse.",
  },
];

export function SettingsPanel({
  section,
  onSection,
}: {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
}) {
  return (
    <aside className="flex h-full w-full flex-col bg-sidebar">
      <header className="flex h-12 shrink-0 items-center px-4 pt-1">
        <h2 className="text-[15px] font-bold">Settings</h2>
      </header>
      <nav className="space-y-1 overflow-y-auto pb-4">
        {SETTINGS_SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onSection(s.id)}
            className={`mx-2 block w-[calc(100%-1rem)] rounded-md px-3 py-3 text-left ${section === s.id ? "bg-active" : "hover:bg-hover"}`}
          >
            <span
              className={`flex items-center gap-2 text-[14px] font-bold ${section === s.id ? "text-accent" : "text-fg"}`}
            >
              {s.icon} {s.label}
            </span>
            <span className="mt-1 block pl-[25px] text-[13px] leading-snug text-muted">
              {s.description}
            </span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

export function SettingsTabsMobile({
  section,
  onSection,
}: {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
}) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-line px-2 py-2 md:hidden">
      {SETTINGS_SECTIONS.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => onSection(s.id)}
          className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm ${section === s.id ? "bg-active font-bold text-accent" : "text-muted"}`}
        >
          {s.icon} {s.label}
        </button>
      ))}
    </div>
  );
}

function Card({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-elevated p-5">
      <h2 className="text-[15px] font-bold">{title}</h2>
      {description && (
        <p className="mt-1 text-[13px] leading-relaxed text-muted">
          {description}
        </p>
      )}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function Saved({ show }: { show: boolean }) {
  return show ? (
    <span className="inline-flex items-center gap-1 text-sm text-accent">
      <Check size={15} /> Saved
    </span>
  ) : null;
}

type CredentialFieldDef = {
  name: CredentialName;
  label: string;
  placeholder: string;
  help?: ReactNode;
  secret?: boolean;
};

/**
 * Credential inputs. The server never returns secrets, so each field starts empty and shows
 * whether a value is set; typing a new value and saving replaces it.
 */
function CredentialFields({
  fields,
  settings,
  onSaved,
  extra,
}: {
  fields: CredentialFieldDef[];
  settings: AppSettings;
  onSaved: (s: AppSettings) => void;
  extra?: ReactNode;
}) {
  const [values, setValues] = useState<Partial<Record<CredentialName, string>>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);

  const save = async (
    patch: Partial<Record<CredentialName, string | null>>,
  ) => {
    setBusy(true);
    setErr("");
    setSaved(false);
    try {
      onSaved(
        await api<AppSettings>("/api/settings", {
          method: "PUT",
          json: { credentials: patch },
        }),
      );
      setValues({});
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  const dirty = Object.values(values).some((v) => v?.trim());

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const patch = Object.fromEntries(
          Object.entries(values).filter(([, v]) => v?.trim()),
        );
        if (Object.keys(patch).length) save(patch);
      }}
      className="space-y-4"
    >
      {fields.map((f) => {
        const st = settings.credentials[f.name];
        return (
          <label key={f.name} className="block">
            <span className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-semibold">
              {f.label}
              <span className="text-xs font-normal text-muted">
                {st.source === "settings" && (
                  <>
                    Saved
                    {f.secret !== false ? (
                      <> · ends in {st.preview?.slice(1)}</>
                    ) : (
                      <> · {st.preview}</>
                    )}
                  </>
                )}
                {st.source === "env" && (
                  <>
                    From .env
                    {f.secret !== false ? (
                      <> · ends in {st.preview?.slice(1)}</>
                    ) : (
                      <> · {st.preview}</>
                    )}{" "}
                    · saving here overrides it
                  </>
                )}
                {!st.set && <span className="text-danger">Not set</span>}
              </span>
              {st.source === "settings" && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    save({ [f.name]: null });
                  }}
                  className="text-xs font-normal text-muted underline hover:text-danger"
                >
                  Remove
                </button>
              )}
            </span>
            <input
              type={f.secret === false ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              value={values[f.name] ?? ""}
              onChange={(e) =>
                setValues((v) => ({ ...v, [f.name]: e.target.value }))
              }
              placeholder={
                st.set
                  ? f.secret === false
                    ? "Enter a new value to replace it"
                    : "Paste a new key to replace it"
                  : f.placeholder
              }
              className={`${inputClass} font-mono`}
            />
            {f.help && (
              <span className="mt-1.5 block text-xs leading-relaxed text-muted">
                {f.help}
              </span>
            )}
          </label>
        );
      })}
      {err && <p className="text-sm text-danger">{err}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy || !dirty}
          className={primaryButton}
        >
          {busy && <Loader2 size={15} className="animate-spin" />} Save
        </button>
        <Saved show={saved && !dirty} />
        {extra}
      </div>
    </form>
  );
}

function TestButton({
  label,
  run,
}: {
  label: string;
  run: () => Promise<void>;
}) {
  const [state, setState] = useState<{
    status: "idle" | "busy" | "ok" | "error";
    msg?: string;
  }>({ status: "idle" });
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={state.status === "busy"}
        onClick={async () => {
          setState({ status: "busy" });
          try {
            await run();
            setState({ status: "ok" });
          } catch (e) {
            setState({
              status: "error",
              msg: e instanceof Error ? e.message : "Failed",
            });
          }
        }}
        className={secondaryButton}
      >
        {state.status === "busy" ? (
          <Loader2 size={15} className="animate-spin" />
        ) : (
          <Send size={15} />
        )}{" "}
        {label}
      </button>
      {state.status === "ok" && (
        <span className="text-sm text-accent">
          Sent. Check your inbox or phone.
        </span>
      )}
      {state.status === "error" && (
        <span className="text-sm text-danger">{state.msg}</span>
      )}
    </span>
  );
}

function GeneralSection({
  settings,
  onSaved,
}: {
  settings: AppSettings;
  onSaved: (s: AppSettings) => void;
}) {
  const [form, setForm] = useState({
    refreshIntervalMinutes: settings.refreshIntervalMinutes,
    retentionDays: settings.retentionDays,
    youtubeRetentionDays: settings.youtubeRetentionDays,
    autoFullText: settings.autoFullText,
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const logout = async () => {
    await fetch("/api/login", { method: "DELETE" });
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload so the auth cookie applies
    window.location.assign("/login");
  };

  return (
    <>
      <Card title="Reading & refresh">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setSaved(false);
            try {
              onSaved(
                await api<AppSettings>("/api/settings", {
                  method: "PUT",
                  json: form,
                }),
              );
              setSaved(true);
            } finally {
              setBusy(false);
            }
          }}
          className="space-y-5"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-sm font-semibold">
                Refresh feeds every (minutes)
              </span>
              <input
                type="number"
                min={5}
                value={form.refreshIntervalMinutes}
                onChange={(e) => (
                  setSaved(false),
                  setForm({
                    ...form,
                    refreshIntervalMinutes: Number(e.target.value),
                  })
                )}
                className={inputClass}
              />
              <span className="mt-1 block text-xs text-muted">Minimum 5.</span>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-semibold">
                Keep read articles for (days)
              </span>
              <input
                type="number"
                min={0}
                value={form.retentionDays}
                onChange={(e) => (
                  setSaved(false),
                  setForm({ ...form, retentionDays: Number(e.target.value) })
                )}
                className={inputClass}
              />
              <span className="mt-1 block text-xs text-muted">
                0 keeps everything. Saved, archived and tagged articles are
                never removed. A new feed starts with everything it lists.
              </span>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-semibold">
                Keep read YouTube videos for (days)
              </span>
              <input
                type="number"
                min={0}
                value={form.youtubeRetentionDays}
                onChange={(e) => (
                  setSaved(false),
                  setForm({
                    ...form,
                    youtubeRetentionDays: Number(e.target.value),
                  })
                )}
                className={inputClass}
              />
              <span className="mt-1 block text-xs text-muted">
                For YouTube channels and playlists. 0 keeps every video.
              </span>
            </label>
          </div>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={form.autoFullText}
              onChange={(e) => (
                setSaved(false),
                setForm({ ...form, autoFullText: e.target.checked })
              )}
              className="mt-1 h-4 w-4 accent-[var(--accent)]"
            />
            <span className="text-sm">
              <span className="font-semibold">
                Fetch the full article automatically
              </span>
              <span className="block text-xs text-muted">
                When a feed only provides a short teaser, load the article from
                the website when you open it.
              </span>
            </span>
          </label>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={busy} className={primaryButton}>
              {busy && <Loader2 size={15} className="animate-spin" />} Save
            </button>
            <Saved show={saved} />
          </div>
        </form>
      </Card>

      <Card
        title="Account"
        description="Signing out only has an effect when a password is set with APP_PASSWORD in .env."
      >
        <button type="button" onClick={logout} className={secondaryButton}>
          <LogOut size={15} /> Sign out
        </button>
      </Card>
    </>
  );
}

function AiSection({
  settings,
  onSaved,
}: {
  settings: AppSettings;
  onSaved: (s: AppSettings) => void;
}) {
  const [model, setModel] = useState(settings.openrouterModel);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <>
      <Card
        title="OpenRouter API key"
        description={
          <>
            The Summarize button sends the article text to OpenRouter. Create a
            key at{" "}
            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline"
            >
              openrouter.ai/keys
            </a>
            .
          </>
        }
      >
        <CredentialFields
          fields={[
            {
              name: "openrouterApiKey",
              label: "API key",
              placeholder: "sk-or-v1-…",
            },
          ]}
          settings={settings}
          onSaved={onSaved}
        />
      </Card>

      <Card title="Model">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setSaved(false);
            try {
              onSaved(
                await api<AppSettings>("/api/settings", {
                  method: "PUT",
                  json: { openrouterModel: model },
                }),
              );
              setSaved(true);
            } finally {
              setBusy(false);
            }
          }}
          className="space-y-3"
        >
          <input
            value={model}
            onChange={(e) => (setSaved(false), setModel(e.target.value))}
            placeholder="openrouter/auto"
            className={`${inputClass} font-mono`}
          />
          <p className="text-xs leading-relaxed text-muted">
            Any model slug from{" "}
            <a
              href="https://openrouter.ai/models"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline"
            >
              openrouter.ai/models
            </a>
            , for example <code>anthropic/claude-haiku-5.5</code>.{" "}
            <code>openrouter/auto</code> lets OpenRouter choose.
          </p>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={busy || !model.trim()}
              className={primaryButton}
            >
              {busy && <Loader2 size={15} className="animate-spin" />} Save
            </button>
            <Saved show={saved} />
          </div>
        </form>
      </Card>

      <SummaryPromptCard settings={settings} onSaved={onSaved} />
    </>
  );
}

/** Editable system prompt for summaries, with a reset to the built-in default. */
function SummaryPromptCard({
  settings,
  onSaved,
}: {
  settings: AppSettings;
  onSaved: (s: AppSettings) => void;
}) {
  const [prompt, setPrompt] = useState(settings.summaryPrompt);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  const isDefault = settings.summaryPrompt === settings.defaultSummaryPrompt;
  const dirty = prompt.trim() !== settings.summaryPrompt.trim();

  const save = async (value: string | null) => {
    setBusy(true);
    setErr("");
    setSaved(false);
    try {
      const s = await api<AppSettings>("/api/settings", {
        method: "PUT",
        json: { summaryPrompt: value },
      });
      onSaved(s);
      setPrompt(s.summaryPrompt);
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Summary prompt"
      description="The instructions sent to the model along with the article's title and text. Summaries you've already generated stay as they are until you regenerate them."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save(prompt);
        }}
        className="space-y-3"
      >
        <textarea
          value={prompt}
          onChange={(e) => {
            setSaved(false);
            setPrompt(e.target.value);
          }}
          rows={6}
          maxLength={4000}
          aria-label="Summary prompt"
          className={`${inputClass} resize-y leading-relaxed`}
        />
        <p className="text-xs text-muted">
          {isDefault && !dirty
            ? "Using the default prompt."
            : "Using a custom prompt."}{" "}
          The reader shows bullet points (lines starting with “- ”) as a list
          and other lines as paragraphs.
        </p>
        {err && <p className="text-sm text-danger">{err}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={busy || !dirty || !prompt.trim()}
            className={primaryButton}
          >
            {busy && <Loader2 size={15} className="animate-spin" />} Save
          </button>
          <button
            type="button"
            disabled={busy || (isDefault && !dirty)}
            onClick={() => save(null)}
            className={secondaryButton}
            title="Go back to the built-in prompt"
          >
            <RotateCcw size={15} /> Reset to default
          </button>
          <Saved show={saved && !dirty} />
        </div>
      </form>
    </Card>
  );
}

function NotificationsSection({
  settings,
  onSaved,
}: {
  settings: AppSettings;
  onSaved: (s: AppSettings) => void;
}) {
  const [testTo, setTestTo] = useState(
    settings.credentials.sendgridFrom.preview ?? "",
  );
  const emailReady =
    settings.credentials.sendgridApiKey.set &&
    settings.credentials.sendgridFrom.set;
  const pushReady =
    settings.credentials.pushoverAppToken.set &&
    settings.credentials.pushoverUserKey.set;
  return (
    <>
      <Card
        title="Email (SendGrid)"
        description="Used by the “Send to email” action in rules."
      >
        <CredentialFields
          settings={settings}
          onSaved={onSaved}
          fields={[
            {
              name: "sendgridApiKey",
              label: "API key",
              placeholder: "SG.…",
              help: "Needs the “Mail Send” permission.",
            },
            {
              name: "sendgridFrom",
              label: "Sender address",
              placeholder: "stitch@yourdomain.com",
              secret: false,
              help: "Must be a verified sender (or on an authenticated domain) in your SendGrid account.",
            },
          ]}
        />
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <input
            type="email"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="Send a test to…"
            aria-label="Test email address"
            className={`${inputClass} max-w-xs`}
          />
          {emailReady ? (
            <TestButton
              label="Send test email"
              run={() =>
                api("/api/settings/test", {
                  method: "POST",
                  json: { channel: "email", to: testTo },
                })
              }
            />
          ) : (
            <span className="text-xs text-muted">
              Save an API key and sender address to send a test.
            </span>
          )}
        </div>
      </Card>

      <Card
        title="Push notifications (Pushover)"
        description={
          <>
            Used by the “Push notification” action in rules. Create an
            application at{" "}
            <a
              href="https://pushover.net/apps/build"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline"
            >
              pushover.net/apps/build
            </a>{" "}
            for the token; your user key is on the Pushover dashboard.
          </>
        }
      >
        <CredentialFields
          settings={settings}
          onSaved={onSaved}
          fields={[
            {
              name: "pushoverAppToken",
              label: "Application token",
              placeholder: "a1b2c3…",
            },
            {
              name: "pushoverUserKey",
              label: "User key",
              placeholder: "u1v2w3…",
              help: "A group key works too.",
            },
          ]}
          extra={
            pushReady ? (
              <TestButton
                label="Send test push"
                run={() =>
                  api("/api/settings/test", {
                    method: "POST",
                    json: { channel: "pushover" },
                  })
                }
              />
            ) : undefined
          }
        />
      </Card>
    </>
  );
}

const SHORTCUTS: [string, string][] = [
  ["j / k", "Next / previous article"],
  ["s", "Save for later"],
  ["e", "Move to / remove from Archive"],
  ["m", "Toggle read"],
  ["v", "Open original"],
  ["f", "Toggle full article"],
  ["r", "Refresh feeds"],
  ["/", "Search"],
  ["Shift + A", "Mark all as read"],
];

export function SettingsPage({
  section,
  settings,
  onSaved,
  onImported,
}: {
  section: SettingsSection;
  settings: AppSettings | null;
  onSaved: (s: AppSettings) => void;
  onImported: () => void;
}) {
  const meta = SETTINGS_SECTIONS.find((s) => s.id === section)!;
  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto max-w-[760px] px-4 pb-16 sm:px-8">
        <header className="flex h-[52px] items-center">
          <h1 className="text-[17px] font-bold">{meta.label}</h1>
        </header>
        {!settings ? (
          <div className="flex justify-center py-12 text-muted">
            <Loader2 className="animate-spin" />
          </div>
        ) : (
          <div className="mt-2 space-y-4">
            {section === "general" && (
              <GeneralSection settings={settings} onSaved={onSaved} />
            )}
            {section === "ai" && (
              <AiSection settings={settings} onSaved={onSaved} />
            )}
            {section === "notifications" && (
              <NotificationsSection settings={settings} onSaved={onSaved} />
            )}
            {section === "import" && (
              <Card title="OPML">
                <OpmlTools onImported={onImported} />
              </Card>
            )}
            {section === "shortcuts" && (
              <Card
                title="Keyboard shortcuts"
                description="Shortcuts work in the reader whenever you're not typing in a field."
              >
                <div className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
                  {SHORTCUTS.map(([k, d]) => (
                    <div key={k} className="flex items-center gap-3 text-sm">
                      <kbd className="min-w-20 rounded border border-line bg-sidebar px-2 py-0.5 text-center font-mono text-xs">
                        {k}
                      </kbd>
                      {d}
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
