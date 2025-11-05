// /api/pos/checkout/force-finalize
// When the clerk chooses to finalize a sale without waiting for the Valor reply.
// We write the sale now, mark the session pending; the webhook will reconcile later.
import { neon } from "@neondatabase/serverless";

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const tenantId = request.headers.get("x-tenant-id") || "";
  if (!tenantId) return json({ ok: false, error: "Missing tenant" }, 400);

  const body = await request.json().catch(() => null) as any;
  const invoice = String(body?.invoice || "");
  if (!invoice) return json({ ok: false, error: "Missing invoice" }, 400);

  // Load the pending session (must exist)
  const sess = await getPendingSession(env, tenantId, invoice);
  if (!sess) return json({ ok: false, error: "No pending session" }, 404);

  // Create the sale now (pending card)
  const saleId = await finalizePendingSale(env, tenantId, sess);

  // Keep session pending; webhook will write approval & stamp sale_id if needed
  return json({ ok: true, sale_id: saleId });
};

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

async function getPendingSession(env: Env, tenantId: string, invoice: string) {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql/*sql*/`
    SELECT invoice_number, req_txn_id, amount_cents, started_at, pos_snapshot
      FROM app.valor_sessions_log
     WHERE tenant_id = ${tenantId}::uuid
       AND invoice_number = ${invoice}
       AND status = 'pending'
     ORDER BY started_at DESC
     LIMIT 1
  `;
  return rows?.[0] || null;
}

async function finalizePendingSale(env: Env, tenantId: string, sess: any) {
  const sql = neon(env.DATABASE_URL);
  const snap = sess?.pos_snapshot || {};
  const items = snap?.items || [];
  const totals = snap?.totals || { raw_subtotal: 0, line_discounts: 0, subtotal: 0, tax: 0, total: 0 };

  const itemsJson = JSON.stringify({
    schema: "pos:v1",
    source_totals: "client",
    items,
    totals,
    payment: "card",
    payment_parts: Array.isArray(snap?.payment_parts) ? snap.payment_parts : undefined
  });

  const ins = await sql/*sql*/`
    INSERT INTO app.sales (
      sale_ts, tenant_id, raw_subtotal, line_discounts, subtotal, tax, total, payment_method, items_json
    ) VALUES (
      now(), ${tenantId}::uuid, ${totals.raw_subtotal}::numeric, ${totals.line_discounts}::numeric,
      ${totals.subtotal}::numeric, ${totals.tax}::numeric, ${totals.total}::numeric,
      'card', ${itemsJson}
    )
    RETURNING sale_id
  `;
  const saleId = ins?.[0]?.sale_id || null;

  // Keep session pending; just stamp sale_id so webhook can reconcile later.
  if (saleId) {
    await sql/*sql*/`
      UPDATE app.valor_sessions_log
         SET sale_id = ${saleId}
       WHERE tenant_id = ${tenantId}::uuid
         AND invoice_number = ${sess.invoice_number}
       ORDER BY started_at DESC
       LIMIT 1
    `;
  }
  return saleId;
}
