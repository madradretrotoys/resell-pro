import { neon } from "@neondatabase/serverless";

type Role = "owner" | "admin" | "manager" | "clerk";
type Env = { DATABASE_URL?: string; NEON_DATABASE_URL?: string; JWT_SECRET?: string };

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "vary": "Cookie" },
  });

function readCookie(cookieHeader: string, name: string) {
  const m = cookieHeader.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : "";
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
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", key, base64urlToBytes(s), enc.encode(data));
  if (!ok) throw new Error("bad_sig");
  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(p)));
  if ((payload as any)?.exp && Date.now() / 1000 > (payload as any).exp) throw new Error("expired");
  return payload;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  try {
    // AuthN: same style as your Intake APIs
    const cookieHeader = request.headers.get("cookie") || "";
    const token = readCookie(cookieHeader, "__Host-rp_session");
    if (!token) return json({ ok: false, error: "no_cookie" }, 401);
    const payload = await verifyJwt(token, String(env.JWT_SECRET));
    const actor_user_id = String((payload as any).sub || "");
    if (!actor_user_id) return json({ ok: false, error: "bad_token" }, 401);

    // Tenant
    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) return json({ ok: false, error: "missing_tenant" }, 400);

    // DB
    const url = env.DATABASE_URL || env.NEON_DATABASE_URL;
    if (!url) return json({ ok: false, error: "missing_db_url" }, 500);
    const sql = neon(url);

    // AuthZ: mirror Intake auth (owner/admin/manager or can_inventory_intake)
    const actor = await sql<{ role: Role; active: boolean; can_inventory_intake: boolean | null }[]>`
      SELECT m.role, m.active, COALESCE(p.can_inventory_intake, false) AS can_inventory_intake
      FROM app.memberships m
      LEFT JOIN app.permissions p ON p.user_id = m.user_id
      WHERE m.tenant_id = ${tenant_id} AND m.user_id = ${actor_user_id}
      LIMIT 1
    `;
    if (actor.length === 0 || actor[0].active === false) return json({ ok: false, error: "forbidden" }, 403);
    const allow = ["owner","admin","manager"].includes(actor[0].role) || !!actor[0].can_inventory_intake;
    if (!allow) return json({ ok: false, error: "forbidden" }, 403);

    // Tenant’s eBay connection
    const rows = await sql<{ access_token: string | null; environment: string | null }[]>`
      SELECT mc.access_token, mc.environment
      FROM app.marketplace_connections mc
      JOIN app.marketplaces_available ma ON ma.id = mc.marketplace_id
      WHERE mc.tenant_id = ${tenant_id} AND ma.slug = 'ebay'
      LIMIT 1
    `;
    if (rows.length === 0) return json({ ok: false, error: "not_connected" }, 400);
    const { access_token, environment } = rows[0] || {};
    if (!access_token) return json({ ok: false, error: "no_access_token" }, 400);

    const base = String(environment || "").toLowerCase() === "production"
      ? "https://api.ebay.com"
      : "https://api.sandbox.ebay.com";

    async function getList(path: string, key: string): Promise<Array<{ id: string; name: string }>> {
      const res = await fetch(base + path, {
        method: "GET",
        headers: { "Authorization": `Bearer ${access_token}`, "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`ebay_${key}_failed ${res.status} ${txt}`.slice(0, 512));
      }
      const data = await res.json();
      const arr = Array.isArray(data?.[key]) ? data[key] : [];
      return arr
        .map((p: any) => {
          // e.g. fulfillmentPolicies[].fulfillmentPolicyId / paymentPolicies[].paymentPolicyId / returnPolicies[].returnPolicyId
          const idKey = Object.keys(p).find(k => /PolicyId$/i.test(k));
          return { id: String(idKey ? p[idKey] : ""), name: String(p?.name ?? "") };
        })
        .filter(r => r.id && r.name);
    }

    const [shipping, payment, returns] = await Promise.all([
      getList("/sell/account/v1/fulfillment_policy", "fulfillmentPolicies"),
      getList("/sell/account/v1/payment_policy", "paymentPolicies"),
      getList("/sell/account/v1/return_policy", "returnPolicies"),
    ]);

    return json({ ok: true, shipping, payment, returns }, 200);
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: String(e?.message || e) }, 500);
  }
};
