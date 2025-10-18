import { json } from 'itty-router-extras';
import { getSql } from '../../_shared/db'; // your existing db helper
import { getRegistry } from '../../lib/marketplaces/adapter-registry';
import type { Env } from '../../_shared/types';

export async function onRequestPost(ctx: { env: Env, request: Request }) {
  const sql = getSql(ctx.env);

  // 1) pick one job
  const [job] = await sql/*sql*/`
    WITH next AS (
      SELECT job_id
      FROM app.marketplace_publish_jobs
      WHERE status = 'queued'
        AND run_at <= now()
      ORDER BY run_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE app.marketplace_publish_jobs j
       SET status = 'running',
           locked_at = now(),
           locked_by = 'api/marketplaces/publish/run'
     WHERE j.job_id IN (SELECT job_id FROM next)
     RETURNING j.*
  `;

  if (!job) return json({ ok: true, taken: 0 });

  try {
    // 2) load inputs for the adapter
    const [inv] = await sql/*sql*/`
      SELECT i.item_id, i.sku, i.product_short_title, i.price, i.qty
      FROM app.inventory i
      WHERE i.item_id = ${job.item_id} AND i.item_id IS NOT NULL
      LIMIT 1
    `;

    const [prof] = await sql/*sql*/`
      SELECT *
      FROM app.item_listing_profile
      WHERE item_id = ${job.item_id} AND tenant_id = ${job.tenant_id}
      LIMIT 1
    `;

    const imlRows = await sql/*sql*/`
      SELECT *
      FROM app.item_marketplace_listing
      WHERE item_id = ${job.item_id} AND tenant_id = ${job.tenant_id}
        AND marketplace_id = ${job.marketplace_id}
      LIMIT 1
    `;

    const imgs = await sql/*sql*/`
      SELECT cdn_url, is_primary, sort_order
      FROM app.item_images
      WHERE item_id = ${job.item_id} AND tenant_id = ${job.tenant_id}
      ORDER BY is_primary DESC, sort_order ASC
    `;

    // 3) resolve adapter
    const reg = getRegistry();
    const adapter = reg.byId(job.marketplace_id);
    if (!adapter) throw new Error(`No adapter for marketplace_id=${job.marketplace_id}`);

    // 4) perform op
    const res = await adapter.create({
      env: ctx.env,
      tenant_id: job.tenant_id,
      item: inv,
      profile: prof,
      mpListing: imlRows?.[0] || null,
      images: imgs
    });

    // 5) success → update listing + event + job
    await sql/*sql*/`
      UPDATE app.item_marketplace_listing
         SET status='listed',
             mp_item_id = ${res.remoteId || null},
             mp_item_url = ${res.remoteUrl || null},
             last_synced_at = now(),
             updated_at = now()
       WHERE item_id = ${job.item_id}
         AND tenant_id = ${job.tenant_id}
         AND marketplace_id = ${job.marketplace_id}
    `;

    await sql/*sql*/`
      INSERT INTO app.item_marketplace_events
        (item_id, tenant_id, marketplace_id, kind, payload)
      VALUES (${job.item_id}, ${job.tenant_id}, ${job.marketplace_id}, 'created', ${JSON.stringify(res).slice(0,500)})
    `;

    await sql/*sql*/`
      UPDATE app.marketplace_publish_jobs
         SET status='succeeded',
             updated_at = now()
       WHERE job_id = ${job.job_id}
    `;

    return json({ ok: true, job_id: job.job_id, status: 'succeeded', remote: res });
  } catch (err: any) {
    const msg = String(err?.message || err).slice(0, 500);

    await sql/*sql*/`
      UPDATE app.marketplace_publish_jobs
         SET status = CASE WHEN attempt_count >= 4 THEN 'dead' ELSE 'failed' END,
             attempt_count = attempt_count + 1,
             last_error = ${msg},
             run_at = now() + (make_interval(secs => 30 * (attempt_count + 1))), -- backoff
             updated_at = now()
       WHERE job_id = ${job.job_id}
    `;

    await sql/*sql*/`
      UPDATE app.item_marketplace_listing
         SET status='error',
             last_error=${msg},
             updated_at=now()
       WHERE item_id = ${job.item_id}
         AND tenant_id = ${job.tenant_id}
         AND marketplace_id = ${job.marketplace_id}
    `;

    await sql/*sql*/`
      INSERT INTO app.item_marketplace_events
        (item_id, tenant_id, marketplace_id, kind, error_message)
      VALUES (${job.item_id}, ${job.tenant_id}, ${job.marketplace_id}, 'create_failed', ${msg})
    `;

    return json({ ok: false, job_id: job.job_id, error: msg });
  }
}
