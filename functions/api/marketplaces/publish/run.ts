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

  // 4) perform op
  const res = await adapter.create({
    env,
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

    await sql/*sql*/`
      INSERT INTO app.item_marketplace_events
        (item_id, tenant_id, marketplace_id, kind, error_message)
      VALUES (${job.item_id}, ${job.tenant_id}, ${job.marketplace_id}, 'create_failed', ${msg})
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

    // If a specific job_id is provided, lock THAT job; otherwise pick the next queued one.
    const [job] = specific
      ? await sql/*sql*/`
          UPDATE app.marketplace_publish_jobs j
             SET status   = 'running',
                 locked_at = now(),
                 locked_by = 'api/marketplaces/publish/run'
           WHERE j.job_id = ${specific}
             AND j.status = 'queued'
           RETURNING j.*
        `
      : await sql/*sql*/`
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



