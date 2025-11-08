// functions/api/marketplaces/facebook/callback.ts
import { neon } from "@neondatabase/serverless";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      // Lightweight CORS so Tampermonkey on facebook.com can POST here
      "access-control-allow-origin": "*",
    },
  });

export const onRequestOptions: PagesFunction = async () =>
  json({}, 204);

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const body = await request.json().catch(() => ({}));
    const tenant_id   = String(body?.tenant_id || "").trim();
    const item_id     = String(body?.item_id || "").trim();
    const statusIn    = String(body?.status || "").trim().toLowerCase(); // 'live' | 'error'
    const remote_url  = (body?.remote_url ? String(body.remote_url) : null);
    const error_msg   = (body?.message ? String(body.message).slice(0, 500) : null);

    if (!tenant_id || !item_id || !statusIn || !["live","error"].includes(statusIn)) {
      return json({ ok:false, error:"bad_payload" }, 400);
    }

    const sql = neon(String(env.DATABASE_URL));

    // Resolve Facebook marketplace id once (mirrors the eBay pattern used elsewhere)
    const mprow = await sql<{ id:number }[]>`
      SELECT id FROM app.marketplaces_available
      WHERE slug = 'facebook' LIMIT 1
    `;
    const FACEBOOK_ID = mprow[0]?.id ?? null;
    console.log("[fb.callback] resolved_marketplace_id", { FACEBOOK_ID });
    if (!FACEBOOK_ID) return json({ ok:false, error:"facebook_marketplace_missing" }, 500);

    // Upsert the listing row and set status
    if (statusIn === "live") {
      const res = await sql/*sql*/`
        INSERT INTO app.item_marketplace_listing
          (tenant_id, item_id, marketplace_id, status, mp_item_url, last_error, last_synced_at, updated_at, published_at)
        VALUES
          (${tenant_id}, ${item_id}, ${FACEBOOK_ID}, 'live', ${remote_url}, NULL, now(), now(), now())
        ON CONFLICT (item_id, marketplace_id) DO UPDATE
          SET status='live',
              mp_item_url = COALESCE(${remote_url}, app.item_marketplace_listing.mp_item_url),
              last_error = NULL,
              last_synced_at = now(),
              updated_at = now(),
              published_at = COALESCE(app.item_marketplace_listing.published_at, now())
      `;
      console.log("[fb.callback] upsert_live_done", { affected: Array.isArray(res) ? res.length : undefined });
      await sql/*sql*/`
        INSERT INTO app.item_marketplace_events
          (item_id, tenant_id, marketplace_id, kind, payload)
        VALUES (${item_id}, ${tenant_id}, ${FACEBOOK_ID}, 'live_snapshot',
                ${JSON.stringify({ via:"tampermonkey", remoteUrl: remote_url || null, at: new Date().toISOString() })})
      `;
      return json({ ok:true, state:"live" });
    }


    // error case
    await sql/*sql*/`
      INSERT INTO app.item_marketplace_listing
        (tenant_id, item_id, marketplace_id, status, last_error, updated_at)
      VALUES
        (${tenant_id}, ${item_id}, ${FACEBOOK_ID}, 'error', ${error_msg}, now())
      ON CONFLICT (item_id, marketplace_id) DO UPDATE
        SET status='error', last_error=${error_msg}, updated_at=now()
    `;
    await sql/*sql*/`
      INSERT INTO app.item_marketplace_events
        (item_id, tenant_id, marketplace_id, kind, error_message)
      VALUES (${item_id}, ${tenant_id}, ${FACEBOOK_ID}, 'create_failed', ${error_msg})
    `;
    return json({ ok:true, state:"error" });
  } catch (e:any) {
    return json({ ok:false, error:"callback_crash", message:String(e?.message||e) }, 500);
  }
};
