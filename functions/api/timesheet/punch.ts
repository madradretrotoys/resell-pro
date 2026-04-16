import { neon } from '@neondatabase/serverless';
import { calcTotalHours, dayBounds, json, makeEntryId, requireTimesheetActor } from './_helpers';
import { dayBounds, json, makeEntryId, requireTimesheetActor } from './_helpers';

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const sql = neon(String(env.DATABASE_URL));
    const auth = await requireTimesheetActor(request, env, sql);
    if ('error' in auth) return auth.error;
    const { actor } = auth;

    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || '').trim();
    if (!['clock_in', 'lunch_out', 'lunch_in', 'clock_out'].includes(action)) {
      return json({ ok: false, error: 'invalid_action' }, 400);
    }

    const nowIso = new Date().toISOString();
    const today = dayBounds();

    const existingRows = await sql/*sql*/`
      SELECT *
      FROM app.time_entries
      WHERE login_id = ${actor.login_id}
        AND clock_in >= ${today.startIso}
        AND clock_in <= ${today.endIso}
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1
    `;

    const existing = existingRows[0] || null;

    if (!existing && action !== 'clock_in') return json({ ok: false, error: 'clock_in_required' }, 400);

    if (!existing && action === 'clock_in') {
      const entry_id = makeEntryId();
      await sql/*sql*/`
        INSERT INTO app.time_entries (
          entry_id, user_name, login_id, clock_in, status, total_hours, updated_at, notes
        ) VALUES (
          ${entry_id}, ${actor.name}, ${actor.login_id}, ${nowIso}, ${'open'}, ${null}, ${nowIso}, ${null}
          entry_id, user_name, login_id, clock_in, status, updated_at, notes
        ) VALUES (
          ${entry_id}, ${actor.name}, ${actor.login_id}, ${nowIso}, ${'open'}, ${nowIso}, ${null}
        )
      `;
    } else if (action === 'lunch_out') {
      if (existing.lunch_out) return json({ ok: false, error: 'already_punched' }, 400);
      await sql/*sql*/`
        UPDATE app.time_entries
        SET lunch_out = ${nowIso}, status = ${'open'}, total_hours = ${null}, updated_at = ${nowIso}
        SET lunch_out = ${nowIso}, status = ${'open'}, updated_at = ${nowIso}
        WHERE entry_id = ${existing.entry_id}
      `;
    } else if (action === 'lunch_in') {
      if (!existing.lunch_out) return json({ ok: false, error: 'lunch_out_required' }, 400);
      if (existing.lunch_in) return json({ ok: false, error: 'already_punched' }, 400);
      await sql/*sql*/`
        UPDATE app.time_entries
        SET lunch_in = ${nowIso}, status = ${'open'}, total_hours = ${null}, updated_at = ${nowIso}
        SET lunch_in = ${nowIso}, status = ${'open'}, updated_at = ${nowIso}
        WHERE entry_id = ${existing.entry_id}
      `;
    } else if (action === 'clock_out') {
      if (existing.clock_out) return json({ ok: false, error: 'already_punched' }, 400);
      const totalHours = calcTotalHours(existing.clock_in, existing.lunch_out, existing.lunch_in, nowIso);
      await sql/*sql*/`
        UPDATE app.time_entries
        SET clock_out = ${nowIso}, status = ${'complete'}, total_hours = ${totalHours}, updated_at = ${nowIso}
      await sql/*sql*/`
        UPDATE app.time_entries
        SET clock_out = ${nowIso}, status = ${'complete'}, updated_at = ${nowIso}
        WHERE entry_id = ${existing.entry_id}
      `;
    }

    const row = await sql/*sql*/`
      SELECT * FROM app.time_entries
      WHERE login_id = ${actor.login_id}
        AND clock_in >= ${today.startIso}
        AND clock_in <= ${today.endIso}
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1
    `;

    return json({ ok: true, entry: row[0] || null });
  } catch (e: any) {
    return json({ ok: false, error: 'server_error', message: e?.message || String(e) }, 500);
  }
};
