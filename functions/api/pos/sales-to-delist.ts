// /api/pos/sales-to-delist
// Returns { rows: [...] } for the POS "Sales to Delist" table.

import { neon } from "@neondatabase/serverless";

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const sql = neon(env.DATABASE_URL);

  const tenantId = request.headers.get("x-tenant-id") || "";
  if (!tenantId) return j({ ok: false, error: "Missing tenant" }, 400);

  const url = new URL(request.url);
  const preset = (url.searchParams.get("preset") || "").toLowerCase();

  const tz = env.STORE_TZ || "America/Denver";

  // preset=pending (Phase 1); later you can add preset=all
  const onlyPending = preset === "pending" || !preset;

  const rows = await sql/*sql*/`
    SELECT
      d.delist_id,
      to_char((d.sale_ts AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS date,
      d.sku,
      COALESCE(i.product_short_title, '') AS item,
      d.qty_sold,
      d.final_price::numeric AS final_price,
      d.vendoo_url,
      d.status::text AS status,
      d.sale_id
    FROM app.sales_to_delist d
    LEFT JOIN app.inventory i
      ON i.tenant_id = d.tenant_id
     AND (i.item_id = d.item_id OR i.sku = d.sku)
    WHERE d.tenant_id = ${tenantId}::uuid
      AND (${onlyPending} = false OR d.status = 'pending'::app.delist_status)
    ORDER BY d.sale_ts DESC
    LIMIT 500
  `;

  return j({ ok: true, rows }, 200);
};

function j(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
