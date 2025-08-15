// src/index.ts — strict RAG-only (no answers outside your docs)
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

    if (!env.OPENAI_API_KEY?.startsWith("sk-"))
      return new Response("Server misconfigured: missing OPENAI_API_KEY", { status: 500, headers: CORS });
    if (!env.RAG_KV)
      return new Response("Server misconfigured: missing RAG_KV binding", { status: 500, headers: CORS });

    // Parse input
    let body: any = {};
    try { body = await req.json(); } catch {}
    const messages = (body.messages ?? []) as Array<{role:string, content:string}>;
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    const q = lastUser?.content?.trim() || "";
    if (!q) return new Response("Empty query", { status: 400, headers: CORS });

    // ---- Retrieval knobs (tune for your corpus) ----
    const KEY_PREFIX = env.DOC_PREFIX || "doc:";  // e.g. "doc:Week1-Ch1Ch2:" to constrain to one PDF
    const MAX_LIST_PAGES = 5;                     // raise if you have many keys
    const TOP_K = 5;                              
    const MIN_SIMILARITY = 0.15;                  // tighten to be stricter (0.0–1.0)
    const MIN_MATCHES = 1;                        // require at least this many good chunks
    // ------------------------------------------------

    // 1) Embed query
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

    // 2) Retrieve from KV and score
    const candidates: Array<{ text: string; score: number; id?: string; docId?: string }> = [];
    let cursor: string | undefined = undefined;
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
    } catch (e) {
      // Retrieval failed — refuse instead of answering
      return sseText("Sorry, I can only answer from the provided documents, and I couldn’t access them right now.", CORS);
    }

    candidates.sort((a, b) => b.score - a.score);
    const top = candidates.filter(c => c.score >= MIN_SIMILARITY).slice(0, TOP_K);

    // If we don't have enough good matches, strictly refuse (no OpenAI call)
    if (top.length < MIN_MATCHES) {
      return sseText("Sorry, I don’t have enough information in the uploaded documents to answer that.", CORS);
    }

    const context = top.map((c, i) => `[#${i+1} ${c.docId ?? ""}] ${c.text}`).join("\n\n---\n\n");

    // 3) Strict grounded prompt
    const grounded = [
      { role: "system", content:
        "You are a STRICT RAG assistant. Use ONLY the provided context to answer. " +
        "If the answer is not fully supported by the context, respond exactly with: \"I don’t know based on the provided documents.\" " +
        "Do not speculate or use outside knowledge."
      },
      { role: "user", content: `Question: ${q}\n\nContext:\n${context}` },
    ];

    // 4) Call OpenAI and stream
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

// Cosine similarity
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

// Stream a simple refusal message as SSE that your frontend can display
function sseText(text: string, corsHeaders: Record<string,string>) {
  // Minimal set of events your page understands: delta + completed
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const msg1 = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`;
      const msg2 = `data: ${JSON.stringify({ type: "response.completed" })}\n\n`;
      controller.enqueue(encoder.encode(msg1));
      controller.enqueue(encoder.encode(msg2));
      controller.close();
    }
  });
  return new Response(stream, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
