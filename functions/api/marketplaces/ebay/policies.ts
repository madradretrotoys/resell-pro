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

function b64(u8: Uint8Array) { return btoa(String.fromCharCode(...u8)); }
function b64d(s: string) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
async function decryptJson(base64Key: string, blob: string): Promise<any> {
  if (!blob) return null;
  const [ivB64, ctB64] = blob.split(".");
  const iv = b64d(ivB64);
  const ct = b64d(ctB64);
  if (!base64Key) return JSON.parse(new TextDecoder().decode(ct));
  const key = await crypto.subtle.importKey("raw", b64d(base64Key), { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
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

    // DB
    const url = env.DATABASE_URL || env.NEON_DATABASE_URL;
    if (!url) return json({ ok: false, error: "missing_db_url" }, 500);
    const sql = neon(url);

    // AuthZ
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

    // Tenant’s eBay connection (newest connected row)
    const rows = await sql<{ access_token: string | null; environment: string | null; secrets_blob: string | null }[]>`
      SELECT mc.access_token, mc.environment, mc.secrets_blob
      FROM app.marketplace_connections mc
      JOIN app.marketplaces_available ma ON ma.id = mc.marketplace_id
      WHERE mc.tenant_id = ${tenant_id}
        AND ma.slug = 'ebay'
        AND mc.status = 'connected'
      ORDER BY mc.updated_at DESC
      LIMIT 1
    `;
    if (rows.length === 0) return json({ ok: false, error: "not_connected" }, 400);
    
    const { access_token: encAccess, environment, secrets_blob } = rows[0] || {};
    if (!encAccess) return json({ ok: false, error: "no_access_token" }, 400);
    
    const encKey = env.RP_ENCRYPTION_KEY || "";
    const accessObj = await decryptJson(encKey, encAccess);
    const access_token = String(accessObj?.v || "");
    if (!access_token) return json({ ok: false, error: "bad_access_token" }, 400);
    
    // NEW: derive environment from DB column OR secrets_blob
    let envStr = String(environment || "").trim().toLowerCase();
    if (!envStr && secrets_blob) {
      try {
        const sec = await decryptJson(encKey, secrets_blob);
        envStr = String(sec?.environment || "").trim().toLowerCase();
      } catch {}
    }
    
    const primaryBase = (envStr === "production" || envStr === "prod" || envStr === "live")
      ? "https://api.ebay.com"
      : "https://api.sandbox.ebay.com";
    const altBase = primaryBase.includes("sandbox")
      ? "https://api.ebay.com"
      : "https://api.sandbox.ebay.com";

    const altBase = primaryBase.includes("sandbox")
      ? "https://api.ebay.com"
      : "https://api.sandbox.ebay.com";

    async function getList(baseUrl: string, path: string, key: string): Promise<Array<{ id: string; name: string }>> {
      const res = await fetch(baseUrl + path, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${access_token}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`ebay_${key}_failed ${res.status} ${txt}`.slice(0, 512));
      }
      const data = await res.json();
      const arr = Array.isArray((data as any)?.[key]) ? (data as any)[key] : [];
      return arr
        .map((p: any) => {
          const idKey = Object.keys(p).find((k) => /PolicyId$/i.test(k));
          return { id: String(idKey ? (p as any)[idKey] : ""), name: String(p?.name ?? "") };
        })
        .filter((r) => r.id && r.name);
    }

    // Try primary; if 401, retry once on alt
    let shipping: Array<{ id: string; name: string }>;
    let payment: Array<{ id: string; name: string }>;
    let returns: Array<{ id: string; name: string }>;

    try {
      [shipping, payment, returns] = await Promise.all([
        getList(primaryBase, "/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US", "fulfillmentPolicies"),
        getList(primaryBase, "/sell/account/v1/payment_policy?marketplace_id=EBAY_US", "paymentPolicies"),
        getList(primaryBase, "/sell/account/v1/return_policy?marketplace_id=EBAY_US", "returnPolicies"),
      ]);
    } catch (e: any) {
      const msg1 = String(e?.message || e || "");
      if (!msg1.includes(" 401")) throw e;
      [shipping, payment, returns] = await Promise.all([
        getList(altBase, "/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US", "fulfillmentPolicies"),
        getList(altBase, "/sell/account/v1/payment_policy?marketplace_id=EBAY_US", "paymentPolicies"),
        getList(altBase, "/sell/account/v1/return_policy?marketplace_id=EBAY_US", "returnPolicies"),
      ]);
    }

    return json({ ok: true, shipping, payment, returns }, 200);
  } catch (err: any) {
    const msg = String(err?.message || err || "");
    if (msg.includes(" 401")) return json({ ok: false, error: "reauth_required", message: msg }, 401);
    return json({ ok: false, error: "server_error", message: msg }, 500);
  }
};
