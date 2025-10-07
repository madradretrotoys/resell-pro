// functions/api/inventory/columns.ts
// GET /api/inventory/columns
// - AuthN via __Host-rp_session
// - AuthZ: mirror can_inventory (owner/admin/manager OR permissions.can_inventory)
// - Returns live column list from information_schema so UI can be dynamic.

import { neon } from "@neondatabase/serverless";

type Role = "owner" | "admin" | "manager" | "clerk";
type ColType = "string" | "number" | "timestamp" | "json";

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

// Minimal HS256 verify (pattern: functions/api/auth/session.ts)
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
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", key, base64urlToBytes(s), enc.encode(data));
  if (!ok) throw new Error("bad_sig");
  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(p)));
  if ((payload as any)?.exp && Date.now() / 1000 > (payload as any).exp) throw new Error("expired");
  return payload;
}

// Basic type mapper
function mapType(pgType: string): ColType {
  const t = pgType.toLowerCase();
  if (t.includes("timestamp") || t.includes("date")) return "timestamp";
  if (t.includes("json")) return "json";
  if (t.includes("int") || t.includes("numeric") || t.includes("double") || t.includes("real")) return "number";
  return "string";
}

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    // --- AuthN ---
    const cookieHeader = request.headers.get("cookie") || "";
    const token = readCookie(cookieHeader, "__Host-rp_session");
    if (!token) return json({ ok: false, error: "no_cookie" }, 401);
    const payload = await verifyJwt(token, String(env.JWT_SECRET));
    const actor_user_id = String((payload as any).sub || "");
    if (!actor_user_id) return json({ ok: false, error: "bad_token" }, 401);

    // --- Tenant header (sent by assets/js/api.js via ensureSession) ---
    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) return json({ ok: false, error: "missing_tenant" }, 400);

    const sql = neon(String(env.DATABASE_URL));

    // --- AuthZ: mirror can_inventory ---
    const actor = await sql<{ role: Role; active: boolean; can_inventory: boolean | null }[]>`
      SELECT m.role, m.active, COALESCE(p.can_inventory, false) AS can_inventory
      FROM app.memberships m
      LEFT JOIN app.permissions p ON p.user_id = m.user_id
      WHERE m.tenant_id = ${tenant_id} AND m.user_id = ${actor_user_id}
      LIMIT 1
    `;
    if (actor.length === 0 || actor[0].active === false) return json({ ok: false, error: "forbidden" }, 403);
    const role = actor[0].role;
    const allow =
      role === "owner" || role === "admin" || role === "manager" || !!actor[0].can_inventory;
    if (!allow) return json({ ok: false, error: "forbidden" }, 403);

    // --- Live column introspection from information_schema ---
    const cols = await sql<{ column_name: string; data_type: string; is_nullable: "YES" | "NO"; ordinal_position: number }[]>`
      SELECT column_name, data_type, is_nullable, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'inventory'
      ORDER BY ordinal_position
    `;

    // Sensible default visible set (customizable per user in client)
    const defaultVisible = new Set([
      "sku",
      "title",
      "price",
      "qty",
      "status",
      "updated_at",
      "category_name",
      "brand_name",
      "vendoo_item_number",
    ]);

    const currencyCols = new Set(["price", "cost_cogs"]);
    const label = (s: string) =>
      s.replace(/_/g, " ").replace(/\b([a-z])/g, (_, c) => c.toUpperCase());

    const columns = cols.map((c) => ({
      name: c.column_name,
      label: label(c.column_name),
      type: mapType(c.data_type),
      nullable: c.is_nullable === "YES",
      ordinal: c.ordinal_position,
      currency: currencyCols.has(c.column_name),
      visible_default: defaultVisible.has(c.column_name),
    }));

    // Server-published defaults the UI can consume
    const search_scope = ["sku", "title", "brand_name", "category_name", "status", "vendoo_item_number"];
    const default_sort = { column: "updated_at", dir: "desc" as const };

    return json({
      ok: true,
      pk: "sku",
      columns,
      search_scope,
      default_sort,
    });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
