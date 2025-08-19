// src/index.ts — Cloudflare Worker with SSE filtering
export interface Env {
  OPENAI_API_KEY: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*", // tighten to your domain if desired
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function sseError(message: string) {
  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  writer.write(enc.encode(`data: ${JSON.stringify({ type: "response.error", error: { message } })}\n\n`))
    .then(() => writer.close());
  return new Response(readable, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", ...CORS },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method === "GET") return json({ ok: true, hint: "POST JSON to stream responses." });
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    let body: any;
    try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }

    // Accept either messages[] or a single prompt
    const messages = body?.messages;
    const prompt = body?.prompt;
    const model = body?.model || "gpt-4o-mini-2024-07-18";
    const input = messages ?? [{ role: "user", content: String(prompt ?? "") }];

    if (!Array.isArray(input) || input.length === 0) {
      return json({ error: "Provide messages[] or prompt" }, 400);
    }

    // Call OpenAI Responses API with stream
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify({ model, input, stream: true }),
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      return sseError(`OpenAI upstream error: ${upstream.status} ${text}`);
    }

    // Filter SSE -> only forward text deltas + completed (+ errors)
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
              if (line.startsWith("event:")) evt.event = line.slice(6).trim();
              else if (line.startsWith("data:")) evt.data += (evt.data ? "\n" : "") + line.slice(5).trim();
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
            } catch {
              // ignore non-JSON frames
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
        "Connection": "keep-alive",
        ...CORS,
      },
    });
  },
};
