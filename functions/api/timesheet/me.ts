import { neon } from '@neondatabase/serverless';
import { dayBounds, json, requireTimesheetActor } from './_helpers';

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const sql = neon(String(env.DATABASE_URL));
    const auth = await requireTimesheetActor(request, env, sql);
    if ('error' in auth) return auth.error;

    const { actor, } = auth;
    const today = dayBounds();

    const todayRows = await sql/*sql*/`
      SELECT *
      FROM app.time_entries
      WHERE login_id = ${actor.login_id}
        AND clock_in >= ${today.startIso}
        AND clock_in <= ${today.endIso}
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1
    `;

    const periodStart = new Date(today.startIso);
    periodStart.setUTCDate(periodStart.getUTCDate() - 13);
    const periodStartIso = periodStart.toISOString();

    const periodRows = await sql/*sql*/`
      SELECT *
      FROM app.time_entries
      WHERE login_id = ${actor.login_id}
        AND clock_in >= ${periodStartIso}
        AND clock_in <= ${today.endIso}
      ORDER BY clock_in DESC NULLS LAST
      LIMIT 30
    `;

    return json({
      ok: true,
      actor,
      today: todayRows[0] || null,
      period_entries: periodRows,
    });
  } catch (e: any) {
    return json({ ok: false, error: 'server_error', message: e?.message || String(e) }, 500);
  }
};
