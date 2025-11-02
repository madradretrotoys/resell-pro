// /api/pos/checkout/force-finalize
// When the clerk chooses to finalize a sale without waiting for the Valor reply.
// We write the sale now, mark the session pending; the webhook will reconcile later.

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
  // TODO: select * from app.valor_sessions_log where invoice_number = $1 and status='pending'
  return { invoice_number: invoice, amount_cents: 0 };
}

async function finalizePendingSale(env: Env, tenantId: string, sess: any) {
  // TODO: create sale row; attach invoice number; return sale_id
  return "S-" + Math.floor(Date.now() / 1000);
}
