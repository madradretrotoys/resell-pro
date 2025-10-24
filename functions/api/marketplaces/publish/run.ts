//begin  run.ts code
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
import { getSql } from '../../../_shared/db';
import { getRegistry } from '../../../lib/marketplaces/adapter-registry';
import type { Env } from '../../../_shared/types';

// Execute a specific job that is already locked to 'running'
async function executeLockedJob(env: Env, job: any) {
  const sql = getSql(env);

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
    
    const op = String(job.op || 'create').toLowerCase(); // 'create' | 'update' | 'delete'
    
    // For delete: we only need the listing row (ids) and tenant context
    if (op === 'delete') {
      const [iml] = await sql/*sql*/`
        SELECT *
          FROM app.item_marketplace_listing
         WHERE item_id = ${job.item_id}
           AND tenant_id = ${job.tenant_id}
           AND marketplace_id = ${job.marketplace_id}
         LIMIT 1
      `;
    
      // Soft status while attempting delete
      await sql/*sql*/`
        UPDATE app.item_marketplace_listing
           SET status='deleting',
               updated_at = now()
         WHERE item_id = ${job.item_id}
           AND tenant_id = ${job.tenant_id}
           AND marketplace_id = ${job.marketplace_id}
      `;
    
      // Call adapter.delete when available; tolerate idempotent 404s
      if (typeof (adapter as any).delete !== "function") {
        throw new Error("adapter_missing_delete");
      }
      const res = await (adapter as any).delete({
        env,
        tenant_id: job.tenant_id,
        mpListing: iml || null
      });
    
      // Mark listing deleted and clear remote identifiers (or keep for audit if you prefer)
      await sql/*sql*/`
        UPDATE app.item_marketplace_listing
           SET status='deleted',
               mp_item_id   = NULL,
               mp_item_url  = NULL,
               mp_offer_id  = NULL,
               campaign_id  = NULL,
               last_error   = NULL,
               last_synced_at = now(),
               updated_at     = now()
         WHERE item_id = ${job.item_id}
           AND tenant_id = ${job.tenant_id}
           AND marketplace_id = ${job.marketplace_id}
      `;
    
      await sql/*sql*/`
        INSERT INTO app.item_marketplace_events
          (item_id, tenant_id, marketplace_id, kind, payload)
        VALUES (
          ${job.item_id},
          ${job.tenant_id},
          ${job.marketplace_id},
          'deleted',
          ${JSON.stringify({ at: new Date().toISOString(), remote: { offerId: res?.offerId || null, itemId: res?.remoteId || null } })}
        )
      `;
    
      await sql/*sql*/`
        UPDATE app.marketplace_publish_jobs
           SET status='succeeded',
               updated_at = now()
         WHERE job_id = ${job.job_id}
      `;
      return { ok: true, job_id: job.job_id, status: 'succeeded', remote: undefined };
    }
    
    // Non-delete flow (create/update) stays the same:
    await sql/*sql*/`
      UPDATE app.item_marketplace_listing
         SET status='publishing',
             updated_at = now()
       WHERE item_id = ${job.item_id}
         AND tenant_id = ${job.tenant_id}
         AND marketplace_id = ${job.marketplace_id}
    `;
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
    
    // 4) perform op
    const res = op === 'update' && typeof (adapter as any).update === 'function'
      ? await (adapter as any).update({ env, tenant_id: job.tenant_id, item: inv, profile: prof, mpListing: imlRows?.[0] || null, images: imgs })
      : await adapter.create({ env, tenant_id: job.tenant_id, item: inv, profile: prof, mpListing: imlRows?.[0] || null, images: imgs });

  
    const liveSnapshot = {
      mp_item_id:     res.remoteId || null,
      mp_item_url:    res.remoteUrl || null,
      mp_offer_id:    res.offerId || null,
      mp_category_id: res.categoryId || null,
      connection_id:  res.connectionId || null,
      environment:    res.environment || null,
      published_at:   new Date().toISOString(),
      raw: {
        offer:   res.rawOffer ?? null,
        publish: res.rawPublish ?? null,
        update:  (res as any).rawUpdate ?? null
      },
      warnings: res.warnings ?? []
    };
  
    // Always log a live snapshot
    await sql/*sql*/`
      INSERT INTO app.item_marketplace_events
        (item_id, tenant_id, marketplace_id, kind, payload)
      VALUES (
        ${job.item_id},
        ${job.tenant_id},
        ${job.marketplace_id},
        'live_snapshot',
        ${JSON.stringify(liveSnapshot)}
      )
    `;
  
    // For true edits, also add a concise 'updated' event
    if (op === 'update') {
      await sql/*sql*/`
        INSERT INTO app.item_marketplace_events
          (item_id, tenant_id, marketplace_id, kind, payload)
        VALUES (
          ${job.item_id},
          ${job.tenant_id},
          ${job.marketplace_id},
          'updated',
          ${JSON.stringify({ at: new Date().toISOString(), offerId: res.offerId || null })}
        )
      `;
    }
  
    await sql/*sql*/`
      UPDATE app.marketplace_publish_jobs
         SET status='succeeded',
             updated_at = now()
       WHERE job_id = ${job.job_id}
    `;  
    return { ok: true, job_id: job.job_id, status: 'succeeded', remote: res };
}

