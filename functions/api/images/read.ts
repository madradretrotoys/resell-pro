// Begin functions/api/images/read.ts
// functions/api/images/read.ts
// GET /api/images/read?tenant_id=...&key=...  OR mount behind a friendly route.
// Sets long-lived cache headers and streams from R2.

const notFound = () => new Response("Not found", { status: 404 });

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  const url = new URL(request.url);
  const tenant_id = url.searchParams.get("tenant_id") || "";
  const key = url.searchParams.get("key") || "";
  if (!tenant_id || !key) return notFound();

  // Handle preflight (defensive; GETs for images usually won’t hit this, but it’s safe to support)
  if (request.method === "OPTIONS") {
    const preflightHeaders = new Headers();
    const origin = request.headers.get("origin") || "*";
    preflightHeaders.set("Access-Control-Allow-Origin", origin);
    preflightHeaders.set("Vary", "Origin");
    preflightHeaders.set("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
    preflightHeaders.set("Access-Control-Allow-Headers", "*");
    preflightHeaders.set("Access-Control-Max-Age", "86400");
    return new Response(null, { status: 204, headers: preflightHeaders });
  }

  
  const r2_key = `${tenant_id}/${key}`;
  // @ts-ignore
  const obj = await env.R2_IMAGES.get(r2_key);
  if (!obj) return notFound();

  const headers = new Headers();
  headers.set("content-type", obj.httpMetadata?.contentType || "application/octet-stream");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("etag", obj.httpEtag);

  // CORS: allow your app origin (and make it vary on Origin)
  const origin = request.headers.get("origin") || "*";
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  
  return new Response(obj.body, { status: 200, headers });
};
// end functions/api/images/read.ts
