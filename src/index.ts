// src/index.ts
export interface Env {
  RAG_KV: KVNamespace;          // <- your KV binding (rename if needed)
  OPENAI_API_KEY?: string;      // <- add via `wrangler secret put OPENAI_API_KEY`
  // If you use a different provider, adjust `callLLM` below.
}

const CORS = {
  "Access-Control-Allow-Origin": "*", // set to your site origin in prod
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // ---------- Health ----------
    if (url.pathname === "/debug/ping") {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        headers: { ...CORS, "content-type": "application/json" }
      });
    }

    // ---------- (Optional) KV Debug ----------
    if (url.pathname === "/debug/kv/list" && req.method === "GET") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? "20");
      const cursor = url.searchParams.get("cursor") ?? undefined;
      try {
        const listed = await env.RAG_KV.list({ prefix, limit, cursor });
        return Response.json(listed, { headers: CORS });
      } catch (e: any) {
        return new Response(`KV list error: ${e?.message || e}`, { status: 500, headers: CORS });
      }
    }
    if (url.pathname === "/debug/kv/get" && req.method === "GET") {
      const key = url.searchParams.get("key");
      const asJson = url.searchParams.get("json") === "1";
      if (!key) return new Response("Missing ?key=", { status: 400, headers: CORS });
      try {
        const val = asJson ? await env.RAG_KV.get(key, "json") : await env.RAG_KV.get(key);
        if (val === null) return new Response("null", { headers: { ...CORS, "content-type": "text/plain" } });
        return new Response(
          asJson ? JSON.stringify(val, null, 2) : String(val),
          { headers: { ...CORS, "content-type": asJson ? "application/json" : "text/plain" } }
        );
      } catch (e: any) {
        return new Response(`KV get error: ${e?.message || e}`, { status: 500, headers: CORS });
      }
    }

    // ---------- Chat (streams SSE) ----------
    if (url.pathname === "/chat" && req.method === "POST") {
      try {
        const body = await req.json().catch(() => ({}));
        const userMessage = String(body?.message ?? "").trim();
        const filters = body?.filters ?? null; // if you add KV filters later

        // 1) Retrieve context from KV (keyword style; optional)
        const contextSnippets = await kvRetrieve(env, userMessage, { prefix: "docs:", limit: 50 });

        // 2) Call your LLM with streaming enabled
        const upstream = await callLLM(env, userMessage, contextSnippets);

        // If no streaming upstream, fallback to a locally streamed demo
        if (!upstream?.body) {
          return demoLocalStream("No upstream stream; using local demo.", 5);
        }

        // 3) Pipe upstream SSE → client SSE (and CLOSE it)
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const reader = upstream.body.getReader();

        // Forward headers for SSE
        const sseHeaders = {
          ...CORS,
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
          "connection": "keep-alive",
        };

        (async () => {
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              // Write raw upstream chunks (they should already be SSE lines)
              await writer.write(value);
            }
            // Always send a final done event and close
            const enc = new TextEncoder();
            await writer.write(enc.encode("data: [DONE]\n\n"));
          } catch (err) {
            // Send an SSE error line so the client can surface it
            const enc = new TextEncoder();
            await writer.write(enc.encode(`event: error\ndata: ${escapeSSE(String(err))}\n\n`));
          } finally {
            writer.close();
          }
        })();

        return new Response(readable, { headers: sseHeaders });
      } catch (e: any) {
        // Return a clear JSON error (not SSE) if something blew up before streaming started
        return new Response(JSON.stringify({ error: e?.message || String(e) }), {
          status: 500,
          headers: { ...CORS, "content-type": "application/json" }
        });
      }
    }

    // Fallback (your site/assets/router could go here)
    return new Response("ok", { headers: CORS });
  }
};

// ---- Helpers ----

// Minimal KV "retrieval" (keyword match across small set). Replace with Vectorize for semantic search.
async function kvRetrieve(env: Env, query: string, opt?: { prefix?: string; limit?: number }) {
  const prefix = opt?.prefix ?? "";
  const limit = Math.min(opt?.limit ?? 50, 200);
  const q = query.toLowerCase();
  const out: string[] = [];

  try {
    const listed = await env.RAG_KV.list({ prefix, limit });
    for (const k of listed.keys) {
      const doc = await env.RAG_KV.get(k.name, "json").catch(() => null) as any;
      if (!doc) continue;
      const hay = String(doc?.content ?? doc?.text ?? "").toLowerCase();
      if (!hay) continue;
      if (q && hay.includes(q)) out.push(trimSnippet(hay, q, 360));
      if (out.length >= 5) break;
    }
  } catch {
    // swallow; retrieval errors should not hang the stream
  }
  return out;
}

function trimSnippet(text: string, needle: string, span = 360) {
  const i = text.indexOf(needle);
  if (i < 0) return text.slice(0, span);
  const start = Math.max(0, i - Math.floor(span / 2));
  return text.slice(start, start + span);
}

// Calls OpenAI with streaming enabled and includes retrieved context
async function callLLM(env: Env, userMessage: string, context: string[]) {
  if (!env.OPENAI_API_KEY) return null; // caller will switch to demo stream

  // Compose a compact system prompt that enforces "answer only from context" if you want that behavior
  const system = [
    "You are a helpful assistant for a small RAG bot.",
    "Only answer using the provided context. If the context is empty or irrelevant, say:",
    "\"Sorry, I can only answer from the provided documents, and I couldn’t access them right now.\"",
  ].join(" ");

  const ctxBlock = context.length
    ? "Context:\n" + context.map((c, i) => `(${i + 1}) ${c}`).join("\n\n")
    : "Context: [none]";

  // OpenAI Responses/Chat Completions that return SSE:
  // We'll use the Chat Completions SSE style for broad compatibility.
  const body = {
    model: "gpt-4o-mini",          // choose your model
    stream: true,                  // IMPORTANT: request streaming
    messages: [
      { role: "system", content: system },
      { role: "user", content: `${ctxBlock}\n\nQuestion: ${userMessage}` }
    ],
    temperature: 0.2
  };

  // Note: The OpenAI SSE stream comes back as "text/event-stream".
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    // Surface a JSON error upstream; caller converts to non-SSE error response
    throw new Error(`OpenAI error ${res.status}`);
  }
  return res;
}

// Simple local demo stream (useful when OPENAI_API_KEY is not set)
function demoLocalStream(text: string, steps = 5): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  (async () => {
    // SSE headers are set by caller; we only write body here
    for (let i = 0; i < steps; i++) {
      await writer.write(enc.encode(`data: ${text} [${i + 1}/${steps}]\n\n`));
      await new Promise(r => setTimeout(r, 250));
    }
    await writer.write(enc.encode(`data: [DONE]\n\n`));
    writer.close();
  })();

  return new Response(readable, {
    headers: {
      ...CORS,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      "connection": "keep-alive",
    }
  });
}

function escapeSSE(s: string) {
  // Keep it simple; SSE is line-oriented
  return s.replace(/\r?\n/g, " ");
}
