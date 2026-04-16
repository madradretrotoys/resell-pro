import { neon } from '@neondatabase/serverless';
import { dayBounds, json, requireTimesheetActor } from './_helpers';

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const sql = neon(String(env.DATABASE_URL));
    const auth = await requireTimesheetActor(request, env, sql);
    if ('error' in auth) return auth.error;
    const { actor } = auth;

    const url = new URL(request.url);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');

    if (!from || !to) return json({ ok: false, error: 'from_to_required' }, 400);

    const fromBounds = dayBounds(from);
    const toBounds = dayBounds(to);
    if (fromBounds.startIso > toBounds.endIso) return json({ ok: false, error: 'invalid_range' }, 400);

    const rows = await sql/*sql*/`
      SELECT *
      FROM app.time_entries
      WHERE login_id = ${actor.login_id}
        AND clock_in >= ${fromBounds.startIso}
        AND clock_in <= ${toBounds.endIso}
      ORDER BY clock_in ASC NULLS LAST
    `;

    const grandTotal = rows.reduce((sum: number, r: any) => sum + Number(r.total_hours || 0), 0);

    return json({
      ok: true,
      from: fromBounds.date,
      to: toBounds.date,
      entries: rows,
      grand_total_hours: Math.round(grandTotal * 100) / 100,
    });
  } catch (e: any) {
    return json({ ok: false, error: 'server_error', message: e?.message || String(e) }, 500);
  }
};
