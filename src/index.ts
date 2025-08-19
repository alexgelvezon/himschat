// index.ts — Cloudflare Worker (SSE-filtered proxy for OpenAI Responses)
/**
 * Deploy with Wrangler:
 *   wrangler deploy
 *
 * Bind OPENAI_API_KEY in your wrangler.toml/jsonc:
 *   [vars]
 *   OPENAI_API_KEY = "sk-..."
 */

export interface Env {
  OPENAI_API_KEY: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten to your domain if desired
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

function sseError(message: string) {
  const enc = new TextEncoder();
  const ts = new TransformStream();
  const writer = ts.writable.getWriter();
  writer.write(enc.encode(`data: ${JSON.stringify({ type: "response.error", error: { message } })}\n\n`))
    .then(() => writer.close());
  return new Response(ts.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS_HEADERS,
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Simple health check
    if (req.method === "GET") {
      return jsonResponse({ ok: true, hint: "POST JSON to stream responses." });
    }

    if (req.method !== "POST") {
      return jsonResponse({ error: "POST only" }, 405);
    }

    // Parse input
    let body: any;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "invalid JSON" }, 400);
    }

    const messages = body?.messages;
    const prompt = body?.prompt;
    const model = body?.model || "gpt-4o-mini-2024-07-18";

    if (!messages && !prompt) {
      return jsonResponse({ error: "Provide messages[] or prompt" }, 400);
    }

    const input = messages
      ? messages
      : [{ role: "user", content: String(prompt) }];

    // Call OpenAI Responses (SSE)
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify({
        model,
        input,
        stream: true,
        // You can set other response options here if you need them
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      return sseError(`OpenAI upstream error: ${upstream.status} ${text}`);
    }

    // Filter SSE -> emit only output_text.delta and completed
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    async function emit(obj: unknown) {
      await writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
    }

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);

            const evt = { event: "", data: "" };
            for (const line of raw.split("\n")) {
              if (line.startsWith("event:")) {
                evt.event = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                evt.data += (evt.data ? "\n" : "") + line.slice(5).trim();
              }
            }

            if (!evt.data) continue;
            try {
              const obj = JSON.parse(evt.data);
              const t = obj.type;

              if (t === "response.output_text.delta" && obj.delta) {
                await emit({ type: t, delta: obj.delta });
              } else if (t === "response.completed") {
                await emit({ type: t });
              } else if (t === "response.error" && obj.error) {
                await emit({ type: t, error: obj.error });
              }
              // Ignore other verbose events
            } catch {
              // non-JSON data frames can be ignored
            }
          }
        }
      } catch (e: any) {
        await emit({ type: "response.error", error: { message: e?.message || String(e) } });
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...CORS_HEADERS,
      },
    });
  },
};
