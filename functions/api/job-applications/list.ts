import { neon } from '@neondatabase/serverless';
import { canManageTenantSettings, getTenantActor, requireSessionActor } from '../../_shared/auth';

const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const auth = await requireSessionActor(request, env, json);
    if ('error' in auth) return auth.error;
    const tenant_id = request.headers.get('x-tenant-id');
    if (!tenant_id) return json({ ok: false, error: 'missing_tenant' }, 400);

    const sql = neon(String(env.DATABASE_URL));
    const actor = await getTenantActor(sql, tenant_id, auth.actor_user_id);
    if (!actor?.active) return json({ ok: false, error: 'forbidden' }, 403);

    const reviewAccess = canManageTenantSettings(actor);
    const limit = reviewAccess ? 200 : 25;

    const rows = await sql/*sql*/`
      SELECT job_application_id, application_date, first_name, last_name, email, mobile_phone, position_sought, status, created_at
      FROM app.job_applications
      WHERE tenant_id = ${tenant_id}::uuid
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    return json({ ok: true, can_review: reviewAccess, items: rows });
  } catch (e: any) {
    return json({ ok: false, error: 'server_error', message: e?.message || String(e) }, 500);
  }
};
