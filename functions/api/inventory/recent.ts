// functions/api/inventory/recent.ts
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
    if (actor.length === 0 || actor[0].active === false) return json({ ok: false, error: "forbidden" }, 403);
    const allow = ["owner", "admin", "manager"].includes(actor[0].role) || !!actor[0].can_inventory_intake;
    if (!allow) return json({ ok: false, error: "forbidden" }, 403);

    // Params
    const url = new URL(request.url);
    const limitRaw = Number(url.searchParams.get("limit") || 50);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 50;

    // Query: latest Active items + primary image (if any)
    const rows = await sql<{
      item_id: string;
      saved_at: string;
      sku: string | null;
      product_short_title: string | null;
      price: number | null;
      qty: number | null;
      category_nm: string | null;
      image_url: string | null;
    }[]>`
      WITH imgs AS (
        SELECT i.item_id,
               im.cdn_url,
               ROW_NUMBER() OVER (PARTITION BY im.item_id ORDER BY im.is_primary DESC, im.sort_order ASC, im.created_at ASC) AS rn
        FROM app.inventory i
        LEFT JOIN app.item_images im ON im.item_id = i.item_id
        WHERE i.tenant_id = ${tenant_id}
      )
      SELECT
        i.item_id,
        i.updated_at AS saved_at,
        i.sku,
        i.product_short_title,
        i.price,
        i.qty,
        i.category_nm,
        (SELECT cdn_url FROM imgs WHERE imgs.item_id = i.item_id AND rn = 1) AS image_url
      FROM app.inventory i
      WHERE i.tenant_id = ${tenant_id}
        AND i.item_status = 'active'
      ORDER BY i.updated_at DESC
      LIMIT ${limit};
    `;

    return json({ ok: true, rows }, 200);
  } catch (err: any) {
    console.error("[inventory/recent] error", err);
    return json({ ok: false, error: "server_error" }, 500);
  }
};
