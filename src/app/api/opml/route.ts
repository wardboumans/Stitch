import { error, json } from "@/lib/api";
import { refreshAll } from "@/lib/feeds";
import { exportOpml, importOpml } from "@/lib/opml";

export function GET() {
  const date = new Date().toISOString().slice(0, 10);
  return new Response(exportOpml(), {
    headers: {
      "Content-Type": "text/x-opml; charset=utf-8",
      "Content-Disposition": `attachment; filename="stitch-${date}.opml"`,
    },
  });
}

/** Accepts the OPML file as multipart form data (field "file") or as the raw request body. */
export async function POST(req: Request) {
  let xml: string;
  if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const file = (await req.formData()).get("file");
    if (!(file instanceof File)) return error("No file uploaded");
    xml = await file.text();
  } else {
    xml = await req.text();
  }
  if (!/<opml[\s>]/i.test(xml)) return error("That doesn't look like an OPML file");
  const result = importOpml(xml);
  // Fetch the new feeds in the background; the UI polls the sidebar while `refreshing` is true.
  if (result.feeds) void refreshAll();
  return json(result);
}
