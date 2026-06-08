import { neon } from '@neondatabase/serverless';
import {
  computeTotalHours,
  json,
  localDayBounds,
  makeEntryId,
  requireTimesheetActor,
  toIsoOrNull,
  tzOffsetMinutesFromRequest,
} from './_helpers';

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const sql = neon(String(env.DATABASE_URL));
    const auth = await requireTimesheetActor(request, env, sql);
    if ('error' in auth) return auth.error;
    const { actor } = auth;

    if (!actor.can_edit_timesheet) return json({ ok: false, error: 'edit_denied' }, 403);

    const body = await request.json().catch(() => ({}));
    const loginId = String(body?.login_id || '').trim();
    const entryDate = String(body?.date || '').trim();
    if (!loginId) return json({ ok: false, error: 'login_id_required' }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate) || !isCalendarDate(entryDate)) {
      return json({ ok: false, error: 'date_required' }, 400);
    }

    const tzOffsetMinutes = tzOffsetMinutesFromRequest(request);
    const entryBounds = localDayBounds(tzOffsetMinutes, entryDate);
    const today = localDayBounds(tzOffsetMinutes);
    if (entryBounds.date >= today.date) return json({ ok: false, error: 'past_date_required' }, 400);

    const clock_in = toIsoOrNull(body?.clock_in);
    const lunch_out = toIsoOrNull(body?.lunch_out);
    const lunch_in = toIsoOrNull(body?.lunch_in);
    const clock_out = toIsoOrNull(body?.clock_out);
    if (!clock_in) return json({ ok: false, error: 'clock_in_required' }, 400);

    const punches = [clock_in, lunch_out, lunch_in, clock_out].filter(Boolean) as string[];
    if (punches.some((value) => value < entryBounds.startIso || value > entryBounds.endIso)) {
      return json({ ok: false, error: 'punch_date_mismatch' }, 400);
    }
    if ((lunch_out && !lunch_in) || (!lunch_out && lunch_in)) {
      return json({ ok: false, error: 'complete_lunch_required' }, 400);
    }
    if (punches.some((value, index) => index > 0 && value <= punches[index - 1])) {
      return json({ ok: false, error: 'invalid_punch_order' }, 400);
    }

    const users = await sql/*sql*/`
      SELECT u.login_id, u.name
      FROM app.memberships m
      JOIN app.users u ON u.user_id = m.user_id
      WHERE m.tenant_id = ${actor.tenant_id}
        AND u.login_id = ${loginId}
        AND COALESCE(m.active, true) = true
        AND COALESCE(u.is_active, true) = true
      LIMIT 1
    `;
    if (!users.length) return json({ ok: false, error: 'employee_not_found' }, 404);

    const totalHours = computeTotalHours({ clock_in, lunch_out, lunch_in, clock_out });
    const status = clock_out ? 'complete' : 'open';
    const nowIso = new Date().toISOString();
    const entryId = makeEntryId();
    const notes = body?.notes == null ? null : String(body.notes).trim() || null;

    const rows = await sql/*sql*/`
      INSERT INTO app.time_entries (
        entry_id, user_name, login_id, clock_in, lunch_out, lunch_in, clock_out,
        total_hours, notes, status, edited_by, edited_at, updated_at
      ) VALUES (
        ${entryId}, ${users[0].name}, ${users[0].login_id}, ${clock_in}, ${lunch_out}, ${lunch_in}, ${clock_out},
        ${totalHours}, ${notes}, ${status}, ${actor.login_id}, ${nowIso}, ${nowIso}
      )
      RETURNING *
    `;

    return json({ ok: true, entry: rows[0] || null }, 201);
  } catch (e: any) {
    return json({ ok: false, error: 'server_error', message: e?.message || String(e) }, 500);
  }
};

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}
