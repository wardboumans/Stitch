import sanitize from "sanitize-html";

function absolutize(value: string | undefined, base: string | undefined): string | undefined {
  if (!value) return value;
  const v = value.trim();
  if (v.startsWith("data:") || v.startsWith("#") || v.startsWith("mailto:")) return v;
  try {
    return base ? new URL(v, base).href : new URL(v).href;
  } catch {
    return undefined;
  }
}

/** Sanitize feed/article HTML for display. Relative URLs are resolved against `baseUrl`. */
export function sanitizeHtml(html: string, baseUrl?: string): string {
  return sanitize(html, {
    allowedTags: sanitize.defaults.allowedTags.concat([
      "img", "figure", "figcaption", "picture", "video", "audio", "source", "iframe", "h1", "h2", "del", "ins", "sup", "sub",
    ]),
    allowedAttributes: {
      // transformTags output is still filtered by this list, so the attributes it adds are allowed here.
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title", "width", "height", "loading", "referrerpolicy"],
      video: ["src", "poster", "controls", "width", "height"],
      audio: ["src", "controls"],
      source: ["src", "type"],
      iframe: ["src", "width", "height", "allowfullscreen", "frameborder", "allow"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
      "*": ["lang", "dir"],
    },
    allowedSchemes: ["http", "https", "mailto", "data"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    allowedIframeHostnames: [
      "www.youtube.com", "youtube.com", "www.youtube-nocookie.com", "player.vimeo.com", "open.spotify.com", "w.soundcloud.com",
    ],
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, href: absolutize(attribs.href, baseUrl) ?? "", target: "_blank", rel: "noopener noreferrer" },
      }),
      img: (tagName, attribs) => {
        // Many sites lazy-load with data-src and a placeholder src.
        const src = attribs["data-src"] || attribs["data-lazy-src"] || attribs["data-original"] || attribs.src;
        return { tagName, attribs: { ...attribs, src: absolutize(src, baseUrl) ?? "", loading: "lazy", referrerpolicy: "no-referrer" } };
      },
      source: (tagName, attribs) => ({ tagName, attribs: { ...attribs, src: absolutize(attribs.src, baseUrl) ?? "" } }),
      video: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, src: absolutize(attribs.src, baseUrl) ?? "", poster: absolutize(attribs.poster, baseUrl) ?? "" },
      }),
    },
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  });
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Strip tags and decode common entities to get plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?\w+);/g, (m, e: string) => {
      if (ENTITIES[e]) return ENTITIES[e];
      if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
      return m;
    })
    // Same as /[ \t\f\v]+/ → " ", but leaves single spaces alone: several times faster on long text.
    .replace(/[ \t\f\v]{2,}|[\t\f\v]/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

export function firstImage(html: string, baseUrl?: string): string | undefined {
  const re = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const src = /\b(?:data-src|data-lazy-src|src)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src || src.startsWith("data:")) continue;
    // Skip tracking pixels and tiny icons.
    const w = /\bwidth\s*=\s*["']?(\d+)/i.exec(tag)?.[1];
    if (w && Number(w) < 50) continue;
    if (/feedburner|pixel|tracker|gravatar|emoji/i.test(src)) continue;
    return absolutize(src, baseUrl);
  }
  return undefined;
}
