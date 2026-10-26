import { getDb } from "./db";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function exportOpml(): string {
  const db = getDb();
  const folders = db.prepare("SELECT id, name FROM folders ORDER BY position, name").all() as { id: number; name: string }[];
  const feeds = db.prepare("SELECT folder_id, title, feed_url, site_url FROM feeds ORDER BY position, title").all() as {
    folder_id: number | null;
    title: string;
    feed_url: string;
    site_url: string | null;
  }[];
  const line = (f: (typeof feeds)[number], indent: string) =>
    `${indent}<outline type="rss" text="${esc(f.title)}" title="${esc(f.title)}" xmlUrl="${esc(f.feed_url)}"${
      f.site_url ? ` htmlUrl="${esc(f.site_url)}"` : ""
    }/>`;

  const body: string[] = [];
  for (const folder of folders) {
    body.push(`    <outline text="${esc(folder.name)}" title="${esc(folder.name)}">`);
    for (const f of feeds.filter((f) => f.folder_id === folder.id)) body.push(line(f, "      "));
    body.push("    </outline>");
  }
  for (const f of feeds.filter((f) => f.folder_id === null)) body.push(line(f, "    "));

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Stitch subscriptions</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
${body.join("\n")}
  </body>
</opml>
`;
}

type Outline = { attrs: Record<string, string>; children: Outline[] };

function decodeEntities(s: string) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/** Minimal OPML outline parser: handles nested <outline> elements and their attributes. */
function parseOutlines(xml: string): Outline[] {
  const bodyStart = xml.search(/<body[\s>]/i);
  const src = bodyStart >= 0 ? xml.slice(bodyStart) : xml;
  const root: Outline = { attrs: {}, children: [] };
  const stack: Outline[] = [root];
  for (const m of src.matchAll(/<(\/?)outline\b([^>]*?)(\/?)>/gi)) {
    const [, closing, attrText, selfClosing] = m;
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of attrText.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      attrs[a[1].toLowerCase()] = decodeEntities(a[3] ?? a[4] ?? "");
    }
    const node: Outline = { attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root.children;
}

/** Import an OPML document. Feeds are inserted without fetching; the next refresh fills them in. */
export function importOpml(xml: string): { folders: number; feeds: number; skipped: number } {
  const db = getDb();
  const outlines = parseOutlines(xml);
  let folders = 0;
  let feeds = 0;
  let skipped = 0;

  const findFolder = db.prepare("SELECT id FROM folders WHERE name = ?");
  const addFolder = db.prepare("INSERT INTO folders (name, position) VALUES (?, (SELECT COALESCE(MAX(position), 0) + 1 FROM folders))");
  const addFeed = db.prepare(
    `INSERT OR IGNORE INTO feeds (folder_id, title, feed_url, site_url, position, created_at)
     VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM feeds), ?)`,
  );

  const insertFeed = (o: Outline, folderId: number | null) => {
    const url = o.attrs.xmlurl;
    const r = addFeed.run(folderId, o.attrs.title || o.attrs.text || url, url, o.attrs.htmlurl || null, Date.now());
    if (r.changes) feeds++;
    else skipped++;
  };

  // Nested folders are flattened to one level, which is all the sidebar supports.
  const walk = (nodes: Outline[], folderId: number | null) => {
    for (const o of nodes) {
      if (o.attrs.xmlurl) {
        insertFeed(o, folderId);
      } else if (o.children.length) {
        const name = o.attrs.title || o.attrs.text || "Imported";
        let id = folderId;
        if (folderId === null) {
          const existing = findFolder.get(name) as { id: number } | undefined;
          if (existing) id = existing.id;
          else {
            id = Number(addFolder.run(name).lastInsertRowid);
            folders++;
          }
        }
        walk(o.children, id);
      }
    }
  };
  db.transaction(() => walk(outlines, null))();
  return { folders, feeds, skipped };
}
