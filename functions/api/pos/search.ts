// /api/pos/search — POS inventory search with primary image + DIAGNOSTIC LOGGING
// - Auth: session cookie + x-tenant-id header (added by api() helper on the client)
// - Returns: { ok: true, items: [{ item_id, sku, product_short_title, price, qty, instore_loc, case_bin_shelf, image_url }] }

import { neon } from "@neondatabase/serverless";

type Role = "owner" | "admin" | "manager" | "clerk";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function readCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/; */)) {
    const [k, ...rest] = part.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

// Minimal HS256 verify (same as intake.ts)
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
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", key, base64urlToBytes(s), enc.encode(data));
  if (!ok) throw new Error("bad_sig");
  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(p)));
  if ((payload as any)?.exp && Date.now() / 1000 > (payload as any).exp) throw new Error("expired");
  return payload;
}

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    // AuthN
    const cookieHeader = request.headers.get("cookie") || "";
    const token = readCookie(cookieHeader, "__Host-rp_session");
    if (!token) return json({ ok: false, error: "no_cookie" }, 401);
    const payload = await verifyJwt(token, String(env.JWT_SECRET));
    const actor_user_id = String((payload as any).sub || "");
    if (!actor_user_id) return json({ ok: false, error: "bad_token" }, 401);

    // Tenant
    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) return json({ ok: false, error: "missing_tenant" }, 400);

    const sql = neon(String(env.DATABASE_URL));

    // AuthZ — same rule as intake
    const actor = await sql<{ role: Role; active: boolean; can_inventory_intake: boolean | null }[]>`
      SELECT m.role, m.active, COALESCE(p.can_inventory_intake, false) AS can_inventory_intake
      FROM app.memberships m
      LEFT JOIN app.permissions p ON p.user_id = m.user_id
      WHERE m.tenant_id = ${tenant_id} AND m.user_id = ${actor_user_id}
      LIMIT 1
    `;
     console.log("[pos.search] auth", actor[0] || null); 
    if (actor.length === 0 || actor[0].active === false) return json({ ok: false, error: "forbidden" }, 403);
    const allow = ["owner", "admin", "manager"].includes(actor[0].role) || !!actor[0].can_inventory_intake;
    if (!allow) return json({ ok: false, error: "forbidden" }, 403);

    // Params
    const url = new URL(request.url);
    const limitRaw = Number(url.searchParams.get("limit") || 50);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 50;
    const startedAt = Date.now();
    console.log("[pos.search] start", { url: request.url });
    const q = (url.searchParams.get("q") || "").trim();
    console.log("[pos.search] params", { tenant_id, actor_user_id, q });
    if (!q) {
      console.log("[pos.search] empty q — returning []");
      return json({ ok: true, items: [] }, 200);
    }
    
    console.log("[pos.search] running SQL…");
    const rows = await sql/*sql*/`
      WITH imgs AS (
        SELECT
          im.item_id,
          im.cdn_url AS image_url,
          ROW_NUMBER() OVER (
            PARTITION BY im.item_id
            ORDER BY im.is_primary DESC, im.sort_order ASC, im.created_at ASC
          ) AS rn
        FROM app.item_images im
        WHERE im.tenant_id = ${tenant_id}
      ),
      primary_img AS (
        SELECT item_id, image_url FROM imgs WHERE rn = 1
      )
      SELECT
        i.item_id,
        i.sku,
        i.product_short_title,
        i.price::float8 AS price,
        i.qty::int AS qty,
        i.instore_loc,
        i.case_bin_shelf,
        p.image_url
      FROM app.inventory i
      INNER JOIN app.item_listing_profile lp
        ON lp.item_id = i.item_id
       AND lp.tenant_id = ${tenant_id}
      LEFT JOIN primary_img p
        ON p.item_id = i.item_id
      WHERE i.item_status = 'active'
        AND (
          i.sku ILIKE ${"%" + q + "%"}
          OR i.category_nm ILIKE ${"%" + q + "%"}
          OR i.product_short_title ILIKE ${"%" + q + "%"}
        )
      ORDER BY
        (CASE WHEN i.sku ILIKE ${q + "%"} THEN 0 ELSE 1 END),
        i.updated_at DESC NULLS LAST
      LIMIT 50;
    `;

    console.log("[pos.search] rows", { count: rows.length, sample: rows[0] || null });
    const elapsed = Date.now() - startedAt;
    console.log("[pos.search] done", { elapsed_ms: elapsed });

    return json({ ok: true, items: rows }, 200);
  } catch (e: any) {
    const elapsed = Date.now() - startedAt;
    console.error("[pos.search] error", { elapsed_ms: elapsed, message: e?.message || String(e), stack: e?.stack });
    return json({ ok: false, error: "server_error", message: String(e?.message || e) }, 500);
  }
}
