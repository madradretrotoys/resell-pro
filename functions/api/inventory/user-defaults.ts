
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

// --- local helpers (module-scoped) ---

function readCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/; */)) {
    const [k, ...rest] = part.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

async function verifyJwt(token: string, secret: string): Promise<any> {
  const enc = new TextEncoder();
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new Error("bad_token");
  const base64urlToBytes = (str: string) => {
    const pad = "=".repeat((4 - (str.length % 4)) % 4);
    const b64 = (str + pad).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };
  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(String((secret || ""))),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify("HMAC", key, base64urlToBytes(s), enc.encode(data));
  if (!ok) throw new Error("bad_sig");
  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(p)));
  if ((payload as any)?.exp && Date.now() / 1000 > (payload as any).exp) throw new Error("expired");
  return payload;
}

// GET /api/inventory/user-defaults?marketplace=ebay
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  try {
    const cookieHeader = request.headers.get("cookie") || "";
    if (!cookieHeader) return json({ ok: false, error: "no_cookie" }, 401);

    // Resolve actor from the same JWT pattern used by intake.ts
    const token = readCookie(cookieHeader, "__Host-rp_session");
    if (!token) return json({ ok: false, error: "no_cookie" }, 401);
    const payload = await verifyJwt(token, String((env as any).JWT_SECRET));
    const actor_user_id = String((payload as any).sub || "");
    if (!actor_user_id) return json({ ok: false, error: "bad_token" }, 401);

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
        and user_id = ${actor_user_id}
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
    const cookieHeader = request.headers.get("cookie") || "";
    if (!cookieHeader) return json({ ok: false, error: "no_cookie" }, 401);

    // Resolve actor from JWT (same pattern as intake.ts)
    const token = readCookie(cookieHeader, "__Host-rp_session");
    if (!token) return json({ ok: false, error: "no_cookie" }, 401);
    const payload = await verifyJwt(token, String((env as any).JWT_SECRET));
    const actor_user_id = String((payload as any).sub || "");
    if (!actor_user_id) return json({ ok: false, error: "bad_token" }, 401);

    const tenantId = request.headers.get("x-tenant-id") || "";
    if (!tenantId) return json({ ok: false, error: "no_tenant" }, 400);

    const { searchParams } = new URL(request.url);
    const marketplace = (searchParams.get("marketplace") || "ebay").toLowerCase();

    const body = await request.json().catch(() => ({}));
    const raw = body?.defaults || {};
    if (!raw || typeof raw !== "object") return json({ ok: false, error: "bad_payload" }, 400);

    // Whitelist only the 7 fields we remember …
    const tidy = (v: any) => {
      if (v === null || v === undefined) return null;
      if (typeof v === "string") return v.trim();
      return v;
    };
    const toBool = (v: any) => {
      if (v === null || v === undefined) return null;
      return Boolean(v);
    };
    const normFormat = (v: any) => {
      const s = String(v || "").trim().toLowerCase();
      return s === "fixed" || s === "auction" ? s : null;
    };
    
    const safe = {
      shipping_policy:  tidy(raw.shipping_policy),
      payment_policy:   tidy(raw.payment_policy),
      return_policy:    tidy(raw.return_policy),
      shipping_zip:     tidy(raw.shipping_zip),
      pricing_format:   normFormat(raw.pricing_format),
      allow_best_offer: toBool(raw.allow_best_offer),
      promote:          toBool(raw.promote),
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
          ${actor_user_id},
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
