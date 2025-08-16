// src/index.ts — clean, Responses API, SSE always, strict RAG if docs exist
export interface Env {
  OPENAI_API_KEY: string;
  RAG_KV: KVNamespace;
  DOC_PREFIX?: string; // optional: set in wrangler vars to restrict to one doc, e.g. "doc:Week1-Ch1Ch2:"
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

    // Basic guards
    if (!env.OPENAI_API_KEY?.startsWith("sk-"))
      return sseError("Server misconfigured: missing OPENAI_API_KEY", CORS);
    if (!q) return sseError("Empty query.", CORS);

    // If KV not bound, just refuse (keeps behavior strict to RAG)
    if (!env.RAG_KV) return sseError("No document store is configured.", CORS);

    // ---------- Retrieval (strict) ----------
    const KEY_PREFIX = (env.DOC_PREFIX ?? "doc:"); // restrict if desired
    const MAX_LIST_PAGES = 5;    // raise if you have lots of chunks
    const TOP_K = 5;
    const MIN_SIM = 0.20;        // tighten/loosen as you wish

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
    if (!queryVec) return sseError("Em
