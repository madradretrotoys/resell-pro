import { neon } from "@neondatabase/serverless";

export const onRequestPost = async ({ request, env }) => {
  const sql = neon(env.DATABASE_URL);
  const body = await request.json().catch(() => ({}));

  console.log("[fb.callback] raw body →", body);

  const item_id = String(body?.item_id || "").trim();
  const status  = String(body?.status || "").trim().toLowerCase();
  const message = String(body?.message || "").trim() || null;
  const offer_id = body?.offer_id ? String(body.offer_id).trim() : null; // <— NEW
  const remote_url = body?.remote_url ? String(body.remote_url).trim() : null; // optional: keep URL in sync

  console.log("[fb.callback] parsed →", { item_id, status, message, offer_id, remote_url });
  

  if (!item_id || !["live", "error"].includes(status)) {
    console.warn("[fb.callback] bad payload — skipping DB write");
    return new Response(JSON.stringify({ ok: false, error: "bad_payload" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const marketplace_id = 2; // Facebook

  try {
    console.log("[fb.callback] updating DB →", { item_id, marketplace_id, status });
    // 1) Update the existing stub row created earlier (status: 'publishing')
    const result = await sql`
      UPDATE app.item_marketplace_listing
         SET status = ${status},
             last_error = ${message},
             updated_at = NOW()
       WHERE item_id = ${item_id}
         AND marketplace_id = ${marketplace_id};
    `;
    
    // 2) If nothing was updated, report clearly (we won't INSERT in the temp flow)
    const updated = Array.isArray(result) ? result[0]?.rowCount ?? 0 : (result?.rowCount ?? 0);
    if (!updated) {
      console.warn("[fb.callback] no row updated — missing stub? item_id:", item_id, "mp:", marketplace_id);
      return new Response(JSON.stringify({ ok: false, error: "missing_stub_row" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    }
    
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
    console.log("[fb.callback] DB write complete ✅");
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const msg = (err && (err.message || err.toString())) || "unknown";
    console.error("[fb.callback] DB error ❌", msg);
    return new Response(JSON.stringify({ ok: false, error: "db_error", detail: msg }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};
