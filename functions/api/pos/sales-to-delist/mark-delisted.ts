// /api/pos/sales-to-delist/mark-delisted
// Body: { delist_id: string }
// Marks a row as delisted.

import { neon } from "@neondatabase/serverless";

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const sql = neon(env.DATABASE_URL);

  if (request.method !== "POST") {
    return j({ ok: false, error: "Method not allowed" }, 405);
  }

  const tenantId = request.headers.get("x-tenant-id") || "";
  if (!tenantId) return j({ ok: false, error: "Missing tenant" }, 400);

  // If your auth layer provides this header, we’ll store it; otherwise null is fine.
  const userId = request.headers.get("x-user-id") || null;

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const delistId = String(body?.delist_id || "").trim();
  if (!delistId) return j({ ok: false, error: "Missing delist_id" }, 400);

  const rows = await sql/*sql*/`
    UPDATE app.sales_to_delist
       SET status = 'delisted'::app.delist_status,
           delisted_at = now(),
           delisted_by = ${userId}::uuid
     WHERE tenant_id = ${tenantId}::uuid
       AND delist_id = ${delistId}::uuid
       AND status = 'pending'::app.delist_status
     RETURNING delist_id
  `;

  return j({ ok: true, updated: rows?.length || 0 }, 200);
};

function j(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
