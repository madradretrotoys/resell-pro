// /api/pos/sales
// Returns { rows: [...] } for the POS "Sales (Today / Custom)" table.

import { neon } from "@neondatabase/serverless";

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const sql = neon(env.DATABASE_URL);
  const tenantId = request.headers.get("x-tenant-id") || "";
  if (!tenantId) return j({ ok: false, error: "Missing tenant" }, 400);

  const url = new URL(request.url);
  const preset = (url.searchParams.get("preset") || "").toLowerCase();
  const fromQ = url.searchParams.get("from") || "";
  const toQ = url.searchParams.get("to") || "";

  // Build time window
  // - preset=today → [today, tomorrow)
  // - else if from/to provided → [from, to] (inclusive)
  // - else default to today
  let whereClause = "";
  let params: any[] = [tenantId];

  if (preset === "today" || (!fromQ && !toQ)) {
    whereClause = `
      AND sale_ts >= date_trunc('day', now())
      AND sale_ts <  date_trunc('day', now()) + interval '1 day'
    `;
  } else {
    // Accept ISO date or date-time; coerce safely in SQL
    whereClause = `
      AND sale_ts >= COALESCE((to_timestamp($2, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), (to_timestamp($2, 'YYYY-MM-DD')))
      AND sale_ts <= COALESCE((to_timestamp($3, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), (to_timestamp($3, 'YYYY-MM-DD')) + interval '1 day' - interval '1 second')
    `;
    params.push(fromQ || "", toQ || "");
  }

  try {
    const rows = await sql/*sql*/`
      SELECT
        sale_id,
        to_char(sale_ts, 'YYYY-MM-DD HH24:MI') AS time,
        payment_method AS payment,
        total::numeric                         AS total,
        NULL::text                             AS clerk
      FROM app.sales
      WHERE tenant_id = ${params[0]}::uuid
      ${sql.unsafe(whereClause)}
      ORDER BY sale_ts DESC
      LIMIT 200
    `;

    return j({ ok: true, rows });
  } catch (e: any) {
    return j({ ok: false, error: String(e?.message || e) }, 500);
  }
};

function j(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
