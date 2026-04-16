import { neon } from '@neondatabase/serverless';
import { calcTotalHours, json, requireTimesheetActor, toIsoOrNull } from './_helpers';

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const sql = neon(String(env.DATABASE_URL));
    const auth = await requireTimesheetActor(request, env, sql);
    if ('error' in auth) return auth.error;
    const { actor } = auth;

    if (!actor.can_edit_timesheet) return json({ ok: false, error: 'edit_denied' }, 403);

    const body = await request.json().catch(() => ({}));
    const entry_id = String(body?.entry_id || '').trim();
    if (!entry_id) return json({ ok: false, error: 'entry_id_required' }, 400);

    const rows = await sql/*sql*/`
      SELECT te.entry_id
      FROM app.time_entries te
      JOIN app.users u ON u.login_id = te.login_id
      JOIN app.memberships m ON m.user_id = u.user_id
      WHERE m.tenant_id = ${actor.tenant_id}
        AND te.entry_id = ${entry_id}
      LIMIT 1
    `;
    if (!rows.length) return json({ ok: false, error: 'entry_not_found' }, 404);

    const clockIn = toIsoOrNull(body?.clock_in);
    const lunchOut = toIsoOrNull(body?.lunch_out);
    const lunchIn = toIsoOrNull(body?.lunch_in);
    const clockOut = toIsoOrNull(body?.clock_out);
    const totalHours = calcTotalHours(clockIn, lunchOut, lunchIn, clockOut);

    const nowIso = new Date().toISOString();
    await sql/*sql*/`
      UPDATE app.time_entries
      SET
        clock_in = ${clockIn},
        lunch_out = ${lunchOut},
        lunch_in = ${lunchIn},
        clock_out = ${clockOut},
        total_hours = ${totalHours},
        notes = ${body?.notes == null ? null : String(body.notes)},
        status = ${body?.status == null ? null : String(body.status)},
        edited_by = ${actor.login_id},
        edited_at = ${nowIso},
        updated_at = ${nowIso}
      WHERE entry_id = ${entry_id}
    `;

    return json({ ok: true });
  } catch (e: any) {
    return json({ ok: false, error: 'server_error', message: e?.message || String(e) }, 500);
  }
};
