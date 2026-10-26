import { getDb } from "./db";
import { htmlToText } from "./html";
import { DEFAULT_SUMMARY_PROMPT, getCredential, getSettings } from "./settings";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MAX_INPUT_CHARS = 24000;

export function hasOpenRouterKey() {
  return !!getCredential("openrouterApiKey");
}

type SummaryArticle = { id: number; title: string; content: string | null; full_content: string | null; summary: string | null };

function loadArticle(articleId: number): SummaryArticle {
  const a = getDb().prepare("SELECT id, title, content, full_content, summary FROM articles WHERE id = ?").get(articleId) as
    | SummaryArticle
    | undefined;
  if (!a) throw new Error("Article not found");
  return a;
}

async function requestSummary(a: SummaryArticle, stream: boolean): Promise<Response> {
  const key = getCredential("openrouterApiKey");
  if (!key) throw new Error("No OpenRouter API key: add one in Settings → AI summaries");

  const text = htmlToText(a.full_content || a.content || "").slice(0, MAX_INPUT_CHARS);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
      "X-Title": "Stitch",
    },
    body: JSON.stringify({
      model: getSettings().openrouterModel,
      stream,
      messages: [
        {
          role: "system",
          content: getSettings().summaryPrompt.trim() || DEFAULT_SUMMARY_PROMPT,
        },
        { role: "user", content: `Title: ${a.title}\n\n${text}` },
      ],
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter error ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
}

/** The article's stored summary, or a new one from OpenRouter (stored on the article). For rules. */
export async function summarizeArticle(articleId: number): Promise<string> {
  const a = loadArticle(articleId);
  if (a.summary?.trim()) return a.summary;
  const json = await (await requestSummary(a, false)).json();
  if (json.error) throw new Error(`OpenRouter: ${json.error.message ?? "summary failed"}`);
  const summary = String(json.choices?.[0]?.message?.content ?? "").trim();
  if (!summary) throw new Error("OpenRouter returned an empty summary");
  getDb().prepare("UPDATE articles SET summary = ? WHERE id = ?").run(summary, a.id);
  return summary;
}

/**
 * Stream a summary from OpenRouter as plain text chunks. The full summary is cached on the
 * article once the stream completes.
 */
export async function streamSummary(articleId: number): Promise<ReadableStream<Uint8Array>> {
  const db = getDb();
  const a = loadArticle(articleId);
  const res = await requestSummary(a, true);

  const upstream = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const encoder = new TextEncoder();
  let buffer = "";
  let full = "";

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await upstream.read();
        if (done) {
          if (full.trim()) db.prepare("UPDATE articles SET summary = ? WHERE id = ?").run(full.trim(), a.id);
          controller.close();
          return;
        }
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        let emitted = false;
        for (const line of lines) {
          // OpenRouter sends ": OPENROUTER PROCESSING" keepalive comments; only `data:` lines carry payloads.
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const json = JSON.parse(data);
            if (json.error) throw new Error(json.error.message ?? "OpenRouter stream error");
            const delta: string | undefined = json.choices?.[0]?.delta?.content;
            if (delta) {
              full += delta;
              controller.enqueue(encoder.encode(delta));
              emitted = true;
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            controller.error(e);
            return;
          }
        }
        if (emitted) return;
      }
    },
    cancel() {
      upstream.cancel().catch(() => {});
    },
  });
}
