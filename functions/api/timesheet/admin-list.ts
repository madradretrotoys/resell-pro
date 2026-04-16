import { neon } from '@neondatabase/serverless';
import { dayBounds, json, requireTimesheetActor } from './_helpers';

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const sql = neon(String(env.DATABASE_URL));
    const auth = await requireTimesheetActor(request, env, sql);
    if ('error' in auth) return auth.error;
    const { actor } = auth;

    if (!actor.can_edit_timesheet) return json({ ok: false, error: 'edit_denied' }, 403);

    const url = new URL(request.url);
    const date = url.searchParams.get('date') || undefined;
    const bounds = dayBounds(date);

    const rows = await sql/*sql*/`
      SELECT te.*
      FROM app.time_entries te
      JOIN app.users u ON u.login_id = te.login_id
      JOIN app.memberships m ON m.user_id = u.user_id
      WHERE m.tenant_id = ${actor.tenant_id}
        AND te.clock_in >= ${bounds.startIso}
        AND te.clock_in <= ${bounds.endIso}
      ORDER BY COALESCE(te.user_name, te.login_id), te.clock_in
    `;

    return json({ ok: true, date: bounds.date, entries: rows });
  } catch (e: any) {
    return json({ ok: false, error: 'server_error', message: e?.message || String(e) }, 500);
  }
};
