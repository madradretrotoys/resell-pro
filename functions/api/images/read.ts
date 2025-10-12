// functions/api/images/read.ts
// GET /api/images/read?tenant_id=...&key=...  OR mount behind a friendly route.
// Sets long-lived cache headers and streams from R2.

const notFound = () => new Response("Not found", { status: 404 });

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  const url = new URL(request.url);
  const tenant_id = url.searchParams.get("tenant_id") || "";
  const key = url.searchParams.get("key") || "";
  if (!tenant_id || !key) return notFound();

  const r2_key = `${tenant_id}/${key}`;
  // @ts-ignore
  const obj = await env.R2_IMAGES.get(r2_key);
  if (!obj) return notFound();

  const headers = new Headers();
  headers.set("content-type", obj.httpMetadata?.contentType || "application/octet-stream");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("etag", obj.httpEtag);

  return new Response(obj.body, { status: 200, headers });
};
