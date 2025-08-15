export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return new Response("POST only", { status: 405, headers: cors });

    if (!env.OPENAI_API_KEY?.startsWith("sk-")) {
      return new Response("Server misconfigured: missing OPENAI_API_KEY", { status: 500, headers: cors });
    }

    // Expect either { messages: [...] } for chat, or { q: "..." } direct.
    const body = await req.json().catch(() => ({}));
    const messages = body.messages as Array<{ role: string; content: string }> | undefined;
    const q = body.q ?? messages?.slice().reverse().find(m => m.role === "user")?.content ?? "";

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
      return new Response(`Embedding error: ${txt}`, { status: 500, headers: cors });
    }
    const embJson = await embResp.json();
    const queryVec = embJson.data[0].embedding as number[];

    // 2) Retrieve top-N chunks from KV using cosine similarity
    let cursor: string | undefined = undefined;
    const candidates: Array<{ text: string; score: number }> = [];
    const MAX_LIST_PAGES = 20; // tune for your corpus size
    let pages = 0;
    do {
      const list = await env.RAG_KV.list({ prefix: "doc:", cursor });
      cursor = list.cursor;
      pages++;
      for (const key of list.keys) {
        const item = await env.RAG_KV.get(key.name);
        if (!item) continue;
        const obj = JSON.parse(item);
        const score = cosineSim(queryVec, obj.embedding);
        candidates.push({ text: obj.text as string, score });
      }
    } while (cursor && pages < MAX_LIST_PAGES);

    candidates.sort((a, b) => b.score - a.score);
    const context = candidates.slice(0, 5).map(c => c.text).join("\n\n---\n\n");

    // 3) Build prompt (system + grounded user turn)
    const grounded = [
      { role: "system", content: "You are a strict RAG assistant. Use ONLY the provided context. If the answer isn't in context, say you don't know." },
      { role: "user", content: `Question: ${q}\n\nContext:\n${context}` },
    ];

    // 4) Call Responses API and stream back to the browser
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o-mini", input: grounded, stream: true }),
    });

    if (!upstream.ok) {
      const txt = await upstream.text();
      return new Response(`OpenAI error: ${txt}`, { status: 500, headers: cors });
    }

    return new Response(upstream.body, {
      headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  },
} satisfies ExportedHandler<Env>;

function cosineSim(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}
