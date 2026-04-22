import { neon } from '@neondatabase/serverless';
import { json, localDayBounds, requireTimesheetActor, tzOffsetMinutesFromRequest } from './_helpers';

function addDaysYmd(ymd: string, days: number) {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function weekStartForDateYmd(dateYmd: string, weekStartsOn: number) {
  const d = new Date(`${dateYmd}T00:00:00.000Z`);
  const dow = d.getUTCDay();
  const delta = (dow - weekStartsOn + 7) % 7;
  return addDaysYmd(dateYmd, -delta);
}

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const sql = neon(String(env.DATABASE_URL));
    const auth = await requireTimesheetActor(request, env, sql);
    if ('error' in auth) return auth.error;

    const { actor, } = auth;
    const url = new URL(request.url);
    const tzOffsetMinutes = tzOffsetMinutesFromRequest(request);
    const today = localDayBounds(tzOffsetMinutes);
    const weekStartColumnRows = await sql/*sql*/`
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'app'
        AND table_name = 'tenant_settings'
        AND column_name = 'week_starts_on'
      LIMIT 1
    `;

    let weekStartsOn = 0;
    if (weekStartColumnRows.length) {
      const weekSettingRows = await sql/*sql*/`
        SELECT week_starts_on
        FROM app.tenant_settings
        WHERE tenant_id = ${actor.tenant_id}::uuid
        LIMIT 1
      `;
      weekStartsOn = Number(weekSettingRows?.[0]?.week_starts_on ?? 0);
    }

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

    const currentWeekStart = weekStartForDateYmd(today.date, weekStartsOn);
    const currentWeekEnd = addDaysYmd(currentWeekStart, 6);
    const currentWeekBounds = {
      startIso: localDayBounds(tzOffsetMinutes, currentWeekStart).startIso,
      endIso: localDayBounds(tzOffsetMinutes, currentWeekEnd).endIso,
    };

    let scheduleRows = await sql/*sql*/`
      SELECT business_date, shift_start_at, shift_end_at, break_minutes, static_schedule
      FROM app.employee_schedules
      WHERE tenant_id = ${actor.tenant_id}::uuid
        AND user_id = ${actor.actor_user_id}::uuid
        AND shift_start_at >= ${currentWeekBounds.startIso}::timestamptz
        AND shift_start_at <= ${currentWeekBounds.endIso}::timestamptz
      ORDER BY shift_start_at ASC
    `;

    let effectiveWeekStart = currentWeekStart;
    if (!scheduleRows.length) {
      const latestStaticRows = await sql/*sql*/`
        SELECT business_date
        FROM app.employee_schedules
        WHERE tenant_id = ${actor.tenant_id}::uuid
          AND user_id = ${actor.actor_user_id}::uuid
          AND static_schedule = true
        ORDER BY business_date DESC NULLS LAST, shift_start_at DESC
        LIMIT 1
      `;
      const latestStaticDate = String(latestStaticRows?.[0]?.business_date || '').slice(0, 10);
      if (latestStaticDate) {
        effectiveWeekStart = weekStartForDateYmd(latestStaticDate, weekStartsOn);
        const staticWeekEnd = addDaysYmd(effectiveWeekStart, 6);
        const staticWeekBounds = {
          startIso: localDayBounds(tzOffsetMinutes, effectiveWeekStart).startIso,
          endIso: localDayBounds(tzOffsetMinutes, staticWeekEnd).endIso,
        };
        scheduleRows = await sql/*sql*/`
          SELECT business_date, shift_start_at, shift_end_at, break_minutes, static_schedule
          FROM app.employee_schedules
          WHERE tenant_id = ${actor.tenant_id}::uuid
            AND user_id = ${actor.actor_user_id}::uuid
            AND static_schedule = true
            AND shift_start_at >= ${staticWeekBounds.startIso}::timestamptz
            AND shift_start_at <= ${staticWeekBounds.endIso}::timestamptz
          ORDER BY shift_start_at ASC
        `;
      }
    }

    const hasSchedule = scheduleRows.length > 0;
    const isStaticSchedule = hasSchedule && scheduleRows.some((r: any) => !!r.static_schedule);
    const week_schedule = hasSchedule ? {
      title: isStaticSchedule ? 'Permanent Work Schedule' : `Week of ${effectiveWeekStart}`,
      week_start: effectiveWeekStart,
      static_schedule: isStaticSchedule,
      rows: scheduleRows,
    } : null;

    return json({
      ok: true,
      actor,
      today: todayRows[0] || null,
      period_entries: periodRows,
      range_entries,
      range_total_hours: Math.round(range_total_hours * 100) / 100,
      week_schedule,
    });
  } catch (e: any) {
    return json({ ok: false, error: 'server_error', message: e?.message || String(e) }, 500);
  }
};
