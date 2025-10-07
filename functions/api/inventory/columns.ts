// functions/api/inventory/columns.ts
// GET /api/inventory/columns
// Dynamic defaults:
//   - visible_default: FIRST 9 columns by ordinal (no hardcoding)
//   - default_sort: first timestamp/date column (desc); else first column (asc)

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

function mapType(pgType: string): ColType {
  const t = pgType.toLowerCase();
  if (t.includes("timestamp") || t.includes("date")) return "timestamp";
  if (t.includes("json")) return "json";
  if (t.includes("int") || t.includes("numeric") || t.includes("double") || t.includes("real")) return "number";
  return "string";
}

const labelize = (s: string) => s.replace(/_/g, " ").replace(/\b([a-z])/g, (_, c) => c.toUpperCase());

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

    // AuthZ (mirror can_inventory)
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

    // Introspect columns
    const cols = await sql<{ column_name: string; data_type: string; is_nullable: "YES" | "NO"; ordinal_position: number }[]>`
      SELECT column_name, data_type, is_nullable, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'inventory'
      ORDER BY ordinal_position
    `;

    // Visible defaults: first 9 columns by ordinal
    const visibleSet = new Set(cols.slice(0, 9).map(c => c.column_name));

    // Pick default sort: first timestamp/date column else first column
    const tsCol = cols.find(c => mapType(c.data_type) === "timestamp")?.column_name || null;
    const firstCol = cols[0]?.column_name || "id";
    const default_sort = tsCol
      ? { column: tsCol, dir: "desc" as const }
      : { column: firstCol, dir: "asc" as const };

    // Build columns payload
    const currencyCols = new Set(["price", "cost_cogs"]); // hint only; safe if absent
    const columns = cols.map(c => ({
      name: c.column_name,
      label: labelize(c.column_name),
      type: mapType(c.data_type),
      nullable: c.is_nullable === "YES",
      ordinal: c.ordinal_position,
      currency: currencyCols.has(c.column_name),
      visible_default: visibleSet.has(c.column_name),
    }));

    // Search scope: prefer common names if present, else first 6 string columns
    const preferred = ["sku","title","brand_name","category_name","status","vendoo_item_number"];
    const existingPreferred = preferred.filter(p => cols.some(c => c.column_name === p));
    const fallbackStrings = cols.filter(c => mapType(c.data_type) === "string").slice(0, 6).map(c => c.column_name);
    const search_scope = existingPreferred.length ? existingPreferred : fallbackStrings;

    // Primary key hint (best effort)
    const pk = cols.find(c => c.column_name === "sku")?.column_name || firstCol;

    return json({ ok: true, pk, columns, search_scope, default_sort });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
