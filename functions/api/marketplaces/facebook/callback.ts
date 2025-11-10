import { neon } from "@neondatabase/serverless";

export const onRequestPost = async ({ request, env }) => {
  const sql = neon(env.DATABASE_URL);
  const body = await request.json().catch(() => ({}));

  console.log("[fb.callback] raw body →", body);

  const item_id = String(body?.item_id || "").trim();
  const status  = String(body?.status || "").trim().toLowerCase();
  const message = String(body?.message || "").trim() || null;

  console.log("[fb.callback] parsed →", { item_id, status, message });

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
    await sql`
      INSERT INTO app.item_marketplace_listing (item_id, marketplace_id, status, last_error, updated_at)
      VALUES (${item_id}, ${marketplace_id}, ${status}, ${message}, NOW())
      ON CONFLICT (item_id, marketplace_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        last_error = EXCLUDED.last_error,
        updated_at = NOW();
    `;
    console.log("[fb.callback] DB write complete ✅");
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("[fb.callback] DB error ❌", err);
    return new Response(JSON.stringify({ ok: false, error: "db_error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};
