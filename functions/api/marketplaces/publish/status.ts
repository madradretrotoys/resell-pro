import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '@/lib/db'; // adjust import to your db helper
import { ensureSession } from '@/lib/auth'; // if you gate APIs
import { json } from 'hono/utils/json'; // optional helper

const app = new Hono();

const Q = z.object({
  job_id: z.string().uuid()
});

app.get(async (c) => {
  await ensureSession(c); // optional but recommended
  const parse = Q.safeParse({ job_id: c.req.query('job_id') || '' });
  if (!parse.success) return c.json({ ok: false, error: 'invalid_job_id' }, 400);
  const { job_id } = parse.data;

  // Read only — do NOT execute anything here.
  const job = await db.oneOrNone(`
    select job_id, tenant_id, item_id, marketplace_id, op, status, last_error,
           payload_snapshot, updated_at
      from app.marketplace_publish_jobs
     where job_id = $1
  `, [job_id]);

  if (!job) return c.json({ ok: false, error: 'job_not_found' }, 404);

  // Try to enrich with live URL/status if available
  const listing = await db.oneOrNone(`
    select mp_item_url, status, mp_offer_id, published_at
      from app.item_marketplace_listing
     where item_id = $1 and marketplace_id = $2
     limit 1
  `, [job.item_id, job.marketplace_id]);

  return c.json({
    ok: true,
    status: String(job.status || '').toLowerCase(),
    error: job.last_error || null,
    remote: listing?.mp_item_url ? { remoteUrl: listing.mp_item_url } : null,
    mp_item_url: listing?.mp_item_url || null,
    listing_status: listing?.status || null,
    published_at: listing?.published_at || null
  });
});

export default app;
