# Stitch

A self-hosted, single-user RSS reader with a three-pane layout. Built with Next.js 16 and SQLite.

![Stitch: feeds and folders in the sidebar, the article list, and the reader](screenshot.png)

## Features

- **Feeds and folders** with unread counts, in a three-pane layout
- **YouTube channels and playlists**: paste a link or `@handle`; videos arrive with an embedded player and their description
- **Google News searches**: follow any search (quotes, `intitle:`, `OR`, `-`, `site:`, `when:`) in your language and region, with a live preview of the results
- **Feed properties**: addresses, folder, activity and a refresh log (latency, status, errors) per feed
- **Full article** fetch (Readability) for feeds that only send a teaser (works on most, not all, websites)
- **AI summaries** via OpenRouter, cached per article
- **Read later**, an **archive** that keeps articles forever, and **full-text search**
- **Tags**: tag articles from the reader, with suggestions from your existing tags and (with an OpenRouter key) AI; browse them under **Saved**
- **Output feeds**: publish a tag or folder as a public feed in RSS, JSON Feed or OPML
- **Monitoring feeds**: saved keyword searches that act like feeds
- **Automations**: when a new article matches your conditions, email it (SendGrid, optionally with its AI summary), push it (Pushover), tag it, mark it read, add it to Read later or summarize it
- **Filters**: hide matching articles, or keep only matching ones, per feed or folder
- **Read state**: marked read on open; mark a whole section read, or only older items
- **OPML** import and export
- **Background refresh** with conditional GET, retries for temporary failures, and automatic cleanup of old read articles
- **Light and dark themes**, on desktop and mobile
- **Keyboard shortcuts** (`j`/`k`, `s`, `e`, `m`, `/` and more)
- **Optional password**

## Running

```bash
npm install
cp .env.example .env   # optional: OpenRouter key, password
npm run dev            # http://localhost:3000
```

Production:

```bash
npm run build
npm start
```

The database is created at `data/reader.db` (override with `DATABASE_PATH`) and upgraded automatically on start. Back up that file to keep your feeds, read state, saved, archived and tagged articles.

## Tags and output feeds

Use the tag button above an article to add tags: search, click to toggle, or type a new name and press Enter. **Suggested tags** offers your existing tags that appear in the article and, with an OpenRouter key, tags suggested by the AI model. Rules can tag articles too: add an **Assign tag** action, and use **Run rule** to tag articles you already have (Run rule also applies **Mark as read** and **Add to Read later** actions). **Run AI summary** and **Email AI summary** summarize up to 20 new matches per refresh with your OpenRouter model and store the summary on the article.

The **Saved** button in the rail switches the sidebar to Read later, Archive and your tags. Archived articles (button above the article, or `e`) are never removed by retention; neither are tagged ones.

A tag (Edit tag) or a folder (Folder properties) can have an **output feed**: a public link, for a blog or another reader, that works without the password. The same link serves three formats:

| URL                                  | Format                                              |
| ------------------------------------ | --------------------------------------------------- |
| `/feeds/<tag\|folder>/<token>`       | RSS 2.0 (`.xml` also works)                         |
| `/feeds/<tag\|folder>/<token>.json`  | JSON Feed 1.1                                       |
| `/feeds/<tag\|folder>/<token>.opml`  | OPML: a folder's feeds, or a tag's articles as links |

Anyone with the link can read the feed; **New link** in the dialog replaces it. Set `APP_URL` when running behind a proxy so links inside the feeds use your public address.

## Docker

Images are published to `ghcr.io/wardboumans/stitch`:

| Tag             | Built from                     |
| --------------- | ------------------------------ |
| `latest`        | `main` and every release       |
| `1.0.0`, …      | release tags                   |
| `develop`       | the `develop` branch           |
| `<short-sha>`   | a specific `develop` commit    |

To try it out (nothing is kept when you stop it):

```bash
docker run --rm -p 3000:3000 ghcr.io/wardboumans/stitch:latest
```

Or with plain Docker:

```bash
docker run -d --name stitch --restart unless-stopped \
  -p 3000:3000 \
  -v ./data:/data \
  ghcr.io/wardboumans/stitch:latest
```

The database lives in `/data` inside the container, so mount a volume there (`./data` on the host above) or you lose your feeds when the container is replaced. API keys can be set as environment variables or added later under **Settings**.

To update: `docker compose pull && docker compose up -d`. To build the image from this checkout instead: `docker build -t stitch .`

## Configuration

Most configuration lives in the app under **Settings** (`/settings`): refresh interval, retention, automatic full text, the OpenRouter key and model, and the SendGrid and Pushover credentials for rules (each with a "Send test" button). Keys saved there are stored in the database and are never sent back to the browser; the UI only shows whether a key is set and its last four characters.

Environment variables still work as a fallback for those keys, and are the only way to set the password and paths:

| Variable             | Purpose                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `OPENROUTER_API_KEY` | Enables the Summarize button                                         |
| `OPENROUTER_MODEL`   | Default model slug (default `openrouter/auto`), editable in Settings |
| `SENDGRID_API_KEY`   | Enables the email action in automations                              |
| `SENDGRID_FROM`      | Verified sender address for those emails                             |
| `PUSHOVER_APP_TOKEN` | Enables the push notification action                                 |
| `PUSHOVER_USER_KEY`  | Your Pushover user (or group) key                                    |
| `APP_PASSWORD`       | Requires a password to use the app                                   |
| `DATABASE_PATH`      | SQLite file location                                                 |
| `APP_URL`            | Public base URL, used for links in output feeds                      |
| `DISABLE_SCHEDULER`  | `1` turns off background refresh                                     |

## Layout

```
src/
  app/api/…        route handlers (articles, feeds, folders, monitors, rules, filters, tags, google-news, opml, refresh, settings, login)
  app/feeds/…      public tag/folder output feeds
  components/      client UI (AppShell holds state; Rail, SidebarPanel, ArticleList, ArticleView, AddNew, FeedProperties, Tags, Dialogs)
  lib/db.ts        baseline schema, versioned migrations, connection singleton
  lib/tags.ts      tags, article tagging, tag suggestions
  lib/outputFeeds.ts  RSS / JSON Feed / OPML output for tags and folders
  lib/feeds.ts     discovery, parsing, refresh (retries, refresh log), retention
  lib/youtube.ts   YouTube channel/playlist feeds and video articles
  lib/googleNews.ts  Google News search feeds and editions
  lib/queries.ts   sidebar counts, article listing, mark-read
  lib/fulltext.ts  Readability extraction
  lib/summarize.ts OpenRouter streaming
  lib/opml.ts      OPML import/export
  lib/monitors.ts  monitoring-feed queries (FTS5)
  lib/automations.ts  rules: matching, SendGrid/Pushover delivery
  lib/filters.ts   remove/keep filters (hidden flag on articles)
  instrumentation.ts  starts the background scheduler
  proxy.ts         optional password gate
```
