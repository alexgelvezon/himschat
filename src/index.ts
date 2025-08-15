export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const CORS = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };

    // ✅ Preflight response (browser sends this before the POST)
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (req.method !== "POST") {
      return new Response("POST only", { status: 405, headers: CORS });
    }

    if (!env.OPENAI_API_KEY?.startsWith("sk-")) {
      return new Response("Server misconfigured: missing OPENAI_API_KEY", { status: 500, headers: CORS });
    }

    // Expect { messages: [...] }
    let body: any = {};
    try { body = await req.json(); } catch {}
    const messages = body.messages ?? [];
    const lastUser = [...messages].reverse().find((m: any) => m.role === "user");
    const q = lastUser?.content ?? "";

    // (Optional) skip empty queries
    if (!q) return new Response("Empty query", { status: 400, headers: CORS });

    // Call OpenAI Responses API (streaming)
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: messages, // or build your own system+user array
        stream: true,
      }),
    });

    if (!upstream.ok) {
      const txt = await upstream.text();
      return new Response(`OpenAI error: ${txt}`, { status: 502, headers: CORS });
    }

    // ✅ Stream SSE back to browser with CORS
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
