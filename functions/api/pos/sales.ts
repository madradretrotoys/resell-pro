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

  // Build time window (bind parameters with the template tag; no $2/$3)
  const todayQuery = sql/*sql*/`
    SELECT
      sale_id,
      to_char(sale_ts, 'YYYY-MM-DD HH24:MI') AS time,
      payment_method AS payment,
      total::numeric                         AS total,
      NULL::text                             AS clerk
    FROM app.sales
    WHERE tenant_id = ${tenantId}::uuid
      AND sale_ts >= date_trunc('day', now())
      AND sale_ts <  date_trunc('day', now()) + interval '1 day'
    ORDER BY sale_ts DESC
    LIMIT 200
  `;

  const rangeQuery = sql/*sql*/`
    SELECT
      sale_id,
      to_char(sale_ts, 'YYYY-MM-DD HH24:MI') AS time,
      payment_method AS payment,
      total::numeric                         AS total,
      NULL::text                             AS clerk
    FROM app.sales
    WHERE tenant_id = ${tenantId}::uuid
      AND sale_ts >= ${fromQ || ""}::date
      AND sale_ts <  (${toQ || ""}::date + interval '1 day')
    ORDER BY sale_ts DESC
    LIMIT 200
  `;

  try {
    const rows =
      (preset === "today" || (!fromQ && !toQ))
        ? await todayQuery
        : await rangeQuery;

    return j({ ok: true, rows });

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
