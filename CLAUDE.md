<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Stitch: things to remember

- **Database schema** (`src/lib/db.ts`): `SCHEMA` is the frozen v1 baseline — never edit it. Every schema change (new tables too) is a new entry appended to `MIGRATIONS` with the next `version`; it runs once in a transaction and is tracked in `PRAGMA user_version`. Never edit or reorder a released migration.
- **Hidden (filtered) articles:** every article query must go through `scopeWhere` / `queryWhere` (they add `a.filtered = 0`), or filtered articles leak into lists and counts.
- **Feed data is messy:** pass parsed feed fields through `text()` in `feeds.ts` before binding to SQLite; objects (e.g. Atom authors) throw.
- **Background refresh in dev:** `instrumentation.ts`/`scheduler.ts` are not hot-reloaded. The scheduler calls the `refreshAll` registered on `globalThis` by `feeds.ts`; restart `next dev` after editing the scheduler itself.
- **Secrets:** read API keys only via `getCredential()` (DB, then env). Never send secret values to the client — the UI gets `credentialStatus()`.
- **Docker/standalone:** keep `outputFileTracingIncludes` for `better-sqlite3/prebuilds` in `next.config.ts` — without it the image crashes on first DB access. `*.sh` must stay LF.
- **Routes:** `/automate/[section]` and `/settings/[section]` only render the client app; `AppShell` derives the view from the URL. New sections go in both the route's `generateStaticParams` and the client section list.
- **React lint:** no synchronous `setState` in effects (`react-hooks/set-state-in-effect`); derive state from keys instead (see `queryKey` in `AppShell`).
- **Editing on Windows:** bash heredocs / `node -e` mangle backticks and `${}` — use the Edit tool for TypeScript template literals.
- **Before finishing:** `npx tsc --noEmit`, `npx eslint src`, `npm run build`.
