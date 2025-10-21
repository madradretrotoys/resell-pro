
// Begin Cloudflare Pages Function for per-user marketplace defaults.
// Matches your inventory API conventions: cookie presence, x-tenant-id header, Neon client.

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

async function getMarketplaceId(sql: any, slug: string) {
  const rows = await sql/*sql*/`
    select id
    from app.marketplaces_available
    where slug = ${slug}
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

    return json({
      ok: true,
      marketplace,
      marketplace_id: marketplaceId,
      defaults: rows?.[0] || null,
    });
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
      shipping_policy:  raw.shipping_policy  ?? raw.shipping_policy_id ?? null,
      payment_policy:   raw.payment_policy   ?? raw.payment_policy_id  ?? null,
      return_policy:    raw.return_policy    ?? raw.return_policy_id   ?? null,
      shipping_zip:     raw.shipping_zip     ?? raw.ship_from_zip      ?? null,
      pricing_format:   raw.pricing_format   ?? null,  // "fixed" | "auction"
      allow_best_offer: typeof raw.allow_best_offer === "boolean" ? raw.allow_best_offer : null,
      promote:          typeof raw.promote === "boolean" ? raw.promote : null,
    };

    const sql = getSql(env);
    const marketplaceId = await getMarketplaceId(sql, marketplace);
    if (!marketplaceId) return json({ ok: false, error: "unknown_marketplace" }, 400);

    const up = await sql/*sql*/`
      insert into app.user_marketplace_defaults
        (tenant_id, user_id, marketplace_id,
         shipping_policy, payment_policy, return_policy, shipping_zip,
         pricing_format, allow_best_offer, promote)
      values
        (
          ${tenantId},
          current_setting('app.user_id', true)::uuid,
          ${marketplaceId},
          ${safe.shipping_policy},
          ${safe.payment_policy},
          ${safe.return_policy},
          ${safe.shipping_zip},
          ${safe.pricing_format},
          ${safe.allow_best_offer},
          ${safe.promote}
        )
      on conflict (tenant_id, user_id, marketplace_id)
      do update set
        shipping_policy  = excluded.shipping_policy,
        payment_policy   = excluded.payment_policy,
        return_policy    = excluded.return_policy,
        shipping_zip     = excluded.shipping_zip,
        pricing_format   = excluded.pricing_format,
        allow_best_offer = excluded.allow_best_offer,
        promote          = excluded.promote,
        updated_at       = now()
      returning
        shipping_policy,
        payment_policy,
        return_policy,
        shipping_zip,
        pricing_format,
        allow_best_offer,
        promote
    `;

    return json({
      ok: true,
      marketplace,
      marketplace_id: marketplaceId,
      defaults: up?.[0] || safe,
    });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
//end user-defauts.ts
