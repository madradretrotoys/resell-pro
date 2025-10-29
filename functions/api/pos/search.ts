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

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/; */)) {
    const [k, ...rest] = part.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

// Minimal JWT verify (matches recent.ts style)
function base64UrlDecode(input: string): ArrayBuffer {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}
async function verifyJwt(token: string, secret: string): Promise<any> {
  const [headerB64, payloadB64, sigB64] = token.split(".");
  if (!headerB64 || !payloadB64 || !sigB64) throw new Error("bad token");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlDecode(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!ok) throw new Error("bad signature");
  const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
  return JSON.parse(payloadJson);
}

export default async function handler(request: Request, env: any) {
  const startedAt = Date.now();
  try {
    console.log("[pos.search] start", { url: request.url });

    // Session (cookie) → JWT
    const cookie = request.headers.get("cookie");
    const token = readCookie(cookie, "session");
    if (!token) {
      console.warn("[pos.search] no_cookie");
      return json({ ok: false, error: "no_cookie" }, 401);
    }

    const payload = await verifyJwt(token, String(env.JWT_SECRET));
    const actor_user_id = String((payload as any).sub || "");
    if (!actor_user_id) {
      console.warn("[pos.search] bad_token");
      return json({ ok: false, error: "bad_token" }, 401);
    }

    // Tenant header
    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) {
      console.warn("[pos.search] missing_tenant");
      return json({ ok: false, error: "missing_tenant" }, 400);
    }

    // Parse query term
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim();
    console.log("[pos.search] params", { tenant_id, actor_user_id, q });
    if (!q) {
      console.log("[pos.search] empty q — returning []");
      return json({ ok: true, items: [] }, 200);
    }

    const sql = neon(String(env.DATABASE_URL));

    // AuthZ — allow POS for owner/admin/manager or explicit can_pos
    const actor = await sql<{ role: Role; active: boolean; can_pos: boolean | null }[]>`
      SELECT m.role, m.active, COALESCE(p.can_pos, false) AS can_pos
      FROM app.memberships m
      LEFT JOIN app.policies p ON p.tenant_id = m.tenant_id AND p.user_id = m.user_id
      WHERE m.tenant_id = ${tenant_id} AND m.user_id = ${actor_user_id}
      LIMIT 1
    `;
    console.log("[pos.search] auth", actor[0] || null);
    if (actor.length === 0 || actor[0].active === false) {
      console.warn("[pos.search] forbidden (no membership or inactive)");
      return json({ ok: false, error: "forbidden" }, 403);
    }
    const allow = ["owner", "admin", "manager"].includes(actor[0].role) || !!actor[0].can_pos;
    if (!allow) {
      console.warn("[pos.search] forbidden (role/can_pos)");
      return json({ ok: false, error: "forbidden" }, 403);
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
