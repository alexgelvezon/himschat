// src/index.ts
export interface Env {
  RAG_KV: KVNamespace; // <-- must match your wrangler binding name
  // If you named it "KV" instead, change to: KV: KVNamespace
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'GET,OPTIONS'
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Preflight
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // ---- DEBUG: LIST KEYS ----
    if (url.pathname === '/debug/kv/list' && req.method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';          // e.g. ?prefix=docs:
      const limit = Number(url.searchParams.get('limit') ?? '20');   // up to 1000
      const cursor = url.searchParams.get('cursor') ?? undefined;    // paginate

      try {
        const listed = await env.RAG_KV.list({ prefix, limit, cursor });
        // listed = { keys: [{name, expiration, metadata}], list_complete, cursor }
        return Response.json(listed, { headers: CORS });
      } catch (e: any) {
        return new Response(`KV list error: ${e?.message || e}`, { status: 500, headers: CORS });
      }
    }

    // ---- DEBUG: GET VALUE ----
    if (url.pathname === '/debug/kv/get' && req.method === 'GET') {
      const key = url.searchParams.get('key');            // e.g. ?key=docs:001
      const asJson = url.searchParams.get('json') === '1';

      if (!key) return new Response('Missing ?key=', { status: 400, headers: CORS });

      try {
        const val = asJson ? await env.RAG_KV.get(key, 'json') : await env.RAG_KV.get(key);
        if (val === null) return new Response('null', { headers: { ...CORS, 'content-type': 'text/plain' } });

        return new Response(
          asJson ? JSON.stringify(val, null, 2) : String(val),
          { headers: { ...CORS, 'content-type': asJson ? 'application/json' : 'text/plain' } }
        );
      } catch (e: any) {
        return new Response(`KV get error: ${e?.message || e}`, { status: 500, headers: CORS });
      }
    }

    // ---- your existing app handler below ----
    return new Response('ok', { headers: CORS });
  }
};
