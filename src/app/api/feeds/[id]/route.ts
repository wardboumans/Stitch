import { body, error, intParam, json } from "@/lib/api";
import { getDb } from "@/lib/db";
import { deleteFeed, feedAutomations } from "@/lib/feeds";

/** The rules and filters that would be deleted with this feed (for the unfollow confirmation). */
export async function GET(_req: Request, ctx: RouteContext<"/api/feeds/[id]">) {
  const id = intParam((await ctx.params).id);
  if (!id) return error("Invalid id");
  return json(feedAutomations(id));
}

export async function PATCH(req: Request, ctx: RouteContext<"/api/feeds/[id]">) {
  const id = intParam((await ctx.params).id);
  if (!id) return error("Invalid id");
  const patch = await body<{ title: string; folderId: number | null; autoFullText: boolean; autoSummary: boolean }>(req);
  if (patch.autoFullText !== undefined && typeof patch.autoFullText !== "boolean")
    return error("autoFullText must be a boolean");
  if (patch.autoSummary !== undefined && typeof patch.autoSummary !== "boolean")
    return error("autoSummary must be a boolean");
  const db = getDb();
  if (patch.title !== undefined && patch.title.trim()) db.prepare("UPDATE feeds SET title = ? WHERE id = ?").run(patch.title.trim(), id);
  if (patch.folderId !== undefined) db.prepare("UPDATE feeds SET folder_id = ? WHERE id = ?").run(patch.folderId, id);
  if (patch.autoFullText !== undefined)
    db.prepare("UPDATE feeds SET auto_full_text = ? WHERE id = ?").run(Number(patch.autoFullText), id);
  if (patch.autoSummary !== undefined)
    db.prepare("UPDATE feeds SET auto_summary = ? WHERE id = ?").run(Number(patch.autoSummary), id);
  return json({ ok: true });
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/feeds/[id]">) {
  const id = intParam((await ctx.params).id);
  if (!id) return error("Invalid id");
  deleteFeed(id);
  return json({ ok: true });
}
