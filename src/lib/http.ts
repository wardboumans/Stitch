export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Stitch/1.0";

// Some blogs publish their entire archive with full content in one feed (20+ MB).
const DEFAULT_MAX_BYTES = 40 * 1024 * 1024;

export type FetchResult = {
  status: number;
  url: string;
  contentType: string;
  text: string;
  etag: string | null;
  lastModified: string | null;
};

/** Fetch a URL as text with a timeout, a size cap, and charset detection (header or XML/HTML declaration). */
export async function fetchText(
  url: string,
  opts: {
    etag?: string | null;
    lastModified?: string | null;
    accept?: string;
    timeoutMs?: number;
    maxBytes?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<FetchResult> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: opts.accept ?? "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5",
    ...opts.headers,
  };
  if (opts.etag) headers["If-None-Match"] = opts.etag;
  if (opts.lastModified) headers["If-Modified-Since"] = opts.lastModified;

  const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(opts.timeoutMs ?? 20000) });
  const contentType = res.headers.get("content-type") ?? "";
  const base = { status: res.status, url: res.url || url, contentType, etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") };
  if (res.status === 304 || !res.body) return { ...base, text: "" };

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > (opts.maxBytes ?? DEFAULT_MAX_BYTES)) {
      await reader.cancel();
      throw new TooLargeError(`Response larger than ${Math.round((opts.maxBytes ?? DEFAULT_MAX_BYTES) / 1048576)} MB`);
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks);
  return { ...base, text: decode(buf, contentType) };
}

class TooLargeError extends Error {}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Responses worth retrying: rate limited (429) or a server error (5xx). */
export const isTransientStatus = (status: number) => status === 429 || status >= 500;

/** Errors thrown by fetchText worth retrying: network errors and timeouts, not an oversized response. */
export const isTransientError = (e: unknown) => !(e instanceof TooLargeError);

/**
 * fetchText with retries for transient failures: network errors, timeouts, 429 and 5xx.
 * Other responses (including 4xx) come back as-is after the first attempt.
 */
export async function fetchTextWithRetry(
  url: string,
  opts: Parameters<typeof fetchText>[1] = {},
  { attempts = 3, onRetry }: { attempts?: number; onRetry?: () => void } = {},
): Promise<FetchResult> {
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= attempts;
    try {
      const res = await fetchText(url, opts);
      if (last || !isTransientStatus(res.status)) return res;
    } catch (e) {
      if (last || !isTransientError(e)) throw e;
    }
    onRetry?.();
    await sleep(1000 * 2 ** (attempt - 1));
  }
}

function decode(buf: Buffer, contentType: string): string {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = buf.subarray(0, 1024).toString("latin1");
    charset = /<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(head)?.[1] ?? /<meta[^>]*charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || "utf-8").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}
