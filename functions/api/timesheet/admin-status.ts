import { neon } from '@neondatabase/serverless';
import { json, localDayBounds, requireTimesheetActor, tzOffsetMinutesFromRequest } from './_helpers';

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const sql = neon(String(env.DATABASE_URL));
    const auth = await requireTimesheetActor(request, env, sql);
    if ('error' in auth) return auth.error;
    const { actor } = auth;

    if (!actor.can_edit_timesheet) return json({ ok: false, error: 'edit_denied' }, 403);

    const tzOffsetMinutes = tzOffsetMinutesFromRequest(request);
    const today = localDayBounds(tzOffsetMinutes);

    const rows = await sql/*sql*/`
      WITH tenant_users AS (
        SELECT u.user_id, u.name, u.login_id
        FROM app.memberships m
        JOIN app.users u ON u.user_id = m.user_id
        JOIN app.permissions p ON p.user_id = m.user_id
        WHERE m.tenant_id = ${actor.tenant_id}
          AND m.active = true
          AND u.is_active IS TRUE
          AND COALESCE(p.clockin_required, false) = true
      ),
      latest_today AS (
        SELECT DISTINCT ON (te.login_id)
          te.login_id,
          te.clock_in,
          te.lunch_out,
          te.lunch_in,
          te.clock_out,
          te.status,
          te.updated_at
        FROM app.time_entries te
        WHERE te.clock_in >= ${today.startIso}
          AND te.clock_in <= ${today.endIso}
        ORDER BY te.login_id, te.updated_at DESC NULLS LAST
      ),
      latest_clock_out AS (
        SELECT DISTINCT ON (te.login_id)
          te.login_id,
          te.clock_out
        FROM app.time_entries te
        WHERE te.clock_out IS NOT NULL
        ORDER BY te.login_id, te.clock_out DESC
      )
      SELECT
        tu.name AS user_name,
        tu.login_id,
        lt.clock_in,
        lt.lunch_out,
        lt.lunch_in,
        lt.clock_out,
        lt.status,
        lco.clock_out AS last_clock_out
      FROM tenant_users tu
      LEFT JOIN latest_today lt ON lt.login_id = tu.login_id
      LEFT JOIN latest_clock_out lco ON lco.login_id = tu.login_id
      ORDER BY lower(tu.name), tu.login_id
    `;

    const statuses = rows.map((r: any) => ({
      ...r,
      status_label: toStatusLabel(r),
    }));

    return json({ ok: true, date: today.date, statuses });
  } catch (e: any) {
    return json({ ok: false, error: 'server_error', message: e?.message || String(e) }, 500);
  }
};

function toStatusLabel(entry: {
  clock_in?: string | null;
  lunch_out?: string | null;
  lunch_in?: string | null;
  clock_out?: string | null;
}) {
  if (!entry?.clock_in) return 'Not clocked in';
  if (entry.clock_out) return 'Clocked out for day';
  if (entry.lunch_out && !entry.lunch_in) return 'Out to lunch';
  if (entry.lunch_in) return 'Clocked in from lunch';
  return 'Clocked in';
}
