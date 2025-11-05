// /api/pos/webhooks/valor
// Mirrors the previous handler but scoped under /pos/* so it stays organized with POS code.

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env, waitUntil } = ctx;

  // Always ACK immediately so the processor never times out
  const ack = json({ ok: true });

  // Background processing
  const p = (async () => {
    try {
      const text = await request.text();
      let payload: any = {};
      try { payload = JSON.parse(text); } catch { payload = {}; }

      const tenantId =
        detectTenantFromPayload(payload) ||
        request.headers.get("x-tenant-id") ||
        "";

      const txnId =
        payload?.txn_id ||
        payload?.data?.txn_id ||
        ("rtx_" + crypto.randomUUID());

      const invoicenumber =
        payload?.invoicenumber ||
        payload?.data?.invoicenumber ||
        payload?.reference_descriptive_data?.invoicenumber ||
        "";

      // 1) Log raw webhook
      await insertWebhookLog(env, {
        tenant_id: tenantId,
        txn_id: txnId,
        invoice_number: invoicenumber || null,
        state: payload?.state || payload?.data?.state || null,
        amount: payload?.amount ?? payload?.data?.amount ?? null,
        total_with_fees: payload?.total_with_fees ?? null,
        raw: payload,
      });

      // 2) Update session status
      const status = normalizeStatus(payload);
      await updateSessionStatus(env, tenantId, invoicenumber, status, payload);

      // 3) If approved and sale not yet created, create it now
      if (status === "approved") {
        const saleId = await ensureSaleForApproved(env, tenantId, invoicenumber, payload);
        await stampSaleId(env, tenantId, invoicenumber, saleId);
      }
    } catch {
      // swallow to keep the ACK clean
    }
  })();

  waitUntil(p);
  return ack;
};

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function detectTenantFromPayload(p: any) {
  // Optional: derive tenant if encoded in invoicenumber
  return null;
}

function normalizeStatus(p: any): "pending" | "approved" | "declined" {
  const s = (p?.state || p?.data?.state || "").toString().toLowerCase();
  if (s.includes("approved")) return "approved";
  if (s.includes("declin")) return "declined";
  return "pending";
}

// ----- DB helpers (Neon) -----
async function insertWebhookLog(env: Env, row: any) {
  const sql = neon(env.DATABASE_URL);
  await sql/*sql*/`
    INSERT INTO app.valor_webhook_log
      (tenant_id, txn_id, invoice_number, state, amount, total_with_fees, raw, created_at)
    VALUES
      (${row.tenant_id || null}::uuid, ${row.txn_id || null}, ${row.invoice_number || null},
       ${row.state || null}, ${row.amount ?? null}, ${row.total_with_fees ?? null},
       ${JSON.stringify(row.raw || {})}::jsonb, now())
  `;
}

async function updateSessionStatus(env: Env, tenantId: string, invoice: string, status: string, wh: any) {
  // Update most-recent session for this invoice (pending -> approved/declined).
  const sql = neon(env.DATABASE_URL);
  await sql/*sql*/`
    UPDATE app.valor_sessions_log
       SET status = ${status},
           webhook_json = ${JSON.stringify(wh || {})}::jsonb
     WHERE tenant_id = ${tenantId}::uuid
       AND invoice_number = ${invoice}
     ORDER BY started_at DESC
     LIMIT 1
  `;
}

async function ensureSaleForApproved(env: Env, tenantId: string, invoice: string, wh: any) {
  const sql = neon(env.DATABASE_URL);

  // If a sale already exists for this session, return it.
  const rowsExisting = await sql/*sql*/`
    SELECT sale_id
      FROM app.valor_sessions_log
     WHERE tenant_id = ${tenantId}::uuid
       AND invoice_number = ${invoice}
     ORDER BY started_at DESC
     LIMIT 1
  `;
  if (rowsExisting?.[0]?.sale_id) return rowsExisting[0].sale_id;

  // Use the POS snapshot saved at session-open to create the canonical sale row.
  const sess = (await sql/*sql*/`
    SELECT pos_snapshot
      FROM app.valor_sessions_log
     WHERE tenant_id = ${tenantId}::uuid
       AND invoice_number = ${invoice}
     ORDER BY started_at DESC
     LIMIT 1
  `)?.[0];

  const snap = sess?.pos_snapshot || {};
  const items = snap?.items || [];
  const totals = snap?.totals || { raw_subtotal: 0, line_discounts: 0, subtotal: 0, tax: 0, total: 0 };

  // Mirror finalizeSale insert (canonical single source of truth)
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
  return ins?.[0]?.sale_id || null;
}

async function stampSaleId(env: Env, tenantId: string, invoice: string, saleId: string) {
  const sql = neon(env.DATABASE_URL);
  await sql/*sql*/`
    UPDATE app.valor_sessions_log
       SET sale_id = ${saleId}
     WHERE tenant_id = ${tenantId}::uuid
       AND invoice_number = ${invoice}
     ORDER BY started_at DESC
     LIMIT 1
  `;
}
