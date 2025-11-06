// /api/pos/checkout/resend
// Re-publish the SAME invoice to Valor (forces a new attempt) without creating a new sale/session.
import { neon } from "@neondatabase/serverless";

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const tenantId = request.headers.get("x-tenant-id") || "";
  if (!tenantId) return json({ ok: false, error: "Missing tenant" }, 400);

  const body = await request.json().catch(() => null) as any;
  const invoice = String(body?.invoice || "");
  if (!invoice) return json({ ok: false, error: "Missing invoice" }, 400);

  const sql = neon(env.DATABASE_URL);

  // Find latest pending session for this invoice
  const sess = (await sql/*sql*/`
    SELECT invoice_number, txn_id, amount_cents, attempt, started_at
      FROM app.valor_sessions_log
     WHERE tenant_id = ${tenantId}::uuid
       AND invoice_number = ${invoice}
     ORDER BY started_at DESC
     LIMIT 1
  `)?.[0];

  if (!sess) return json({ ok: false, error: "No session for invoice" }, 404);

  const nextAttempt = Number(sess.attempt || 1) + 1;
  const txnId = makeTxnId();

  // Record intent
  await insertValorPublish(env, {
    tenant_id: tenantId,
    phase: "request",
    txn_id: txnId,
    invoice_number: invoice,
    http: "POST",
    url: "valor/purchase",
    payload: { attempt: nextAttempt, invoice }
  });

  // Publish to Valor with SAME invoice & amount
  let ack = "sent";
  try {
    const res = await publishToValor(env, {
      tenant_id: tenantId,
      invoicenumber: invoice,
      amount: (Number(sess.amount_cents || 0) / 100),
      txn_id: txnId,
    });
    ack = res?.message || (res?.accepted ? "accepted" : "sent");
    await markValorPublishAck(env, txnId, { ack_msg: ack, invoice });
  } catch (e: any) {
    ack = `error:${e?.message || e}`;
    await markValorPublishAck(env, txnId, { ack_msg: ack, invoice });
  }

  // Bump attempt; keep status pending
  await sql/*sql*/`
    UPDATE app.valor_sessions_log
       SET attempt = ${nextAttempt},
           last_seen_at = now()
     WHERE tenant_id = ${tenantId}::uuid
       AND invoice_number = ${invoice}
     ORDER BY started_at DESC
     LIMIT 1
  `;

  return json({ ok: true, invoice, attempt: nextAttempt, ack });
};

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function makeTxnId() { return "tx_" + crypto.randomUUID(); }

// Minimal copies of helpers we use in /start:
async function insertValorPublish(env: Env, row: any) {
  const sql = neon(env.DATABASE_URL);
  await sql/*sql*/`
    INSERT INTO app.valor_publish (tenant_id, txn_id, invoice_number, phase, http, url, payload, created_at)
    VALUES (${row.tenant_id}::uuid, ${row.txn_id}, ${row.invoice_number}, ${row.phase}, ${row.http}, ${row.url}, ${JSON.stringify(row.payload || {})}::jsonb, now())
    ON CONFLICT (txn_id) DO NOTHING
  `;
}
async function markValorPublishAck(env: Env, txnId: string, data: any) {
  const sql = neon(env.DATABASE_URL);
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
  const INVOICENUMBER = String(args.invoicenumber).slice(0, 24).toUpperCase();
  const body: any = {
    appid:      env.VALOR_APP_ID,
    appkey:     env.VALOR_APP_KEY,
    epi:        args.epi || env.VALOR_EPI,
    txn_type:   "vc_publish",
    channel_id: env.VALOR_CHANNEL_ID,
    version:    "1",
    INVOICENUMBER,
    payload: {
      TRAN_MODE:   "1",
      TRAN_CODE:   "1",
      AMOUNT:      String(Math.round(Number(args.amount) * 100)),
      REQ_TXN_ID:  String(args.txn_id || ""),
      INVOICENUMBER,
    },
  };

  let url = String(env.VALOR_PUBLISH_URL || "");
  if (url && !/[?&]status(=|$)/i.test(url)) url += (url.includes("?") ? "&" : "?") + "status";

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let json: any = {}; try { json = JSON.parse(text); } catch {}
  return { accepted: !!json, message: json?.message || "" };
}
