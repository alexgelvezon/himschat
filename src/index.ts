export interface Env { }

const CORS = {
  "Access-Control-Allow-Origin": "*", // set to your site origin in prod
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    // 1) Minimal SSE that *must* stream "tick 1..10"
    if (url.pathname === "/sse-test") {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const enc = new TextEncoder();

      (async () => {
        try {
          for (let i = 1; i <= 10; i++) {
            await writer.write(enc.encode(`data: tick ${i}\n\n`));
            await new Promise(r => setTimeout(r, 250));
          }
          await writer.write(enc.encode(`data: [DONE]\n\n`));
        } finally {
          writer.close();
        }
      })();

      return new Response(readable, {
        headers: {
          ...CORS,
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
          "connection": "keep-alive",
        },
      });
    }

    // 2) Plain echo (no SSE) so you know POST works and returns immediately
    if (url.pathname === "/echo" && req.method === "POST") {
      const body = await req.text();
      return new Response(`echo: ${body}`, { headers: { ...CORS, "content-type": "text/plain" } });
    }

    // 3) Optional: headers debug to catch CORS/preflight/routing issues
    if (url.pathname === "/debug/headers") {
      const entries: Record<string, string> = {};
      for (const [k, v] of req.headers) entries[k] = v;
      return new Response(JSON.stringify(entries, null, 2), {
        headers: { ...CORS, "content-type": "application/json" },
      });
    }

    return new Response("ok", { headers: CORS });
  }
};
