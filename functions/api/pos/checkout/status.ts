// /api/pos/checkout/status?invoice=...

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const tenantId = request.headers.get("x-tenant-id") || "";
  if (!tenantId) return json({ ok: false, error: "Missing tenant" }, 400);

  const url = new URL(request.url);
  const invoice = url.searchParams.get("invoice") || "";
  if (!invoice) return json({ ok: false, error: "Missing invoice" }, 400);

  const sess = await getSession(env, tenantId, invoice);
  if (!sess) return json({ ok: true, status: "pending" });

  if (sess.status === "pending") return json({ ok: true, status: "pending" });
  if (sess.status === "approved") {
    return json({ ok: true, status: "approved", sale_id: sess.sale_id || undefined });
  }
  if (sess.status === "declined") {
    const msg = readDeclineMessage(sess.webhook_json);
    return json({ ok: true, status: "declined", message: msg });
  }

  return json({ ok: true, status: String(sess.status || "pending") });
};

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function readDeclineMessage(wh: any) {
  try {
    if (!wh) return "";
    const m = wh?.message || wh?.data?.message || wh?.error || wh?.state;
    return String(m || "");
  } catch {
    return "";
  }
}

async function getSession(env: Env, tenantId: string, invoice: string) {
  // TODO: select latest from app.valor_sessions_log where tenant_id & invoice_number
  return null;
}
