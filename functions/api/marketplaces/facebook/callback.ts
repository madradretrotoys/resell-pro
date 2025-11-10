// /functions/api/marketplaces/facebook/callback.ts
import { neon } from "@neondatabase/serverless";
import { json } from "itty-router-extras";

export const onRequestPost = async ({ request, env }) => {
  const sql = neon(env.DATABASE_URL);
  const body = await request.json().catch(() => ({}));

  const item_id = String(body?.item_id || "").trim();
  const status  = String(body?.status || "").trim().toLowerCase(); // 'live' or 'error'
  const message = String(body?.message || "").trim() || null;

  if (!item_id || !["live", "error"].includes(status)) {
    return json({ ok: false, error: "bad_payload" }, 400);
  }

  // Hardcode Facebook marketplace_id (usually 2)
  const marketplace_id = 2;

  try {
    await sql`
      INSERT INTO app.item_marketplace_listing (item_id, marketplace_id, status, last_error, updated_at)
      VALUES (${item_id}, ${marketplace_id}, ${status}, ${message}, NOW())
      ON CONFLICT (item_id, marketplace_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        last_error = EXCLUDED.last_error,
        updated_at = NOW();
    `;

    return json({ ok: true });
  } catch (err) {
    console.error("FB callback update failed", err);
    return json({ ok: false, error: "db_error" }, 500);
  }
};
