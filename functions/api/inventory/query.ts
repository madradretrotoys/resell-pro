// functions/api/inventory/query.ts
// POST /api/inventory/query
// Body:
// {
//   "q": "shirt",
//   "filters": [ { "column":"price", "op":"gte", "value": 10 }, { "column":"status", "op":"eq", "value":"AVAILABLE" } ],
//   "sort": { "column":"updated_at", "dir":"desc" },
//   "limit": 50,
//   "offset": 0
// }
// - q searches (ILIKE) over sku,title,brand_name,category_name,status,vendoo_item_number
// - Filters support string eq/ilike and numeric gt/gte/lt/lte/eq; also "isnull"/"notnull"
// - AuthZ mirrors can_inventory

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

const SEARCH_SCOPE = ["sku", "title", "brand_name", "category_name", "status", "vendoo_item_number"];
const TEXT_COLS = new Set([
  "sku","title","category_name","brand_name","condition_name","store_name","case_bin_shelf","online_location","status",
  "buy_ticket_item_id","vendoo_category_display","vendoo_item_number","vendoo_item_url","vendoo_listing_status"
]);
const NUM_COLS = new Set(["price","qty","cost_cogs","weight_oz","length_in","width_in","height_in"]);
const DATE_COLS = new Set(["updated_at"]);
const ALLOWED_SORT = new Set<string>([...SEARCH_SCOPE, ...TEXT_COLS, ...NUM_COLS, ...DATE_COLS]);

type Filter = {
  column: string;
  op: "eq"|"ilike"|"like"|"gt"|"gte"|"lt"|"lte"|"isnull"|"notnull";
  value?: any;
};

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
    const role = actor[0].role;
    const allow =
      role === "owner" || role === "admin" || role === "manager" || !!actor[0].can_inventory;
    if (!allow) return json({ ok: false, error: "forbidden" }, 403);

    const body = await request.json();
    const q = (body?.q ?? "").toString().trim();
    const filters: Filter[] = Array.isArray(body?.filters) ? body.filters : [];
    let limit = Math.max(1, Math.min(100, Number(body?.limit || 50)));
    let offset = Math.max(0, Number(body?.offset || 0));
    let sortCol = (body?.sort?.column || "updated_at").toString().toLowerCase();
    let sortDir: Dir = (String(body?.sort?.dir || "desc").toLowerCase() === "asc") ? "asc" : "desc";
    if (!ALLOWED_SORT.has(sortCol)) sortCol = "updated_at";

    // Build WHERE clause + params
    const where: string[] = [];
    const params: any[] = [];
    const add = (frag: string, ...vals: any[]) => { where.push(frag); params.push(...vals); };

    if (q) {
      const ors = SEARCH_SCOPE.map((c) => `${c} ILIKE $${params.length + 1}`).join(" OR ");
      add(`(${ors})`, ...SEARCH_SCOPE.map(() => `%${q}%`));
    }

    for (const f of filters) {
      const col = (f?.column || "").toString().toLowerCase();
      if (!ALLOWED_SORT.has(col)) continue;
      const op = (f?.op || "eq").toString().toLowerCase();
      if (op === "isnull" || op === "notnull") {
        where.push(`${col} IS ${op === "isnull" ? "" : "NOT "}NULL`);
        continue;
        }
      const val = f?.value;
      if (NUM_COLS.has(col)) {
        if (op === "gt" || op === "gte" || op === "lt" || op === "lte" || op === "eq") {
          add(`${col} ${op === "eq" ? "=" : op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : "<="} $${params.length + 1}`, Number(val));
        }
      } else {
        // text-ish
        if (op === "eq") add(`${col} = $${params.length + 1}`, String(val));
        else if (op === "like") add(`${col} LIKE $${params.length + 1}`, String(val));
        else /* ilike default */ add(`${col} ILIKE $${params.length + 1}`, `%${String(val)}%`);
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const orderSql = `ORDER BY ${sortCol} ${sortDir === "desc" ? "DESC" : "ASC"} NULLS LAST, sku ASC`;
    const limitSql = `LIMIT ${limit} OFFSET ${offset}`;

    // Data + Count (Phase 1 exact; we will auto-approx in a follow-up if needed)
    const rows = await sql(`SELECT * FROM app.inventory ${whereSql} ${orderSql} ${limitSql}`, params);
    const cnt  = await sql(`SELECT COUNT(*)::bigint AS count FROM app.inventory ${whereSql}`, params);
 
    const total = Number((cnt[0] && (cnt[0].count as any)) || 0);

    return json({
      ok: true,
      items: rows,
      limit,
      offset,
      sort: { column: sortCol, dir: sortDir },
      total,
      approximate: false, // Phase 1 exact-then-auto-approx approved; hook reserved for heavy queries.
      ms: Date.now() - t0,
      echo: { q, filtersCount: filters.length },
    });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
