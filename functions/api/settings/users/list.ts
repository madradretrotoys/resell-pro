// functions/api/settings/users/list.ts
import { neon } from "@neondatabase/serverless";

// Minimal JSON responder (pattern: admin/schema.ts)
const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// Read a cookie value from "cookie" header (pattern: auth/session.ts)
function readCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/; */)) {
    const [k, ...rest] = part.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

// Minimal HS256 JWT verify (pattern adapted from auth/session.ts)
async function verifyJwt(token: string, secret: string): Promise<Record<string, any>> {
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
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify("HMAC", key, base64urlToBytes(s), enc.encode(data));
  if (!ok) throw new Error("bad_sig");

  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(p)));
  if ((payload as any)?.exp && Date.now() / 1000 > (payload as any).exp) throw new Error("expired");
  return payload as Record<string, any>;
}

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    // --- Auth: session cookie -> user ---
    const cookieHeader = request.headers.get("cookie") || "";
    const token = readCookie(cookieHeader, "__Host-rp_session");
    if (!token) return json({ ok: false, error: "no_cookie" }, 401);

    const payload = await verifyJwt(token, String(env.JWT_SECRET));
    const actor_user_id = String((payload as any).sub || "");
    if (!actor_user_id) return json({ ok: false, error: "bad_token" }, 401);

    // --- Tenant from header (client sends via assets/js/api.js) ---
    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) return json({ ok: false, error: "missing_tenant" }, 400);

    // --- DB client ---
    const sql = neon(String(env.DATABASE_URL));

    // --- Resolve actor's membership & permissions in this tenant ---
    const actor = await sql<
      { role: "owner" | "admin" | "manager" | "clerk"; active: boolean; can_settings: boolean | null }[]
    >`
      SELECT m.role, m.active, COALESCE(p.can_settings, false) AS can_settings
      FROM app.memberships m
      LEFT JOIN app.permissions p ON p.user_id = m.user_id
      WHERE m.tenant_id = ${tenant_id} AND m.user_id = ${actor_user_id}
      LIMIT 1
    `;

    if (actor.length === 0 || actor[0].active === false) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    // Server-side access policy:
    // Owner/Admin/Manager may access Settings (list users). Clerk: denied.
    const role = actor[0].role;
    const allowSettings =
      role === "owner" || role === "admin" || role === "manager" || !!actor[0].can_settings;
    if (!allowSettings) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    // --- List users in tenant with memberships + permissions ---
    const rows = await sql/*sql*/`
      SELECT
        u.user_id, u.email, u.name, u.login_id,
        m.role, m.active,
        p.can_pos, p.can_cash_drawer, p.can_cash_payouts, p.can_item_research,
        p.can_inventory, p.can_inventory_intake, p.can_drop_off_form,
        p.can_estimates_buy_tickets, p.can_timekeeping, p.can_settings,
        p.notify_cash_drawer, p.notify_daily_sales_summary, p.discount_max
      FROM app.memberships m
      JOIN app.users u ON u.user_id = m.user_id
      LEFT JOIN app.permissions p ON p.user_id = u.user_id
      WHERE m.tenant_id = ${tenant_id}
      ORDER BY lower(u.name)
    `;

    return json({ ok: true, users: rows });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
