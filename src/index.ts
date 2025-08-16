// src/index.ts
export interface Env {
  RAG_KV: KVNamespace;
  OPENAI_API_KEY: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*", // set to your origin in prod
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname === "/chat" && req.method === "POST") {
      try {
        const { message = "" } = await req.json().catch(() => ({}));
        const context = await retrieveKVContext(env, message);

        const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "authorization": `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            stream: true,
            temperature: 0.2,
            messages: [
              {
                role: "system",
                content:
                  "Answer only from the provided context. If the context is empty or irrelevant, say: Sorry, I can only answer from the provided documents, and I couldn’t access them right now.",
              },
              {
                role: "user",
                content:
                  (context.length
                    ? "Context:\n" +
                      context.map((c, i) => `(${i + 1}) ${c}`).join("\n\n")
                    : "Context: [none]") +
                  `\n\nQuestion: ${message}`,
              },
            ],
          }),
        });

        if (!upstream.ok || !upstream.body) {
          return jsonErr(`OpenAI error ${upstream.status}`, 502);
        }

        // Convert OpenAI JSON SSE → plain text SSE
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const enc = new TextEncoder();

        // heartbeat to keep proxies from buffering
        const hb = setInterval(() => {
          writer.write(enc.encode(":hb\n\n"));
        }, 15000);

        (async () => {
          try {
            const reader = upstream.body!.getReader();
            let buffer = "";
            const dec = new TextDecoder();

            // Tell client we're streaming
            await writer.write(enc.encode("event: start\ndata: ok\n\n"));

            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += dec.decode(value, { stream: true });

              // OpenAI streams as SSE blocks separated by \n\n
              const blocks = buffer.split("\n\n");
              buffer = blocks.pop() || "";

              for (const blk of blocks) {
                // Each block typically starts with "data: {json}"
                for (const line of blk.split("\n")) {
                  if (!line.startsWith("data:")) continue;
                  const payload = line.slice(5).trim();
                  if (payload === "[DONE]") {
                    await writer.write(enc.encode("data: [DONE]\n\n"));
                    clearInterval(hb);
                    writer.close();
                    return;
                  }
                  try {
                    const j = JSON.parse(payload);
                    const token = j.choices?.[0]?.delta?.content ?? "";
                    if (token) {
                      // PLAIN TEXT SSE for your client
                      await writer.write(enc.encode(`data: ${token}\n\n`));
                    }
                  } catch {
                    // If it isn't JSON, ignore or forward raw
                  }
                }
              }
            }

            // graceful end
            await writer.write(enc.encode("data: [DONE]\n\n"));
          } catch (e) {
            await writer.write(
              enc.encode(`event: error\ndata: ${String(e).replace(/\n/g, " ")}\n\n`)
            );
          } finally {
            clearInterval(hb);
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
      } catch (e: any) {
        return jsonErr(e?.message || String(e), 500);
      }
    }

    // simple ping
    if (url.pathname === "/debug/ping") {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        headers: { ...CORS, "content-type": "application/json" },
      });
    }

    return new Response("ok", { headers: CORS });
  },
};

function jsonErr(msg: string, code = 500) {
  return new Response(JSON.stringify({ error: msg }), {
    status: code,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

// tiny KV keyword retriever (optional)
async function retrieveKVContext(env: Env, q: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const listed = await env.RAG_KV.list({ prefix: "docs:", limit: 50 });
    const needle = q.toLowerCase();
    for (const k of listed.keys) {
      const doc = await env.RAG_KV.get(k.name, "json").catch(() => null) as any;
      if (!doc) continue;
      const text = String(doc.content ?? doc.text ?? "").toLowerCase();
      if (!text) continue;
      if (!needle || text.includes(needle)) {
        out.push(snippet(text, needle));
        if (out.length >= 5) break;
      }
    }
  } catch {}
  return out;
}

function snippet(text: string, needle: string, span = 360) {
  const i = needle ? text.indexOf(needle) : 0;
  const start = Math.max(0, (i < 0 ? 0 : i) - Math.floor(span / 2));
  return text.slice(start, start + span);
}
