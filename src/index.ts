// src/index.ts — RAG over KV, Responses API streaming, with debug endpoint
export interface Env {
  OPENAI_API_KEY: string;
  RAG_KV: KVNamespace;
  DOC_PREFIX?: string; // optional override, e.g. "doc:Week1-Ch1Ch2 (4):"
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const CORS = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    };

    // Preflight & health
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") return new Response("OK", { headers: CORS });

    // --- Debug endpoint: shows keys visible to this Worker (first page only) ---
    if (req.method === "GET" && url.pathname === "/debug") {
      if (!env.RAG_KV) return json({ error: "No RAG_KV binding" }, CORS);
      const prefix = env.DOC_PREFIX ?? "doc:";
      const list = await env.RAG_KV.list({ prefix });
      const sample = list.keys.slice(0, 20).map(k => k.name);
      return json({
        boundNamespace: "RAG_KV",
        usingPrefix: prefix,
        returnedThisPage: list.keys.length,
        cursor: list.cursor || null,
        sampleKeys: sample
      }, CORS);
    }

    if (req.method !== "POST") return new Response("POST only", { status: 405, headers: CORS });

    // Parse input
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    const q = lastUser?.content?.trim() || "";

    // Guards
    if (!env.OPENAI_API_KEY?.startsWith("sk-")) return sseError("Server misconfigured: missing OPENAI_API_KEY", CORS);
    if (!env.RAG_KV) return sseError("Server misconfigured: missing RAG_KV binding", CORS);
    if (!q) return sseError("Empty query.", CORS);

    // ---------- Retrieval settings (tuned for your corpus) ----------
    const KEY_PREFIX = env.DOC_PREFIX ?? "doc:"; // set DOC_PREFIX in wrangler.jsonc to narrow to one PDF
    const MAX_LIST_PAGES = 12;     // ~12,000 keys (KV returns up to ~1k per page)
    const MAX_KEYS = 3000;         // hard cap on values fetched + scored per request
    const TOP_K = 5;               // chunks to pass to model
    const MIN_SIM = 0.10;          // loosened for testing; raise later (0.20–0.35)

    // 1) Embed the query
    const queryVec = await embedText(q, env.OPENAI_API_KEY);
    if (!queryVec) return sseError("Embedding failed (no vector).", CORS);

    // 2) List keys and score chunks (bounded)
    const candidates: Array<{ text: string; score: number; id?: string; docId?: string }> = [];
    let cursor: string | undefined;
    let pages = 0;
    let processed = 0;

    try {
      do {
        const listed = await env.RAG_KV.list({ prefix: KEY_PREFIX, cursor });
        cursor = listed.cursor;
        pages++;

        const remaining = Math.max(0, MAX_KEYS - processed);
        if (remaining <= 0) break;
        const slice = listed.keys.slice(0, remaining);

        const batch = await Promise.all(
          slice.map(async (k) => {
            const v = await env.RAG_KV.get(k.name);
            if (!v) return null;
            try {
              const obj = JSON.parse(v);
              const s = cosineSim(queryVec, obj.embedding as number[]);
              return { text: obj.text as string, score: s, id: obj.id as string, docId: obj.docId as string };
            } catch { return null; }
          })
        );

        for (const item of batch) if (item) candidates.push(item);
        processed += slice.length;
      } while (cursor && pages < MAX_LIST_PAGES);
    } catch {
      return sseError("I can only answer from your documents, and I couldn’t access them right now.", CORS);
    }

    candidates.sort((a, b) => b.score - a.score);
    const top = candidates.filter(c => c.score >= MIN_SIM).slice(0, TOP_K);

    if (top.length === 0) {
      // Strict RAG: refuse when nothing relevant is found
      return sseText("Sorry, I don’t know based on the provided documents.", CORS);
    }

    const context = top.map((c, i) => `[#${i + 1} ${c.docId ?? ""}] ${c.text}`).join("\n\n---\n\n");

    // 3) Call OpenAI Responses API and stream back
    \
const upstream = await fetch("https://api.openai.com/v1/responses", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
  },
  body: JSON.stringify({
        model: "gpt-4o-mini",
        input: [
          {
            role: "system",
            content:
              "You are a STRICT RAG assistant. Use ONLY the provided context. " +
              "If the answer isn’t fully supported by the context, respond exactly: " +
              "\"I don’t know based on the provided documents.\""
          },
          { role: "user", content: `Question: ${q}\n\nContext:\n${context}` },
        ],
        stream: true,
      }), // keep your existing request payload
});

if (!upstream.ok || !upstream.body) {
  const text = await upstream.text();
  // sseError helper may exist in your file; if not, send a JSON error
  if (typeof sseError === "function") {
    return sseError(`OpenAI upstream error: ${upstream.status} ${text}`, CORS);
  } else {
    return new Response(JSON.stringify({ error: "OpenAI upstream error", detail: text }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }
}

// --- Filter the SSE so the browser only sees text deltas + completed ---
const { readable, writable } = new TransformStream();
const writer = writable.getWriter();
const enc = new TextEncoder();
const reader = upstream.body.getReader();
const decoder = new TextDecoder();
let __sse_buf = "";

async function __emit(obj: unknown) {
  await writer.write(enc.encode(`data: ${JSON.stringify(obj)}\\n\\n`));
}

(async () => {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      __sse_buf += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = __sse_buf.indexOf("\\n\\n")) !== -1) {
        const raw = __sse_buf.slice(0, idx);
        __sse_buf = __sse_buf.slice(idx + 2);

        const evt = { event: "", data: "" };
        for (const line of raw.split("\\n")) {
          if (line.startsWith("event:")) evt.event = line.slice(6).trim();
          else if (line.startsWith("data:")) evt.data += (evt.data ? "\\n" : "") + line.slice(5).trim();
        }

        if (!evt.data) continue;
        try {
          const obj = JSON.parse(evt.data);
          const t = obj.type;
          if (t === "response.output_text.delta" && obj.delta) {
            await __emit({ type: t, delta: obj.delta });
          } else if (t === "response.completed") {
            await __emit({ type: t });
          } else if (t === "response.error" && obj.error) {
            await __emit({ type: t, error: obj.error });
          }
        } catch {
          // ignore non-JSON frames
        }
      }
    }
  } catch (e: any) {
    await __emit({ type: "response.error", error: { message: e?.message || String(e) } });
  } finally {
    await writer.close();
  }
})();

return new Response(readable, {
  headers: {
    ...(typeof CORS !== "undefined" ? CORS : {}),
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  },
});return new Response(stream, { headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

function sseError(text: string, cors: Record<string, string>) { return sseText(`[Error] ${text}`, cors); }

function json(obj: any, cors: Record<string, string>) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { ...cors, "Content-Type": "application/json" }
  });
}