// Exported: process a specific queued job by id (used by intake.ts inline mode)
export async function processJobById(env: Env, jobId: string) {
  console.log("[runner] start.processJobById", jobId);

  // 1) Initialize SQL safely
  let sql: ReturnType<typeof getSql>;
  try {
    sql = getSql(env);
  } catch (e: any) {
    const msg = String(e?.message || e);
    console.error("[runner] getSql failed", msg);
    return { ok: false, error: "db_init_failed", message: msg };
  }

  // 2) Lock this job (queued → running) with a hard guard
  let job: any | undefined;
  try {
    const rows = await sql/*sql*/`
      UPDATE app.marketplace_publish_jobs
         SET status = 'running',
             locked_at = now(),
             locked_by = 'intake.inline'
       WHERE job_id = ${jobId}
         AND status = 'queued'
       RETURNING *
    `;
    job = rows?.[0];
  } catch (e: any) {
    const msg = String(e?.message || e);
    console.error("[runner] lock failed", { jobId, msg });
    return { ok: false, error: "lock_failed", message: msg };
  }

  // 3) If not locked, report current state instead of throwing
  if (!job) {
    try {
      const [existing] = await sql/*sql*/`
        SELECT job_id, status, last_error
        FROM app.marketplace_publish_jobs
        WHERE job_id = ${jobId}
        LIMIT 1
      `;
      if (!existing) return { ok: false, error: "job_not_found" as const };
      if (existing.status === "succeeded") return { ok: true, job_id: existing.job_id, status: "succeeded" as const };
      if (existing.status === "running")  return { ok: true, job_id: existing.job_id, status: "running" as const };
      return { ok: false, job_id: existing.job_id, status: existing.status as any, error: existing.last_error || null };
    } catch (e: any) {
      const msg = String(e?.message || e);
      console.error("[runner] state probe failed", { jobId, msg });
      return { ok: false, error: "state_probe_failed", message: msg };
    }
  }

  // 4) Execute the locked job (existing guarded logic)
  try {
    const res = await executeLockedJob(env, job);
    console.log("[runner] exec", { item_id: job.item_id, marketplace_id: job.marketplace_id });
    return res;
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

    const failKind = String(job.op || '').toLowerCase() === 'update' ? 'update_failed' : 'create_failed';
    await sql/*sql*/`
      INSERT INTO app.item_marketplace_events
        (item_id, tenant_id, marketplace_id, kind, error_message)
      VALUES (${job.item_id}, ${job.tenant_id}, ${job.marketplace_id}, ${failKind}, ${msg})
    `;

    return { ok: false, job_id: job.job_id, error: msg };
  }
}




// Public endpoint remains: process the next queued job
export async function onRequestPost(ctx: { env: Env, request: Request }) {
  try {
    const sql = getSql(ctx.env);

    const url = new URL(ctx.request.url);
    const specific = url.searchParams.get("job_id");
    const itemIdParam = url.searchParams.get("item_id");

    // Strict no-op execute when poll=true (compat with older clients)
    try {
      const maybe = await ctx.request.clone().json().catch(() => null);
      if (maybe && maybe.poll === true && specific) {
        const [row] = await sql/*sql*/`
          SELECT status, remote_url AS "remoteUrl", remote_url AS "remoteURL"
          FROM app.marketplace_publish_jobs
          WHERE job_id = ${specific}
          LIMIT 1
        `;
        if (!row) return json({ ok: true, status: "unknown" });
        return json({ ok: true, status: row.status, remote: { remoteUrl: row.remoteUrl, remoteURL: row.remoteURL } });
      }
    } catch { /* ignore */ }

    let job: any | undefined;
    if (specific) {
      [job] = await sql/*sql*/`
        UPDATE app.marketplace_publish_jobs j
           SET status   = 'running',
               locked_at = now(),
               locked_by = 'api/marketplaces/publish/run'
         WHERE j.job_id = ${specific}
           AND j.status = 'queued'
         RETURNING j.*
      `;
    } else if (itemIdParam) {
      [job] = await sql/*sql*/`
        WITH next AS (
          SELECT job_id
          FROM app.marketplace_publish_jobs
          WHERE status  = 'queued'
            AND item_id = ${Number(itemIdParam)}
            AND run_at <= now()
          ORDER BY run_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE app.marketplace_publish_jobs j
           SET status   = 'running',
               locked_at = now(),
               locked_by = 'api/marketplaces/publish/run'
         WHERE j.job_id IN (SELECT job_id FROM next)
         RETURNING j.*
      `;
    } else {
      [job] = await sql/*sql*/`
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
    }

    if (!job) {
      return json({ ok: true, taken: 0 });
    }

    // job is already locked → execute it directly
    const res = await executeLockedJob(ctx.env, job);

    if ((res as any)?.ok) {
      return json({ ok: true, job_id: (res as any).job_id, status: (res as any).status, remote: (res as any).remote });
    }
    return json({ ok: false, job_id: (res as any).job_id, error: (res as any).error, status: (res as any).status }, 502);
  } catch (e: any) {
    const msg = String(e?.message || e);
    console.error("[runner] unhandled", msg);
    return json({ ok: false, error: "runner_crash", message: msg }, 500);
  }
}
//end  run.ts code


