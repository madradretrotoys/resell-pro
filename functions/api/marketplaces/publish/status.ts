// functions/api/marketplaces/publish/status.ts
import { neon } from "@neondatabase/serverless";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const url = new URL(request.url);
    const job_id = url.searchParams.get("job_id");
    if (!job_id) return json({ ok: false, error: "invalid_job_id" }, 400);

    const sql = neon(String(env.DATABASE_URL));

    const jobs = await sql/*sql*/`
      SELECT job_id, item_id, marketplace_id, status, last_error
      FROM app.marketplace_publish_jobs
      WHERE job_id = ${job_id}
      LIMIT 1
    `;
    if (jobs.length === 0) return json({ ok: false, error: "job_not_found" }, 404);

    const j = jobs[0];

    // Enrich with current listing status/url when available
    const listing = await sql/*sql*/`
      SELECT status, mp_offer_id, mp_item_url, published_at
      FROM app.item_marketplace_listing
      WHERE item_id = ${j.item_id} AND marketplace_id = ${j.marketplace_id}
      LIMIT 1
    `;

    return json({
      ok: true,
      status: String(j.status || "").toLowerCase(),
      error: j.last_error || null,
      remote: listing[0]?.mp_item_url ? { remoteUrl: listing[0].mp_item_url } : null,
      mp_item_url: listing[0]?.mp_item_url || null,
      listing_status: listing[0]?.status || null,
      published_at: listing[0]?.published_at || null
    });
  } catch (e) {
    return json({ ok: false, error: "server_error" }, 500);
  }
};
