// src/index.ts
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const CORS = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method !== "POST")  return new Response("POST only", { status: 405, headers: CORS });

    if (!env.OPENAI_API_KEY?.startsWith("sk-")) {
      return new Response("Server misconfigured: missing OPENAI_API_KEY", { status: 500, headers: CORS });
    }
    if (!env.RAG_KV) {
      return new Response("Server misconfigured: missing RAG_KV binding", { status: 500, headers: CORS });
    }

    // Expect { messages:[...] }, use the latest user message as the query
    let body: any = {};
    try { body = await req.json(); } catch {}
    const messages = (body.messages ?? []) as Array<{role:string, content:string}>;
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    const q = lastUser?.content?.trim() || "";
    if (!q) return new Response("Empty query", { status: 400, headers: CORS });

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
      return new Response(`Embedding error: ${txt}`, { status: 502, headers: CORS });
    }
    const embJson = await embResp.json();
    const queryVec = embJson.data?.[0]?.embedding as number[] | undefined;
    if (!queryVec) return new Response("Embedding failed (no vector)", { status: 502, headers: CORS });

    // 2) Retrieve top-N chunks from KV using cosine similarity
    //    For small/med corpora this is fine; for large, move to Vectorize.
    const TOP_K = 5;
    const MAX_LIST_PAGES = 20;      // tune to your corpus size
    const KEY_PREFIX = "doc:";      // or restrict to a single doc: e.g., `doc:Week1-Ch1Ch2:`
    const MIN_SCORE = -1;           // keep all; raise to filter if noisy

    let cursor: string | undefined = undefined;
    let pages = 0;
    const candidates: Array<{ text: string; score: number; id?: string; docId?: string }> = [];

    do {
      const listed = await env.RAG_KV.list({ prefix: KEY_PREFIX, cursor });
      cursor = listed.cursor;
      pages++;

      // Fetch items in parallel but avoid huge concurrency bursts
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

      for (const item of batch) {
        if (item && item.score >= MIN_SCORE) candidates.push(item);
      }
    } while (cursor && pages < MAX_LIST_PAGES);

    candidates.sort((a, b) => b.score - a.score);
    const top = candidates.slice(0, TOP_K);
    const context = top.map((c, i) => `[#${i+1} ${c.docId ?? ""}] ${c.text}`).join("\n\n---\n\n");

    // 3) Build grounded prompt
    const grounded = [
      { role: "system", content: "You are a strict RAG assistant. Use ONLY the provided context. If the answer isn't in context, say you don't know." },
      { role: "user",   content: `Question: ${q}\n\nContext:\n${context || "(no context found)"}` },
    ];

    // 4) Call OpenAI Responses API and stream back to the browser
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: grounded,
        stream: true,
      }),
    });

    if (!upstream.ok) {
      const txt = await upstream.text();
      return new Response(`OpenAI error: ${txt}`, { status: 502, headers: CORS });
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

function cosineSim(a: number[], b: number[]) {
  if (!a || !b) return -1;
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}
