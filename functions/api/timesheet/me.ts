import { neon } from '@neondatabase/serverless';
import { json, localDayBounds, requireTimesheetActor, tzOffsetMinutesFromRequest } from './_helpers';

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const sql = neon(String(env.DATABASE_URL));
    const auth = await requireTimesheetActor(request, env, sql);
    if ('error' in auth) return auth.error;

    const { actor, } = auth;
    const url = new URL(request.url);
    const tzOffsetMinutes = tzOffsetMinutesFromRequest(request);
    const today = localDayBounds(tzOffsetMinutes);

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

    const from = (url.searchParams.get('from') || '').trim();
    const to = (url.searchParams.get('to') || '').trim();

    let range_entries: any[] = [];
    let range_total_hours = 0;
    if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to) {
      const fromBounds = localDayBounds(tzOffsetMinutes, from);
      const toBounds = localDayBounds(tzOffsetMinutes, to);
      const rangeRows = await sql/*sql*/`
        SELECT *
        FROM app.time_entries
        WHERE login_id = ${actor.login_id}
          AND clock_in >= ${fromBounds.startIso}
          AND clock_in <= ${toBounds.endIso}
        ORDER BY clock_in DESC NULLS LAST
      `;
      range_entries = rangeRows;
      range_total_hours = rangeRows.reduce((sum, row: any) => sum + Number(row.total_hours || 0), 0);
    }

    return json({
      ok: true,
      actor,
      today: todayRows[0] || null,
      period_entries: periodRows,
      range_entries,
      range_total_hours: Math.round(range_total_hours * 100) / 100,
    });
  } catch (e: any) {
    return json({ ok: false, error: 'server_error', message: e?.message || String(e) }, 500);
  }
};
