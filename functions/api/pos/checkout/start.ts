// /api/pos/checkout/start
// Orchestrates POS checkout. If card is involved, opens a Valor session and returns waiting status.
// If no card is involved, finalizes the sale immediately.
//
// NOTE: Mirrors legacy field names (e.g., invoicenumber) for compatibility.
import { neon } from "@neondatabase/serverless";

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const tenantId = request.headers.get("x-tenant-id") || "";
  if (!tenantId) return json({ ok: false, error: "Missing tenant" }, 400);

  const body = await request.json().catch(() => null) as any;
  if (!body || !Array.isArray(body.items)) return json({ ok: false, error: "Invalid payload" }, 400);

  // Server-side reprice / tax (simplified placeholder)
  const repriced = await computeTotals(env, tenantId, body.items);

  // Determine payment shape
  const payment: string = String(body.payment || "");
  const hasCard = /(^card:)|(^split:.*card:)/i.test(payment);

  if (!hasCard) {
    // Pure cash/wallet flow → finalize now
    const saleId = await finalizeSale(env, tenantId, { items: repriced.items, totals: repriced.totals, payment, snapshot: body });
    return json({ ok: true, status: "completed", sale_id: saleId });
  }

  // Card flow — open Valor publish + session
  const invoicenumber = makeInvoiceNumber(tenantId);
  const reqTxnId = makeReqTxnId();

  // Record outbound intent
  await insertValorPublish(env, {
    tenant_id: tenantId,
    phase: "start",
    req_txn_id: reqTxnId,
    url: "valor/purchase", // informational; real URL used in publish call
    http: "POST",
    payload: { items: repriced.items, totals: repriced.totals, payment, invoicenumber },
    invoice_number: invoicenumber,
  });

  // Create pending session
  await openValorSession(env, {
    tenant_id: tenantId,
    invoice_number: invoicenumber,
    req_txn_id: reqTxnId,
    attempt: 1,
    amount_cents: Math.round(repriced.totals.total * 100),
    status: "pending",
    started_at: new Date().toISOString(),
    webhook_json: null,
  });

  // Publish to Valor (mirror names & shapes; keep invoicenumber)
  try {
    const valorRes = await publishToValor(env, { invoicenumber, amount: repriced.totals.total, req_txn_id: reqTxnId });
    await markValorPublishAck(env, reqTxnId, { ack_msg: valorRes?.message || "sent" });
  } catch (e: any) {
    await markValorPublishAck(env, reqTxnId, { ack_msg: `error:${e?.message || e}` });
  }

  // Return waiting response so the POS can poll
  return json({
    ok: true,
    status: "waiting_for_valor",
    invoice: invoicenumber,
    attempt: 1,
  });
};

// ---------- helpers (minimal implementations / placeholders) ----------
function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function makeReqTxnId() {
  return "rtx_" + crypto.randomUUID();
}

function makeInvoiceNumber(tenantId: string) {
  const now = Date.now();
  return `INV-${tenantId.slice(0, 8)}-${now}`;
}

async function computeTotals(env: Env, tenantId: string, items: any[]) {
  // TODO: real pricing; ensure parity with /api/pos/price/preview
  const subtotal = items.reduce((s, it) => s + Number(it.price || 0) * Number(it.qty || 1), 0);
  const taxRate = Number(env.DEFAULT_TAX_RATE ?? 0.085);
  const tax = +(subtotal * taxRate).toFixed(2);
  const total = +(subtotal + tax).toFixed(2);
  return { items, totals: { subtotal, discount: 0, tax, total } };
}

async function finalizeSale(
  env: Env,
  tenantId: string,
  args: { items: any[]; totals: any; payment: string; snapshot: any }
) {
  const sql = neon(env.DATABASE_URL);
  const snapshot = JSON.stringify({
    items: args.items,
    totals: args.totals,
    payment: args.payment,
    raw: args.snapshot,
  });

  const rows = await sql/*sql*/`
    INSERT INTO app.sales (tenant_id, sale_ts, subtotal, tax, total, payment, pos_snapshot)
    VALUES (${tenantId}::uuid, now(), ${args.totals.subtotal}::numeric, ${args.totals.tax}::numeric,
            ${args.totals.total}::numeric, ${args.payment}, ${snapshot}::jsonb)
    RETURNING sale_id
  `;
  return rows[0]?.sale_id || null;
}

async function insertValorPublish(env: Env, row: any) {
  const sql = neon(env.DATABASE_URL);
  const payload = JSON.stringify(row.payload ?? {});
  await sql/*sql*/`
    INSERT INTO app.valor_publish
      (tenant_id, req_txn_id, invoice_number, phase, http, url, payload, status, created_at)
    VALUES
      (${row.tenant_id}::uuid, ${row.req_txn_id}, ${row.invoice_number},
       ${row.phase || "start"}, ${row.http || "POST"}, ${row.url || ""},
       ${payload}::jsonb, 'created', now())
  `;
}

async function openValorSession(env: Env, row: any) {
  const sql = neon(env.DATABASE_URL);
  const snap = JSON.stringify({
    items: row.items ?? [],
    totals: row.totals ?? null,
    payment: row.payment ?? null
  });
  await sql/*sql*/`
    INSERT INTO app.valor_sessions_log
      (tenant_id, invoice_number, req_txn_id, attempt, amount_cents, status, started_at, pos_snapshot, webhook_json)
    VALUES
      (${row.tenant_id}::uuid, ${row.invoice_number}, ${row.req_txn_id},
       ${row.attempt || 1}, ${row.amount_cents || 0}, ${row.status || "pending"},
       ${row.started_at || new Date().toISOString()}, ${snap}::jsonb, ${row.webhook_json ? JSON.stringify(row.webhook_json) : null}::jsonb)
  `;
}

async function markValorPublishAck(env: Env, reqTxnId: string, data: any) {
  const sql = neon(env.DATABASE_URL);
  await sql/*sql*/`
    UPDATE app.valor_publish
       SET status = 'sent',
           ack_msg = ${String(data?.ack_msg || "sent")},
           acked_at = now()
     WHERE req_txn_id = ${reqTxnId}
  `;
}

async function publishToValor(env: Env, args: { invoicenumber: string, amount: number, req_txn_id: string }) {
  // TODO: perform Valor publish with mirrored names
  // return { message: "sent" };
  return { message: "sent" };
}
