import { neon } from '@neondatabase/serverless';
import { computeTotalHours, dayBounds, json, makeEntryId, requireTimesheetActor } from './_helpers';

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
      const totalHours = computeTotalHours({ clock_in: nowIso, clock_out: null, lunch_out: null, lunch_in: null });
      await sql/*sql*/`
        INSERT INTO app.time_entries (
          entry_id, user_name, login_id, clock_in, total_hours, status, updated_at, notes
        ) VALUES (
          ${entry_id}, ${actor.name}, ${actor.login_id}, ${nowIso}, ${totalHours}, ${'open'}, ${nowIso}, ${null}
        )
      `;
    } else if (action === 'lunch_out') {
      if (existing.lunch_out) return json({ ok: false, error: 'already_punched' }, 400);
      const totalHours = computeTotalHours({
        clock_in: existing.clock_in,
        lunch_out: nowIso,
        lunch_in: existing.lunch_in,
        clock_out: existing.clock_out,
      });
      await sql/*sql*/`
        UPDATE app.time_entries
        SET lunch_out = ${nowIso}, total_hours = ${totalHours}, status = ${'open'}, updated_at = ${nowIso}
        WHERE entry_id = ${existing.entry_id}
      `;
    } else if (action === 'lunch_in') {
      if (!existing.lunch_out) return json({ ok: false, error: 'lunch_out_required' }, 400);
      if (existing.lunch_in) return json({ ok: false, error: 'already_punched' }, 400);
      const totalHours = computeTotalHours({
        clock_in: existing.clock_in,
        lunch_out: existing.lunch_out,
        lunch_in: nowIso,
        clock_out: existing.clock_out,
      });
      await sql/*sql*/`
        UPDATE app.time_entries
        SET lunch_in = ${nowIso}, total_hours = ${totalHours}, status = ${'open'}, updated_at = ${nowIso}
        WHERE entry_id = ${existing.entry_id}
      `;
    } else if (action === 'clock_out') {
      if (existing.clock_out) return json({ ok: false, error: 'already_punched' }, 400);
      const totalHours = computeTotalHours({
        clock_in: existing.clock_in,
        lunch_out: existing.lunch_out,
        lunch_in: existing.lunch_in,
        clock_out: nowIso,
      });
      await sql/*sql*/`
        UPDATE app.time_entries
        SET clock_out = ${nowIso}, total_hours = ${totalHours}, status = ${'complete'}, updated_at = ${nowIso}
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
