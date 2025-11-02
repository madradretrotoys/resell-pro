// /api/webhooks/valor
// Mirrors the behavior you had in the CF worker: always ACK fast,
// then process in the background to update valor_webhook_log + valor_sessions_log
// and finalize the sale if approved.

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env, waitUntil } = ctx;

  // Always ACK immediately
  const ack = json({ ok: true });

  // Background processing
  const p = (async () => {
    try {
      const text = await request.text();
      let payload: any = {};
      try { payload = JSON.parse(text); } catch { payload = {}; }

      const tenantId = detectTenantFromPayload(payload) || request.headers.get("x-tenant-id") || "";
      const reqTxnId = payload?.req_txn_id || payload?.data?.req_txn_id || "";
      const invoicenumber = payload?.invoicenumber || payload?.data?.invoicenumber || payload?.reference_descriptive_data?.invoicenumber || "";

      // Log raw webhook
      await insertWebhookLog(env, {
        tenant_id: tenantId,
        req_txn_id: reqTxnId || ("rtx_" + crypto.randomUUID()),
        invoice_number: invoicenumber || null,
        state: payload?.state || payload?.data?.state || null,
        amount: payload?.amount ?? payload?.data?.amount ?? null,
        total_with_fees: payload?.total_with_fees ?? null,
        raw: payload,
      });

      // Upsert session status
      const status = normalizeStatus(payload);
      await updateSessionStatus(env, tenantId, invoicenumber, status, payload);

      // If approved and sale not yet created, create it now
      if (status === "approved") {
        const saleId = await ensureSaleForApproved(env, tenantId, invoicenumber, payload);
        // Attach sale id for quick reads in poll endpoint
        await stampSaleId(env, tenantId, invoicenumber, saleId);
      }
    } catch (e) {
      // swallow to keep ack happy
    }
  })();

  waitUntil(p);
  return ack;
};

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function detectTenantFromPayload(p: any) {
  // Optional: derive tenant if you encode it in invoicenumber; otherwise return null
  return null;
}

function normalizeStatus(p: any): "pending" | "approved" | "declined" {
  const s = (p?.state || p?.data?.state || "").toString().toLowerCase();
  if (s.includes("approved")) return "approved";
  if (s.includes("declin")) return "declined";
  return "pending";
}

async function insertWebhookLog(env: Env, row: any) {
  // TODO: insert into app.valor_webhook_log
}

async function updateSessionStatus(env: Env, tenantId: string, invoice: string, status: string, wh: any) {
  // TODO: update app.valor_sessions_log set status, last_seen_at, webhook_json where tenant_id+invoice_number
}

async function ensureSaleForApproved(env: Env, tenantId: string, invoice: string, wh: any) {
  // TODO: if sale not written (manual finalize not used), write sale now based on stored snapshot
  return "S-" + Math.floor(Date.now() / 1000);
}

async function stampSaleId(env: Env, tenantId: string, invoice: string, saleId: string) {
  // TODO: update app.valor_sessions_log set sale_id where tenant_id+invoice_number
}
