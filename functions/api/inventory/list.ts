// functions/api/inventory/list.ts
// Dynamic sort allowlist + default sort based on live schema.

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

const mapType = (t: string) => {
  const s = t.toLowerCase();
  if (s.includes("timestamp") || s.includes("date")) return "timestamp";
  return "other";
};

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  const t0 = Date.now();
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

    // AuthZ
    const actor = await sql<{ role: Role; active: boolean; can_inventory: boolean | null }[]>`
      SELECT m.role, m.active, COALESCE(p.can_inventory, false) AS can_inventory
      FROM app.memberships m
      LEFT JOIN app.permissions p ON p.user_id = m.user_id
      WHERE m.tenant_id = ${tenant_id} AND m.user_id = ${actor_user_id}
      LIMIT 1
    `;
    if (actor.length === 0 || actor[0].active === false) return json({ ok: false, error: "forbidden" }, 403);
    const allow = ["owner","admin","manager"].includes(actor[0].role) || !!actor[0].can_inventory;
    if (!allow) return json({ ok: false, error: "forbidden" }, 403);

    // Live columns -> allowed sort + default sort
    const cols = await sql<{ column_name: string; data_type: string; ordinal_position: number }[]>`
      SELECT column_name, data_type, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'inventory'
      ORDER BY ordinal_position
    `;
    const allowed = new Set(cols.map(c => c.column_name));
    const ts = cols.find(c => mapType(c.data_type) === "timestamp")?.column_name || null;
    const firstCol = cols[0]?.column_name || "id";
    const defaultSortCol = ts || firstCol;
    const defaultSortDir = ts ? "desc" : "asc";

    // Params
    const url = new URL(request.url);
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50)));
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
    let sortParam = String(url.searchParams.get("sort") || `${defaultSortCol}:${defaultSortDir}`);
    let [sortCol, sortDir] = sortParam.split(":");
    sortCol = (sortCol || defaultSortCol).toLowerCase();
    sortDir = (sortDir || defaultSortDir).toLowerCase();
    if (!allowed.has(sortCol)) sortCol = defaultSortCol;
    if (sortDir !== "asc" && sortDir !== "desc") sortDir = defaultSortDir;

    // Data + Count
    const qList = await sql<any[]>(`SELECT * FROM app.inventory ORDER BY ${sortCol} ${sortDir === "desc" ? "DESC" : "ASC"} NULLS LAST LIMIT ${limit} OFFSET ${offset}`);
    const qCount = await sql<{ count: string }[]>`SELECT COUNT(*)::bigint AS count FROM app.inventory`;
    const total = Number(qCount[0]?.count || 0);

    return json({
      ok: true,
      items: qList,
      limit,
      offset,
      sort: { column: sortCol, dir: sortDir },
      total,
      approximate: false,
      ms: Date.now() - t0,
    });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
