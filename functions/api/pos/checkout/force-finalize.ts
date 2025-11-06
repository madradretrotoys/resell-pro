// /api/pos/checkout/force-finalize
// When the clerk chooses to finalize a sale without waiting for the Valor reply.
// We write the sale now, mark the session pending; the webhook will reconcile later.
import { neon } from "@neondatabase/serverless";

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const tenantId = request.headers.get("x-tenant-id") || "";
  if (!tenantId) return json({ ok: false, error: "Missing tenant" }, 400);

  // TEMP MODE: finalize without waiting for Valor response.
  // If body contains items/totals (like CASH flow), write a sale immediately.
  // If body only contains {invoice}, fall back to the session-based finalize (kept for flexibility).
  // Try JSON first; if that fails, try text→JSON so we can still parse bodies
  const contentType = request.headers.get("content-type") || "";
  let body: any = null;
  try { body = await request.json(); } catch { /* fall through */ }
  if (!body) {
    try {
      const raw = await request.text();
      if (raw) body = JSON.parse(raw);
    } catch { body = null; }
  }

  const hasSnapshot = body && Array.isArray(body.items) && body.totals && typeof body.totals === "object";
  if (hasSnapshot) {
    const saleId = await finalizeSale(env, tenantId, {
      items: body.items,
      totals: body.totals,
      payment: String(body.payment || "card"),
      snapshot: body
    });
    return json({ ok: true, sale_id: saleId });
  }

  // Fallback: legacy (needs invoice) — still supported but not required for temp flow
  const invoice = String(body?.invoice || "");
  if (!invoice) {
    const gotKeys = body && typeof body === "object" ? Object.keys(body) : [];
    return json(
      { ok: false, error: "Missing snapshot (need items+totals)", debug: { contentType, gotKeys } },
      400
    );
  }

  const sess = await getPendingSession(env, tenantId, invoice);
  if (!sess) return json({ ok: false, error: "No pending session" }, 404);
  const saleId = await finalizePendingSale(env, tenantId, sess);
  return json({ ok: true, sale_id: saleId });
};

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

async function getPendingSession(env: Env, tenantId: string, invoice: string) {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql/*sql*/`
    SELECT invoice_number, txn_id, amount_cents, started_at, webhook_json
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

  // 👇 snapshot is stored under webhook_json.pos_snapshot (from /start)
  let snap: any = {};
  try { snap = (sess?.webhook_json?.pos_snapshot) || {}; } catch { snap = {}; }

  const items = Array.isArray(snap?.items) ? snap.items : [];
  const totals = snap?.totals || { raw_subtotal: 0, line_discounts: 0, subtotal: 0, tax: 0, total: 0 };
  const paymentMethod = typeof snap?.payment === "string" && snap.payment ? snap.payment : "card";

  const itemsJson = JSON.stringify({
    schema: "pos:v1",
    source_totals: "client",
    items,
    totals,
    payment: paymentMethod,
    payment_parts: Array.isArray(snap?.payment_parts) ? snap.payment_parts : undefined
  });

  const ins = await sql/*sql*/`
    INSERT INTO app.sales (
      sale_ts, tenant_id, raw_subtotal, line_discounts, subtotal, tax, total, payment_method, items_json
    ) VALUES (
      now(), ${tenantId}::uuid, ${totals.raw_subtotal}::numeric, ${totals.line_discounts}::numeric,
      ${totals.subtotal}::numeric, ${totals.tax}::numeric, ${totals.total}::numeric,
      ${paymentMethod}, ${itemsJson}
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

// --- anchor: force-finalize local finalizeSale (copied from /start) ---
async function finalizeSale(
  env: Env,
  tenantId: string,
  args: { items: any[]; totals: any; payment: string; snapshot: any }
) {
  const sql = neon(env.DATABASE_URL);

  const itemsJson = JSON.stringify({
    schema: "pos:v1",
    source_totals: "client",
    items: args.items,
    totals: args.totals,
    payment: args.payment,
    payment_parts: Array.isArray(args?.snapshot?.payment_parts) ? args.snapshot.payment_parts : undefined
  });

  const rows = await sql/*sql*/`
    INSERT INTO app.sales (
      sale_ts, tenant_id, raw_subtotal, line_discounts, subtotal, tax, total, payment_method, items_json
    )
    VALUES (
      now(), ${tenantId}::uuid,
      ${args.totals.raw_subtotal}::numeric,
      ${args.totals.line_discounts}::numeric,
      ${args.totals.subtotal}::numeric,
      ${args.totals.tax}::numeric,
      ${args.totals.total}::numeric,
      ${args.payment},
      ${itemsJson}
    )
    RETURNING sale_id
  `;
  return rows[0]?.sale_id || null;
}
// --- /anchor: force-finalize local finalizeSale ---
