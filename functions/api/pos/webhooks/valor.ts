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

      const reqTxnId =
        payload?.req_txn_id ||
        payload?.data?.req_txn_id ||
        ("rtx_" + crypto.randomUUID());

      const invoicenumber =
        payload?.invoicenumber ||
        payload?.data?.invoicenumber ||
        payload?.reference_descriptive_data?.invoicenumber ||
        "";

      // 1) Log raw webhook
      await insertWebhookLog(env, {
        tenant_id: tenantId,
        req_txn_id: reqTxnId,
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

// ----- DB helpers (implement with Neon) -----
async function insertWebhookLog(env: Env, row: any) { /* TODO: insert into app.valor_webhook_log */ }
async function updateSessionStatus(env: Env, tenantId: string, invoice: string, status: string, wh: any) { /* TODO */ }
async function ensureSaleForApproved(env: Env, tenantId: string, invoice: string, wh: any) { /* TODO */ return "S-" + Math.floor(Date.now() / 1000); }
async function stampSaleId(env: Env, tenantId: string, invoice: string, saleId: string) { /* TODO */ }
