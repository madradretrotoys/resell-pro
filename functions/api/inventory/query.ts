// functions/api/inventory/query.ts
// Dynamic search/sort/filter based on live schema (no hardcoded column names).

import { neon } from "@neondatabase/serverless";

type Role = "owner" | "admin" | "manager" | "clerk";
type Dir = "asc" | "desc";

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

const typeOf = (pg: string): "text"|"num"|"date"|"json"|"other" => {
  const t = pg.toLowerCase();
  if (t.includes("char") || t.includes("text")) return "text";
  if (t.includes("json")) return "json";
  if (t.includes("int") || t.includes("numeric") || t.includes("real") || t.includes("double")) return "num";
  if (t.includes("timestamp") || t.includes("date")) return "date";
  return "other";
};

type Filter = { column: string; op: "eq"|"ilike"|"like"|"gt"|"gte"|"lt"|"lte"|"isnull"|"notnull"; value?: any; };

export const onRequestPost: PagesFunction = async ({ request, env }) => {
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

    // Live schema map
    const cols = await sql<{ column_name: string; data_type: string; ordinal_position: number }[]>`
      SELECT column_name, data_type, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'inventory'
      ORDER BY ordinal_position
    `;
    const byName = new Map(cols.map(c => [c.column_name, c]));
    const allowed = new Set(cols.map(c => c.column_name));
    const textCols = cols.filter(c => typeOf(c.data_type) === "text").map(c => c.column_name);
    const numCols  = cols.filter(c => typeOf(c.data_type) === "num").map(c => c.column_name);
    const dateCols = cols.filter(c => typeOf(c.data_type) === "date").map(c => c.column_name);
    const tsCol = dateCols[0] || null;
    const firstCol = cols[0]?.column_name || "id";

    // Search scope: prefer common names if present, else first 6 text columns
    const preferred = ["sku","title","brand_name","category_name","status","vendoo_item_number"];
    const searchScope = preferred.filter(p => allowed.has(p));
    const SEARCH_SCOPE = (searchScope.length ? searchScope : textCols.slice(0, 6));

    // Body & defaults
    const body = await request.json();
    const q = (body?.q ?? "").toString().trim();
    const filters: Filter[] = Array.isArray(body?.filters) ? body.filters : [];
    const limit = Math.max(1, Math.min(100, Number(body?.limit || 50)));
    const offset = Math.max(0, Number(body?.offset || 0));
    let sortCol = (body?.sort?.column || (tsCol || firstCol)).toString();
    let sortDir: Dir = (String(body?.sort?.dir || (tsCol ? "desc" : "asc")).toLowerCase() === "asc") ? "asc" : "desc";
    if (!allowed.has(sortCol)) sortCol = tsCol || firstCol;

    // WHERE builder
    const where: string[] = [];
    const params: any[] = [];
    const add = (frag: string, ...vals: any[]) => { where.push(frag); params.push(...vals); };

    if (q && SEARCH_SCOPE.length) {
      const ors = SEARCH_SCOPE.map((c) => `${c} ILIKE $${params.length + 1}`).join(" OR ");
      add(`(${ors})`, ...SEARCH_SCOPE.map(() => `%${q}%`));
    }

    for (const f of filters) {
      const col = (f?.column || "").toString();
      if (!allowed.has(col)) continue;
      const colType = typeOf(byName.get(col)!.data_type);
      const op = (f?.op || "eq").toString().toLowerCase();
      if (op === "isnull" || op === "notnull") {
        where.push(`${col} IS ${op === "isnull" ? "" : "NOT "}NULL`);
        continue;
      }
      const val = f?.value;
      if (colType === "num") {
        if (op === "gt" || op === "gte" || op === "lt" || op === "lte" || op === "eq") {
          add(`${col} ${op === "eq" ? "=" : op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : "<="} $${params.length + 1}`, Number(val));
        }
      } else if (colType === "date") {
        if (op === "gt" || op === "gte" || op === "lt" || op === "lte" || op === "eq") {
          add(`${col} ${op === "eq" ? "=" : op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : "<="} $${params.length + 1}`, String(val));
        }
      } else {
        if (op === "eq") add(`${col} = $${params.length + 1}`, String(val));
        else if (op === "like") add(`${col} LIKE $${params.length + 1}`, String(val));
        else add(`${col} ILIKE $${params.length + 1}`, `%${String(val)}%`);
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // Qualify ORDER BY with inventory alias now that we join images
    const orderSql = `ORDER BY i.${sortCol} ${sortDir === "desc" ? "DESC" : "ASC"} NULLS LAST`;
    const limitSql = `LIMIT ${limit} OFFSET ${offset}`;
    
    // Primary image per item (same pattern as POS search)
    const baseSql = `
      WITH imgs AS (
        SELECT
          item_id,
          image_url,
          ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY COALESCE(sort_order, 9999) ASC, created_at ASC) AS rn
        FROM app.item_images
      ),
      primary_img AS (
        SELECT item_id, image_url
        FROM imgs
        WHERE rn = 1
      )
      SELECT i.*, p.image_url
      FROM app.inventory i
      LEFT JOIN primary_img p ON p.item_id = i.item_id
      ${whereSql}
      ${orderSql}
      ${limitSql}
    `;
    
    // Count should match the same WHERE (inventory only)
    const countSql = `
      SELECT COUNT(*)::bigint AS count
      FROM app.inventory i
      ${whereSql}
    `;
    
    const rows = await sql(baseSql, params);
    const cnt  = await sql(countSql, params);
    const total = Number((cnt[0] && (cnt[0].count as any)) || 0);

    return json({
      ok: true,
      items: rows,
      limit,
      offset,
      sort: { column: sortCol, dir: sortDir },
      total,
      approximate: false,
      ms: Date.now() - t0,
      echo: { q, filtersCount: filters.length, searchScope: SEARCH_SCOPE },
    });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
