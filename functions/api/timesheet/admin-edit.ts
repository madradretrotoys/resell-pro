import { neon } from '@neondatabase/serverless';
import { computeTotalHours, json, requireTimesheetActor, toIsoOrNull } from './_helpers';

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
    const clock_in = toIsoOrNull(body?.clock_in);
    const lunch_out = toIsoOrNull(body?.lunch_out);
    const lunch_in = toIsoOrNull(body?.lunch_in);
    const clock_out = toIsoOrNull(body?.clock_out);
    const total_hours = computeTotalHours({ clock_in, lunch_out, lunch_in, clock_out });

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

    const nowIso = new Date().toISOString();
    await sql/*sql*/`
      UPDATE app.time_entries
      SET
        clock_in = ${clock_in},
        lunch_out = ${lunch_out},
        lunch_in = ${lunch_in},
        clock_out = ${clock_out},
        total_hours = ${total_hours},
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
