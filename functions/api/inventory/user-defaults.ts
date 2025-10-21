// Cloudflare Pages Function for per-user marketplace defaults (eBay first).
// Conventions match your other inventory APIs: cookie presence, x-tenant-id header, Neon client.

import { neon } from "@neondatabase/serverless";

type Env = { DATABASE_URL?: string; NEON_DATABASE_URL?: string };

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "vary": "Cookie",
    },
  });

function getSql(env: Env) {
  const url = env.DATABASE_URL || env.NEON_DATABASE_URL;
  if (!url) throw new Error("missing_db_url");
  return neon(url);
}

// Helper to resolve marketplace_id by slug (we’ll use 'ebay')
async function getMarketplaceId(sql: any, slug: string) {
  const rows = await sql/*sql*/`
    select id
    from app.marketplaces_available
    where key = ${slug}
    limit 1
  `;
  return rows?.[0]?.id ?? null;
}

// GET /api/inventory/user-defaults?marketplace=ebay
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  try {
    const cookie = request.headers.get("cookie");
    if (!cookie) return json({ ok: false, error: "no_cookie" }, 401);

    const tenantId = request.headers.get("x-tenant-id") || "";
    if (!tenantId) return json({ ok: false, error: "no_tenant" }, 400);

    const { searchParams } = new URL(request.url);
    const marketplace = (searchParams.get("marketplace") || "ebay").toLowerCase();

    const sql = getSql(env);
    const marketplaceId = await getMarketplaceId(sql, marketplace);
    if (!marketplaceId) return json({ ok: false, error: "unknown_marketplace" }, 400);

    // Expect your app to set current_setting('app.user_id') in DB session (as elsewhere)
    const rows = await sql/*sql*/`
      select
        shipping_policy,
        payment_policy,
        return_policy,
        shipping_zip,
        pricing_format,
        allow_best_offer,
        promote
      from app.user_marketplace_defaults
      where tenant_id = ${tenantId}
        and user_id = current_setting('app.user_id', true)::uuid
        and marketplace_id = ${marketplaceId}
      limit 1
    `;

    const defaults = rows?.[0] || null;
    return json({ ok: true, marketplace, marketplace_id: marketplaceId, defaults });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};

// PUT /api/inventory/user-defaults?marketplace=ebay
// Body: { defaults: { shipping_policy, payment_policy, return_policy, shipping_zip, pricing_format, allow_best_offer, promote } }
export const onRequestPut: PagesFunction<Env> = async ({ request, env }) => {
  try {
    const cookie = request.headers.get("cookie");
    if (!cookie) return json({ ok: false, error: "no_cookie" }, 401);

    const tenantId = request.headers.get("x-tenant-id") || "";
    if (!tenantId) return json({ ok: false, error: "no_tenant" }, 400);

    const { searchParams } = new URL(request.url);
    const marketplace = (searchParams.get("marketplace") || "ebay").toLowerCase();

    const body = await request.json().catch(() => ({}));
    const raw = body?.defaults || {};
    if (!raw || typeof raw !== "object") return json({ ok: false, error: "bad_payload" }, 400);

    // Whitelist only the 7 fields we remember (explicitly ignore auto_accept_amount, minimum_offer_amount)
    const safe = {
      shipping_policy: raw.shippin_
