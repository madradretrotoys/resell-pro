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

  // Prefer client totals (exactly what the UI showed). Fallback to computeTotals if absent.
  function coerceTotals(t: any) {
    if (!t || typeof t !== "object") return null;
    const n = (v: any) => Number.isFinite(Number(v)) ? Number(v) : 0;
    const r2 = (v: any) => Number.parseFloat(n(v).toFixed(2));
  
    // Trust client values, clamp to 2 decimals (no recalculation)
    const out = {
      raw_subtotal: r2(t.raw_subtotal ?? t.subtotal ?? 0),
      line_discounts: r2(t.line_discounts ?? t.discount ?? 0),
      subtotal: r2(t.subtotal ?? 0),
      tax: r2(t.tax ?? 0),
      total: r2(t.total ?? 0),
      tax_rate: n(t.tax_rate ?? 0) // keep as provided (e.g., 0.08)
    };
    return out;
  }
  
  const clientTotals = coerceTotals(body.totals);
  // Ensure per-line fields exist (line_discount, line_final). Do NOT change totals.
  const r2 = (v: any) => Number.parseFloat(Number(v || 0).toFixed(2));
  const ensureLineFields = (list: any[]) => (list || []).map((raw) => {
    const qty = Math.max(1, Number(raw?.qty ?? 0));
    const unit = Number(raw?.price ?? 0);
    const mode = String(raw?.discount?.mode ?? "percent").toLowerCase();
    const val  = Number(raw?.discount?.value ?? 0);
    const lineRaw = unit * qty;
    const hasDisc = Number.isFinite(Number(raw?.line_discount));
    const hasFinal = Number.isFinite(Number(raw?.line_final));
    const disc = hasDisc ? Number(raw.line_discount) :
                (mode === "percent" ? (lineRaw * (val / 100)) : val);
    const final = hasFinal ? Number(raw.line_final) : (lineRaw - disc);
    return {
      ...raw,
      line_discount: r2(Math.min(disc, lineRaw)),
      line_final:    r2(Math.max(0, final)),
    };
  });
  
  const repriced = clientTotals
    ? { items: ensureLineFields(body.items), totals: clientTotals }
    : await computeTotals(env, tenantId, body.items); // fallback only

  // Determine payment shape
  const payment: string = String(body.payment || "");
  const hasCard = /(^card:)|(^split:.*card:)/i.test(payment);

  if (!hasCard) {
    // Pure cash/wallet flow → finalize now
    const saleId = await finalizeSale(env, tenantId, { items: repriced.items, totals: repriced.totals, payment, snapshot: body });
    return json({ ok: true, status: "completed", sale_id: saleId });
  }

  // Card flow — open Valor publish + session
  let invoicenumber = makeInvoiceNumber(tenantId);
  // hard guard (belt & suspenders) — ensure ≤24 chars before any write/publish
  if (invoicenumber.length > 24) invoicenumber = invoicenumber.slice(0, 24);
  
  const txnId = makeTxnId();

  // Record outbound intent
  await insertValorPublish(env, {
    tenant_id: tenantId,
    phase: "start",
    txn_id: txnId,
    url: "valor/purchase", // informational; real URL used in publish call
    http: "POST",
    payload: { items: repriced.items, totals: repriced.totals, payment, invoicenumber },
    invoice_number: invoicenumber,
  });

  // Create pending session
  await openValorSession(env, {
    tenant_id: tenantId,
    invoice_number: invoicenumber,
    txn_id: txnId,
    attempt: 1,
    amount_cents: Math.round(repriced.totals.total * 100),
    status: "pending",
    started_at: new Date().toISOString(),
    // Keep exactly what the UI saw (now enriched with line_discount & line_final)
    items: repriced.items,
    totals: repriced.totals,
    payment,
    webhook_json: null,
  });

  // Publish to Valor (mirror names & shapes; keep invoicenumber)
  try {
    const valorRes = await publishToValor(env, {
      tenant_id: tenantId,
      invoicenumber,
      amount: repriced.totals.total,
      txn_id: txnId,
    });
    await markValorPublishAck(env, txnId, {
      ack_msg: valorRes?.message || (valorRes?.accepted ? "accepted" : "sent"),
    });
  } catch (e: any) {
    await markValorPublishAck(env, txnId, { ack_msg: `error:${e?.message || e}` });
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

function makeTxnId() {
  return "tx_" + crypto.randomUUID();
}

function makeInvoiceNumber(tenantId: string) {
  // Legacy-friendly invoice: short tenant prefix + base36 timestamp, hard-capped at 24 chars.
  const t = (tenantId || "").replace(/-/g, "").slice(0, 6).toUpperCase();
  const ts = Date.now().toString(36).toUpperCase(); // much shorter than decimal
  const raw = `INV-${t}-${ts}`;
  return raw.slice(0, 24);
}

async function computeTotals(env: Env, tenantId: string, items: any[]) {
  // Pull tenant tax from DB; fallback to env/default if missing.
  const sql = neon(env.DATABASE_URL);
  let taxRate = Number(env.DEFAULT_TAX_RATE ?? 0.080);
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
  // <<< add this normalization so 8.5 becomes 0.085 if we ever fall back >>>
  if (taxRate > 1) taxRate = taxRate / 100;

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

  // Store only the canonical, enriched view — no duplication
  const itemsJson = JSON.stringify({
    schema: "pos:v1",
    source_totals: "client", // documents where totals came from; helpful for audits
    items: args.items,
    totals: args.totals,
    payment: args.payment,
     // If client supplied structured parts, persist them for reconciliation
    payment_parts: Array.isArray(args?.snapshot?.payment_parts) ? args.snapshot.payment_parts : undefined

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

// Upsert-by-phase so we always persist what we sent/received for this txn_id.
async function insertValorPublish(env: Env, row: any) {
  const sql = neon(env.DATABASE_URL);
  const phase = String(row.phase || "start");
  const reqUrl = row.url || "";
  const http = row.http || "POST";
  const j = (o: any) => JSON.stringify(o ?? {});

  if (phase === "start") {
    // First write: create the row
    await sql/*sql*/`
      INSERT INTO app.valor_publish
        (tenant_id, txn_id, invoice_number, phase, http, url, payload, created_at)
      VALUES
        (${row.tenant_id}::uuid, ${row.txn_id}, ${row.invoice_number},
         ${phase}, ${http}, ${reqUrl}, ${j(row.payload)}::jsonb, now())
      ON CONFLICT (txn_id) DO NOTHING
    `;
    return;
  }

  if (phase === "request") {
    // Store the masked request + final URL used
    await sql/*sql*/`
      UPDATE app.valor_publish
         SET phase   = ${phase},
             http    = ${http},
             url     = ${reqUrl},
             payload = COALESCE(payload, '{}'::jsonb)
                       || jsonb_build_object('request', ${j(row.payload)}::jsonb)
       WHERE txn_id = ${row.txn_id}
    `;
    return;
  }

  if (phase === "response") {
    // Store the raw response (status/text) and keep ack_msg for quick scanning
    await sql/*sql*/`
      UPDATE app.valor_publish
         SET phase   = ${phase},
             http    = ${http},
             url     = ${reqUrl},
             ack_msg = ${String(row.payload?.response ?? row.ack_msg ?? "")},
             payload = COALESCE(payload, '{}'::jsonb)
                       || jsonb_build_object('response', ${j(row.payload)}::jsonb)
       WHERE txn_id = ${row.txn_id}
    `;
    return;
  }
}

async function openValorSession(env: Env, row: any) {
  const sql = neon(env.DATABASE_URL);
  const snap = JSON.stringify({
    items: row.items ?? [],
    totals: row.totals ?? null,
    payment: row.payment ?? null,
    payment_parts: Array.isArray(row.payment_parts) ? row.payment_parts : undefined
  });
  // Store the client POS snapshot inside webhook_json (under a namespaced key)
  // so we keep the data without changing your table.
  const combined = JSON.stringify({
    pos_snapshot: JSON.parse(snap),
    ...(row.webhook_json ? { webhook_json: row.webhook_json } : {})
  });
  
  // anchor: INSERT INTO app.valor_sessions_log
  await sql/*sql*/`
    INSERT INTO app.valor_sessions_log
      (tenant_id, invoice_number, txn_id, attempt, amount_cents, status, started_at, webhook_json)
    VALUES
      (${row.tenant_id}::uuid, ${row.invoice_number}, ${row.txn_id},
       ${row.attempt || 1}, ${row.amount_cents || 0}, ${row.status || "pending"},
       ${row.started_at || new Date().toISOString()}, ${combined}::jsonb)
  `;
}

async function markValorPublishAck(env: Env, txnId: string, data: any) {
  const sql = neon(env.DATABASE_URL);
  // anchor: UPDATE app.valor_publish
  await sql/*sql*/`
    UPDATE app.valor_publish
       SET ack_msg = ${String(data?.ack_msg || "sent")}
     WHERE txn_id = ${txnId}
        OR invoice_number = ${data?.invoice || null}
  `;
}

async function publishToValor(
  env: Env,
  args: { tenant_id: string; invoicenumber: string; amount: number; txn_id: string; epi?: string }
) {
  // ≤24 chars + ALL CAPS for Valor; also ensures we send INVOICENUMBER in both places
  const INVOICENUMBER = String(args.invoicenumber).slice(0, 24).toUpperCase();

  // Build legacy envelope (keys & casing)
  const body: any = {
    appid:      env.VALOR_APP_ID,
    appkey:     env.VALOR_APP_KEY,
    epi:        args.epi || env.VALOR_EPI,
    txn_type:   "vc_publish",
    channel_id: env.VALOR_CHANNEL_ID,
    version:    "1",
    INVOICENUMBER, // TOP-LEVEL (ALL CAPS)
    payload: {     // lower-case payload (not PAYLOAD)
      TRAN_MODE:   "1",
      TRAN_CODE:   "1",
      AMOUNT:      String(Math.round(Number(args.amount) * 100)), // cents as STRING
      REQ_TXN_ID:  String(args.txn_id || ""), // compat only; Valor doesn't use it
      INVOICENUMBER,                          // duplicate inside payload
    },
  };

  // Ensure publish URL includes ?status (legacy requirement)
  let url = String(env.VALOR_PUBLISH_URL || "");
  if (url && !/[?&]status(=|$)/i.test(url)) {
    url += (url.includes("?") ? "&" : "?") + "status";
  }

  // Mask secrets for the request journal
  const masked = { ...body, appkey: body.appkey ? String(body.appkey).slice(0, 4) + "***" : undefined };

  // JOURNAL: request → app.valor_publish
  await insertValorPublish(env, {
    tenant_id: args.tenant_id,
    txn_id: args.txn_id,
    invoice_number: INVOICENUMBER,
    phase: "request",
    http: "POST",
    url,
    payload: masked
  });

  // Perform the publish
  let respStatus = -1;
  let respText = "";
  let respJson: any = null;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body)
    });
    respStatus = r.status;
    const t = await r.text();
    respText = t;
    try { respJson = JSON.parse(t); } catch { /* non-JSON OK */ }
  } catch (e: any) {
    respText = `error:${e?.message || String(e)}`;
  }

  // JOURNAL: response
  await insertValorPublish(env, {
    tenant_id: args.tenant_id,
    txn_id: args.txn_id,
    invoice_number: INVOICENUMBER,
    phase: "response",
    http: "POST",
    url,
    payload: { status: respStatus, response: respText }
  });

  // Treat VC07 / timeout as accepted (legacy behavior)
  const ackMsg = String((respJson && (respJson.ACKMSG || respJson.ack_msg)) || respText || "");
  const accepted =
    (respStatus >= 200 && respStatus < 300) ||
    /VC07/i.test(ackMsg) ||
    /timeout/i.test(ackMsg);

  return { accepted, message: ackMsg || "sent" };
}
