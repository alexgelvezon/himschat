// src/index.ts
import { Ai } from "@cloudflare/ai";

export interface Env {
  OPENAI_API_KEY: string;
  RAG_KV: KVNamespace;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (req.method !== "POST") {
      return new Response("Only POST supported", { status: 405 });
    }

    try {
      const { messages } = await req.json<{ messages: { role: string; content: string }[] }>();
      const userMsg = messages[messages.length - 1].content;

      // 1. Retrieve docs from KV
      const kvKeys = await env.RAG_KV.list({ prefix: "doc:" });
      if (!kvKeys.keys.length) {
        return new Response(JSON.stringify({
          type: "error",
          message: "No documents available. Please upload first."
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      // For now, just grab first few docs (in production you'd filter by embeddings)
      const docs = [];
      for (const key of kvKeys.keys.slice(0, 5)) {
        const text = await env.RAG_KV.get(key.name);
        if (text) docs.push(text);
      }

      if (!docs.length) {
        return new Response(JSON.stringify({
          type: "error",
          message: "I couldn’t find any context in your documents."
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      // 2. Call OpenAI API with docs as context
      const prompt = `Answer based ONLY on the following docs:\n\n${docs.join("\n\n")}\n\nUser: ${userMsg}`;

      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are a helpful assistant. Only answer using the provided docs. If unsure, say 'Sorry, I don’t know from the documents provided.'" },
            { role: "user", content: prompt },
          ],
          stream: true,
        }),
      });

      // 3. Stream back to client
      return new Response(resp.body, {
        headers: {
          "Content-Type": "text/event-stream",
          "Access-Control-Allow-Origin": "*",
        },
      });

    } catch (err: any) {
      return new Response(JSON.stringify({
        type: "error",
        message: err?.message || "Unknown error"
      }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
  },
};
