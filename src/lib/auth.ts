// Used from proxy.ts as well as route handlers, so stick to Web APIs (no DB, no Node-only modules).

export const AUTH_COOKIE = "stitch_auth";

export async function authToken(password: string): Promise<string> {
  const data = new TextEncoder().encode(`stitch:${password}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function authEnabled() {
  return !!process.env.APP_PASSWORD;
}
