// src/index.ts
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const CORS = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };

    // Health check & preflight
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method === "GET")     return new Response("OK", { headers: CORS });
    if (req.method !== "POST")    return new Response("POST only", { status: 405, headers: CORS });

    if (!env.OPENAI_API_KEY?.startsWith("sk-"))
      return new Response("Server misconfigured: missing OPENAI_API_KEY", { status: 500, headers: CORS });

    let body: any = {};
    try { body = await req.json(); } catch {}
    const messages = (body.messages ?? []) as Array<{role:string, content:string}>;
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    const q = lastUser?.content?.trim() || "";
    if (!q) return new Response("Empty query", { status: 400, headers: CORS });

    // --- Retrieval settings (tune these) ---
    const TOP_K = 5;
    const MAX_LIST_PAGES = 5;                 // keep small to avoid long scans
    const KEY_PREFIX = env.DOC_PREFIX || "doc:"; // e.g., set to "doc:Week1-Ch1Ch2:" via wrangler var
    const MIN_SCORE = -1;

    // Try RAG; on any failure, fall back to plain chat
    let groundedInput: Array<{role:string, content:string}> | null = null;

    try {
      if (!env.RAG_KV) throw new Error("No RAG_KV binding");

      // 1) Embed query
      const embResp = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "text-embedding-3-small", input: q }),
      });
      if (!embResp.ok) throw new Error(`Embedding error: ${await embResp.text()}`);
      const embJson = await embResp.json();
      const queryVec = embJson.data?.[0]?.embedding as number[] | undefined;
      if (!queryVec) throw new Error("Embedding failed (no vector)");

      // 2) Retrieve (bounded scan)
      const candidates: Array<{ text: string; score: number; id?: string; docId?: string }> = [];
      let cursor: string | undefined = undefined;
      let pages = 0;

      do {
        const listed = await env.RAG_KV.list({ prefix: KEY_PREFIX, cursor });
        cursor = listed.cursor;
        pages++;

        // fetch values in small parallel chunks
        const batchVals = await Promise.all(
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

        for (const item of batchVals) {
          if (item && item.score >= MIN_SCORE) candidates.push(item);
        }
      } while (cursor && pages < MAX_LIST_PAGES);

      candidates.sort((a, b) => b.score - a.score);
      const top = candidates.slice(0, TOP_K);
      const context = top.map((c, i) => `[#${i+1} ${c.docId ?? ""}] ${c.text}`).join("\n\n---\n\n");

      groundedInput = [
        { role: "system", content: "You are a strict RAG assistant. Use ONLY the provided context. If the answer isn't in context, say you don't know." },
        { role: "user",   content: `Question: ${q}\n\nContext:\n${context || "(no context found)"}` },
      ];
    } catch (e: any) {
      // Fall back (plain chat) — but keep CORS so the page doesn’t show “network error”
      groundedInput = messages.length
        ? messages
        : [{ role: "user", content: q }];
    }

    // 3) Call OpenAI and stream
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: groundedInput,
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
