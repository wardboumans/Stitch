"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Rss } from "lucide-react";

/** The Stitch mark (same artwork as app/icon.svg): a light stream bending around a pebble. */
export function Logo({ className }: { className?: string }) {
  const clip = useId();
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <clipPath id={clip}>
          <rect width="64" height="64" rx="15" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect width="64" height="64" fill="#229e8c" />
        <path d="M-1 18A47 47 0 0 1 46 65H30A31 31 0 0 0-1 34Z" fill="#e8f8f4" />
        <path d="M-1 0H22A42 42 0 0 1 65 42V65H52A53 53 0 0 0-1 12Z" fill="#0e5a51" />
        <circle cx="13" cy="51" r="8" fill="#7fd8c8" />
      </g>
    </svg>
  );
}

export function FeedIcon({
  src,
  title,
  size = 18,
}: {
  src: string | null;
  title: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    const letter = title.trim().charAt(0).toUpperCase();
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-[4px] bg-active font-semibold text-muted"
        style={{ width: size, height: size, fontSize: size * 0.6 }}
        aria-hidden
      >
        {letter || <Rss size={size * 0.6} />}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      referrerPolicy="no-referrer"
      className="shrink-0 rounded-[4px] object-contain"
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
    />
  );
}

export function IconButton({
  label,
  onClick,
  children,
  active,
  className = "",
  disabled,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  active?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors hover:bg-hover disabled:opacity-40 ${
        active ? "text-accent" : "text-muted hover:text-fg"
      } ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * A link to another view of the app (e.g. /settings/ai). AppShell owns the view and reads it
 * from the URL on popstate, so a plain click pushes the URL and fires popstate instead of going
 * through the Next router (which would only change the URL). Modified clicks open normally.
 */
export function AppLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
          return;
        e.preventDefault();
        window.history.pushState(null, "", href);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }}
    >
      {children}
    </a>
  );
}

export type MenuItem =
  | {
      label: string;
      onSelect: () => void;
      icon?: ReactNode;
      checked?: boolean;
      danger?: boolean;
    }
  | { separator: true }
  | { heading: string };

/** Small dropdown menu anchored to its trigger. Closes on outside click and Escape. */
export function Menu({
  trigger,
  items,
  align = "right",
  label,
  onOpenChange,
}: {
  trigger: ReactNode;
  items: MenuItem[];
  align?: "left" | "right";
  label: string;
  /** Lets a parent keep a hover-only trigger visible while the menu is open. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    onOpenChange?.(v);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // setOpen only wraps state setters and the parent callback
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className="inline-flex items-center"
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          // Reset type styles: the menu renders inside its trigger's row (e.g. a bold sidebar row).
          className={`absolute top-full z-50 mt-1 min-w-52 rounded-lg border border-line bg-elevated py-1 text-left text-sm font-normal leading-normal shadow-pop ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {items.map((item, i) =>
            "separator" in item ? (
              <div key={i} className="my-1 border-t border-line" />
            ) : "heading" in item ? (
              <div
                key={i}
                className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-faint"
              >
                {item.heading}
              </div>
            ) : (
              <button
                key={i}
                type="button"
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  item.onSelect();
                }}
                className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-hover ${item.danger ? "text-danger" : "text-fg"}`}
              >
                <span className="flex w-4 justify-center text-muted">
                  {item.checked ? "✓" : item.icon}
                </span>
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function Dialog({
  title,
  onClose,
  children,
  width = 460,
  header,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  /** Replaces the plain title heading (`title` still labels the dialog). */
  header?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal
        aria-label={title}
        className="max-h-[76vh] w-full overflow-y-auto rounded-xl border border-line bg-elevated p-6 shadow-pop"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {header ?? <h2 className="mb-4 text-lg font-semibold">{title}</h2>}
        {children}
      </div>
    </div>
  );
}

export const inputClass =
  "w-full rounded-md border border-line bg-bg px-3 py-2 text-sm text-fg outline-none placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/25";

export const primaryButton =
  "inline-flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-50";

export const dangerButton =
  "inline-flex items-center justify-center gap-2 rounded-md bg-danger px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50";

export const secondaryButton =
  "inline-flex items-center justify-center gap-2 rounded-md border border-line bg-bg px-4 py-2 text-sm font-semibold text-fg hover:bg-hover disabled:opacity-50";

/**
 * Empty-state illustration: three article cards, each badged with an icon, above a title,
 * a short explanation and a call to action. The middle card is raised and uses the accent color.
 */
export function EmptyState({
  icons,
  title,
  children,
  actionLabel,
  onAction,
}: {
  icons: [ReactNode, ReactNode, ReactNode];
  title: string;
  children: ReactNode;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <div
        className="mb-8 flex items-end gap-3 rounded-[40%] bg-hover/70 px-12 py-10"
        aria-hidden
      >
        {icons.map((icon, i) => (
          <div
            key={i}
            className={`relative h-24 w-20 rounded-lg border-2 border-fg/70 bg-bg p-2 ${i === 1 ? "-translate-y-2" : ""}`}
          >
            <div className="mb-2 h-4 w-6 rounded bg-hover" />
            <div className="mb-1 h-1.5 w-full rounded bg-hover" />
            <div className="mb-1 h-1.5 w-4/5 rounded bg-hover" />
            <div className="h-1.5 w-3/5 rounded bg-hover" />
            <span
              className={`absolute bottom-1.5 right-1.5 ${i === 1 ? "text-accent" : "text-muted"}`}
            >
              {icon}
            </span>
          </div>
        ))}
      </div>
      <h2 className="mb-2 text-[22px] font-bold">{title}</h2>
      <p className="mb-8 max-w-md text-[15px] leading-relaxed text-muted">
        {children}
      </p>
      <button
        type="button"
        onClick={onAction}
        className={`${primaryButton} px-6 py-2.5`}
      >
        {actionLabel}
      </button>
    </div>
  );
}
