// /api/pos/checkout/status?invoice=...
import { neon } from "@neondatabase/serverless";

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const steps: string[] = [];                         // <-- NEW: in-response debug trail
  const nowIso = new Date().toISOString();

  const tenantId = request.headers.get("x-tenant-id") || "";
  if (!tenantId) return json({ ok: false, error: "Missing tenant", debug: { steps, at: nowIso } }, 400);

  const url = new URL(request.url);
  const invoice = url.searchParams.get("invoice") || "";
  if (!invoice) return json({ ok: false, error: "Missing invoice", debug: { steps, at: nowIso } }, 400);

  steps.push(`lookup session for ${invoice}`);
  const sess = await getSession(env, tenantId, invoice);
  if (!sess) return json({ ok: true, status: "pending", debug: { steps: [...steps, "no session"], at: nowIso } });
  
  steps.push(`session status=${sess.status}`);

  if (sess.status === "pending") {
    // VC07 fallback: if the session is a bit old and we haven't seen a webhook,
    // query Valor's transaction status API and update the session.
    const ageMs = Date.now() - new Date(sess.started_at).getTime();
    steps.push(`ageMs=${ageMs}`);
    if (ageMs > 10_000) {
      steps.push("fallback:fetch status");
      const resolved = await fetchAndApplyValorStatus(env, tenantId, invoice);
      
      // NEW: surface URL + HTTP code + raw state in the browser-visible debug trail
      if (resolved && resolved._trace) {
        steps.push(`status.url=${resolved._trace.url}`);
        steps.push(`status.http=${resolved._trace.http}`);
        if (resolved._trace.rawState) steps.push(`status.rawState=${resolved._trace.rawState}`);
      }
      
      steps.push(`fallback result=${resolved?.status || "unknown"}`);
      if (resolved?.status === "approved") {
        return json({ ok: true, status: "approved", sale_id: resolved.sale_id || undefined, debug: { steps, at: nowIso } });
      }
      if (resolved?.status === "declined") {
        return json({ ok: true, status: "declined", message: resolved.message || "", debug: { steps, at: nowIso } });
      }
    }
    return json({ ok: true, status: "pending", debug: { steps, at: nowIso } });
  }
  
  if (sess.status === "approved") {
    return json({ ok: true, status: "approved", sale_id: sess.sale_id || undefined, debug: { steps, at: nowIso } });
  }
  if (sess.status === "declined") {
    const msg = readDeclineMessage(sess.webhook_json);
    return json({ ok: true, status: "declined", message: msg, debug: { steps, at: nowIso } });
  }

  return json({ ok: true, status: String(sess.status || "pending"), debug: { steps, at: nowIso } });
}; // <-- close onRequest before defining helpers

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
  const sql = neon(env.DATABASE_URL);
  const rows = await sql/*sql*/`
    SELECT status, sale_id, webhook_json, started_at
      FROM app.valor_sessions_log
     WHERE tenant_id = ${tenantId}::uuid
       AND invoice_number = ${invoice}
     ORDER BY started_at DESC
     LIMIT 1
  `;
  return rows?.[0] || null;
}

// Minimal VC07 fallback: query Valor transaction status and mirror the webhook updater.
// Uses the same invoice we published with.
async function fetchAndApplyValorStatus(env: Env, tenantId: string, invoice: string) {
  try {
    const body = {
      appid:      env.VALOR_APP_ID,
      appkey:     env.VALOR_APP_KEY,
      epi:        env.VALOR_EPI,
      txn_type:   "transaction_status",
      channel_id: env.VALOR_CHANNEL_ID,
      version:    "1",
      INVOICENUMBER: invoice
    };

    let url = String(env.VALOR_STATUS_URL || env.VALOR_PUBLISH_URL || "");
    if (url && !/[?&]status(=|$)/i.test(url)) url += (url.includes("?") ? "&" : "?") + "status";

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body)
    });
    const http = r.status;
    const text = await r.text();
    let json: any = {}; try { json = JSON.parse(text); } catch {}

    // Normalize to our 3 states
    const rawState = String(json?.state || json?.data?.state || "");
    const s = rawState.toLowerCase();
    const status = s.includes("approved") ? "approved" : s.includes("declin") ? "declined" : "pending";

    if (status !== "pending") {
      const sql = neon(env.DATABASE_URL);
      await sql/*sql*/`
        UPDATE app.valor_sessions_log
           SET status = ${status},
               webhook_json = ${JSON.stringify(json || {})}::jsonb
         WHERE tenant_id = ${tenantId}::uuid
           AND invoice_number = ${invoice}
         ORDER BY started_at DESC
         LIMIT 1
      `;
      const saleId =
        status === "approved"
          ? (await sql/*sql*/`
              SELECT sale_id
                FROM app.valor_sessions_log
               WHERE tenant_id = ${tenantId}::uuid
                 AND invoice_number = ${invoice}
               ORDER BY started_at DESC
               LIMIT 1
            `)?.[0]?.sale_id || null
          : null;

      const message = String(json?.message || json?.data?.message || json?.error || json?.state || "");
      return { status, sale_id: saleId, message, _trace: { url, http, rawState } };
    }
    return { status: "pending", _trace: { url, http, rawState } };
  } catch {
    return { status: "pending" };
  }
}
