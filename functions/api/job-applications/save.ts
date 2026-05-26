import { neon } from '@neondatabase/serverless';
import { requireSessionActor } from '../../_shared/auth';

const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const auth = await requireSessionActor(request, env, json);
    if ('error' in auth) return auth.error;
    const tenant_id = request.headers.get('x-tenant-id');
    if (!tenant_id) return json({ ok: false, error: 'missing_tenant' }, 400);

    const body = await request.json<any>();
    const first_name = String(body?.first_name || '').trim();
    const last_name = String(body?.last_name || '').trim();
    if (!first_name || !last_name) return json({ ok: false, error: 'first_name_and_last_name_required' }, 400);

    const sql = neon(String(env.DATABASE_URL));
    const inserted = await sql/*sql*/`
      INSERT INTO app.job_applications (
        tenant_id, first_name, middle_name, last_name, email, mobile_phone, home_phone,
        position_sought, available_start_date, desired_pay_amount, desired_pay_period,
        address_line1, city, state_province, postal_code,
        proficiency_skills_notes, currently_employed, status
      ) VALUES (
        ${tenant_id}::uuid, ${first_name}, ${String(body?.middle_name || '').trim() || null}, ${last_name},
        ${String(body?.email || '').trim() || null}, ${String(body?.mobile_phone || '').trim() || null}, ${String(body?.home_phone || '').trim() || null},
        ${String(body?.position_sought || '').trim() || null}, ${body?.available_start_date || null}, ${body?.desired_pay_amount || null}, ${String(body?.desired_pay_period || '').trim() || null},
        ${String(body?.address_line1 || '').trim() || null}, ${String(body?.city || '').trim() || null}, ${String(body?.state_province || '').trim() || null}, ${String(body?.postal_code || '').trim() || null},
        ${String(body?.proficiency_skills_notes || '').trim() || null}, ${typeof body?.currently_employed === 'boolean' ? body.currently_employed : null},
        ${['draft', 'submitted', 'reviewing', 'hired', 'rejected'].includes(String(body?.status || '')) ? String(body.status) : 'draft'}
      )
      RETURNING job_application_id
    `;

    return json({ ok: true, job_application_id: inserted?.[0]?.job_application_id });
  } catch (e: any) {
    return json({ ok: false, error: 'server_error', message: e?.message || String(e) }, 500);
  }
};
