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

  // Parse body defensively and improve diagnostics
  let body: any = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  
  if (!body || typeof body !== "object") {
    return json({ ok: false, error: "Invalid payload: no JSON body" }, 400);
  }
  
  // Normalize items to a true array if the client sent something array-like
  let items = body.items;
  if (items && !Array.isArray(items) && typeof items.length === "number") {
    try { items = Array.from(items); } catch { /* ignore */ }
  }
  
  if (!Array.isArray(items)) {
    const t = typeof body.items;
    return json({ ok: false, error: `Invalid payload: items is ${t}` }, 400);
  }
  
  body.items = items;

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
  // Pull tenant tax from DB; fallback to env/default if missing.
  const sql = neon(env.DATABASE_URL);
  let taxRate = Number(env.DEFAULT_TAX_RATE ?? 0.085);
  try {
    const rows = await sql/*sql*/`
      SELECT sales_tax::numeric AS rate
      FROM app.tax_rates
      WHERE key = 'default'
      LIMIT 1
    `;
    if (rows?.[0]?.rate != null) taxRate = Number(rows[0].rate);
  } catch {
    // ignore — fallback already set
  }

  // Normalize and compute line math with discounts
  const normalized = (items || []).map((raw) => {
    const qty = Math.max(1, Number(raw?.qty ?? 1));
    const unit = Number(raw?.price ?? 0);
    const mode = String(raw?.discount?.mode ?? "").toLowerCase(); // "percent" | "amount" | ""
    const value = Number(raw?.discount?.value ?? 0);

    const lineRaw = +(unit * qty).toFixed(2);
    const lineDisc =
      mode === "percent" ? +((lineRaw * (value / 100))).toFixed(2)
      : mode === "amount" ? +((value * qty)).toFixed(2)
      : 0;

    const lineSub = +(lineRaw - lineDisc).toFixed(2);
    const lineTax = +(lineSub * taxRate).toFixed(2);
    const lineTotal = +(lineSub + lineTax).toFixed(2);

    return {
      sku: raw?.sku ?? null,
      name: raw?.name ?? null,
      price: unit,
      qty,
      discount: mode ? { mode, value } : undefined,
      // derived
      line_raw: lineRaw,
      line_discount: lineDisc,
      line_subtotal: lineSub,
      line_tax: lineTax,
      line_total: lineTotal,
      // pass-through references if present
      instore_loc: raw?.instore_loc ?? null,
      case_bin_shelf: raw?.case_bin_shelf ?? null,
      inventory_qty: raw?.inventory_qty ?? null,
    };
  });

  const rawSubtotal = normalized.reduce((s, it) => s + it.line_raw, 0);
  const lineDiscounts = normalized.reduce((s, it) => s + it.line_discount, 0);
  const subtotal = +(rawSubtotal - lineDiscounts).toFixed(2);
  const tax = +(normalized.reduce((s, it) => s + it.line_tax, 0)).toFixed(2);
  const total = +(subtotal + tax).toFixed(2);

  return {
    items: normalized,
    totals: {
      raw_subtotal: +rawSubtotal.toFixed(2),
      line_discounts: +lineDiscounts.toFixed(2),
      subtotal,
      tax,
      total,
      tax_rate: taxRate,
    },
  };
}

async function finalizeSale(
  env: Env,
  tenantId: string,
  args: { items: any[]; totals: any; payment: string; snapshot: any }
) {
  const sql = neon(env.DATABASE_URL);

  // Save a verbose snapshot for audit/debug + UI drill-ins
  const itemsJson = JSON.stringify({
    items: args.items,          // includes line_raw, line_discount, line_subtotal, line_tax, line_total
    totals: args.totals,        // includes raw_subtotal, line_discounts, subtotal, tax, total, tax_rate
    payment: args.payment,
    raw: args.snapshot          // original client payload
  });

  const rows = await sql/*sql*/`
    INSERT INTO app.sales (
      sale_ts,
      tenant_id,
      raw_subtotal,
      line_discounts,
      subtotal,
      tax,
      total,
      payment_method,
      items_json
    )
    VALUES (
      now(),
      ${tenantId}::uuid,
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

async function insertValorPublish(env: Env, row: any) {
  const sql = neon(env.DATABASE_URL);
  const payload = JSON.stringify(row.payload ?? {});
  await sql/*sql*/`
    INSERT INTO app.valor_publish
      (tenant_id, req_txn_id, invoice_number, phase, http, url, payload, created_at)
    VALUES
      (${row.tenant_id}::uuid, ${row.req_txn_id}, ${row.invoice_number},
       ${row.phase || "start"}, ${row.http || "POST"}, ${row.url || ""},
       ${payload}::jsonb, now())
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
       SET ack_msg = ${String(data?.ack_msg || "sent")}
     WHERE req_txn_id = ${reqTxnId}
  `;
}

async function publishToValor(env: Env, args: { invoicenumber: string, amount: number, req_txn_id: string }) {
  // TODO: perform Valor publish with mirrored names
  // return { message: "sent" };
  return { message: "sent" };
}
