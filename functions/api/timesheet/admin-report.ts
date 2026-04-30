import { neon } from '@neondatabase/serverless';
import { json, localDayBounds, requireTimesheetActor, tzOffsetMinutesFromRequest } from './_helpers';

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const sql = neon(String(env.DATABASE_URL));
    const auth = await requireTimesheetActor(request, env, sql);
    if ('error' in auth) return auth.error;
    const { actor } = auth;

    if (!actor.can_edit_timesheet) return json({ ok: false, error: 'edit_denied' }, 403);

    const url = new URL(request.url);
    const from = (url.searchParams.get('from') || '').trim();
    const to = (url.searchParams.get('to') || '').trim();
    const loginId = (url.searchParams.get('login_id') || '').trim();
    const tzOffsetMinutes = tzOffsetMinutesFromRequest(request);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
      return json({ ok: false, error: 'bad_range' }, 400);
    }

    const fromBounds = localDayBounds(tzOffsetMinutes, from);
    const toBounds = localDayBounds(tzOffsetMinutes, to);

    const rows = await sql/*sql*/`
      SELECT te.*
      FROM app.time_entries te
      JOIN app.users u ON u.login_id = te.login_id
      JOIN app.memberships m ON m.user_id = u.user_id
      WHERE m.tenant_id = ${actor.tenant_id}
        AND te.clock_in >= ${fromBounds.startIso}
        AND te.clock_in <= ${toBounds.endIso}
        AND (${loginId} = '' OR te.login_id = ${loginId})
      ORDER BY COALESCE(te.user_name, te.login_id), te.clock_in DESC
    `;

    const users = await sql/*sql*/`
      SELECT DISTINCT u.login_id, u.name
      FROM app.memberships m
      JOIN app.users u ON u.user_id = m.user_id
      WHERE m.tenant_id = ${actor.tenant_id}
      ORDER BY u.name, u.login_id
    `;

    const totalHours = rows.reduce((sum: number, row: any) => sum + Number(row.total_hours || 0), 0);
    return json({ ok: true, entries: rows, users, total_hours: Math.round(totalHours * 100) / 100 });
  } catch (e: any) {
    return json({ ok: false, error: 'server_error', message: e?.message || String(e) }, 500);
  }
};
