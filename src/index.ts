// src/index.ts — Responses API + strict RAG + SSE-safe errors
export interface Env {
  OPENAI_API_KEY: string;
  RAG_KV: KVNamespace;
  DOC_PREFIX?: string; // optional: e.g. ""
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const CORS = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method === "GET")     return new Response("OK", { headers: CORS });
    if (req.method !== "POST")    return new Response("POST only", { status: 405, headers: CORS });

    // Parse input safely
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const messages = (body.messages ?? []) as Array<{role:string, content:string}>;
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    const q = lastUser?.content?.trim() || "";

    // Guards
    if (!env.OPENAI_API_KEY?.startsWith("sk-"))
      return sseError("Server misconfigured: missing OPENAI_API_KEY", CORS);
    if (!q) return sseError("Empty query.", CORS);
    if (!env.RAG_KV) return sseError("No document store is configured.", CORS);

    // ---------- Retrieval (strict) ----------
    const KEY_PREFIX = (env.DOC_PREFIX ?? ""); // narrow to a single doc by setting DOC_PREFIX
    const MAX_LIST_PAGES = 5;    // raise if you have many chunks
    const TOP_K = 5;
    const MIN_SIM = 0.20;        // tighten/loosen as needed

    // 1) Embed the query
    const embResp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: q }),
    });
    if (!embResp.ok) {
      const txt = await embResp.text();
      return sseError(`Embedding error: ${txt}`, CORS);
    }
    const embJson = await embResp.json();
    const queryVec = embJson.data?.[0]?.embedding as number[] | undefined;
    if (!queryVec) return sseError("Embedding failed (no vector).", CORS);

    // 2) Scan KV and score (bounded)
    const candidates: Array<{ text: string; score: number; id?: string; docId?: string }> = [];
    let cursor: string | undefined;
    let pages = 0;

    try {
      do {
        const listed = await env.RAG_KV.list({ prefix: KEY_PREFIX, cursor });
        cursor = listed.cursor;
        pages++;

        const batch = await Promise.all(
          listed.keys.map(async (k) => {
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
      } while (cursor && pages < MAX_LIST_PAGES);
    } catch {
      return sseError("I can only answer from your documents, and I couldn’t access them right now.", CORS);
    }

    candidates.sort((a, b) => b.score - a.score);
    const top = candidates.filter(c => c.score >= MIN_SIM).slice(0, TOP_K);

    if (top.length === 0) {
      // Strict: refuse if nothing relevant is found
      return sseText("Sorry, I don’t know based on the provided documents.", CORS);
    }

    const context = top.map((c, i) => `[#${i+1} ${c.docId ?? ""}] ${c.text}`).join("\n\n---\n\n");

    // ---------- Call Responses API (matches your frontend parser) ----------
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: [
          { role: "system", content:
            "You are a STRICT RAG assistant. Use ONLY the provided context. " +
            "If the answer isn’t fully supported by the context, respond exactly: " +
            "\"I don’t know based on the provided documents.\""
          },
          { role: "user", content: `Question: ${q}\n\nContext:\n${context}` },
        ],
        stream: true,
      }),
    });

    if (!upstream.ok) {
      const txt = await upstream.text();
      return sseError(`OpenAI error: ${txt}`, CORS);
    }

    return new Response(upstream.body, {
      headers: {
        ...CORS,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  },
} satisfies ExportedHandler<Env>;

// ---------- helpers ----------
function cosineSim(a: number[], b: number[]) {
  if (!a || !b) return -1;
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

// Stream a plain message in the exact SSE shape your page expects
function sseText(text: string, cors: Record<string,string>) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(`data: ${JSON.stringify({ type:"response.output_text.delta", delta:text })}\n\n`));
      c.enqueue(enc.encode(`data: ${JSON.stringify({ type:"response.completed" })}\n\n`));
      c.close();
    }
  });
  return new Response(stream, { headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control":"no-cache" } });
}

// Stream an error message (still SSE) instead of throwing 500s at the browser
function sseError(text: string, cors: Record<string,string>) { return sseText(`[Error] ${text}`, cors); }
