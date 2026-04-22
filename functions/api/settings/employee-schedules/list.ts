import { neon } from "@neondatabase/serverless";
import { canManageTenantSettings, getTenantActor, requireSessionActor } from "../../../_shared/auth";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function weekRangeUtc(weekStartsOn: number, weekStartDate?: string | null) {
  let start: Date;
  if (weekStartDate && /^\d{4}-\d{2}-\d{2}$/.test(weekStartDate)) {
    const [y, m, d] = weekStartDate.split('-').map((x) => Number(x));
    start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  } else {
    const now = new Date();
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
    const day = todayUtc.getUTCDay();
    const delta = (day - weekStartsOn + 7) % 7;
    start = new Date(todayUtc);
    start.setUTCDate(todayUtc.getUTCDate() - delta);
  }
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 6, 23, 59, 59, 999));
  return { from: start.toISOString(), to: end.toISOString() };
}

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const auth = await requireSessionActor(request, env, json);
    if ("error" in auth) return auth.error;

    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) return json({ ok: false, error: "missing_tenant" }, 400);

    const sql = neon(String(env.DATABASE_URL));
    const actor = await getTenantActor(sql, tenant_id, auth.actor_user_id);
    if (!actor || actor.active === false || !canManageTenantSettings(actor)) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const weekStartColumnRows = await sql/*sql*/`
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'app'
        AND table_name = 'tenant_settings'
        AND column_name = 'week_starts_on'
      LIMIT 1
    `;

    let week_starts_on = 0;
    if (weekStartColumnRows.length) {
      const weekRows = await sql/*sql*/`
        SELECT week_starts_on
        FROM app.tenant_settings
        WHERE tenant_id = ${tenant_id}::uuid
        LIMIT 1
      `;
      week_starts_on = Number(weekRows?.[0]?.week_starts_on ?? 0);
    }

    const url = new URL(request.url);
    const week_start = url.searchParams.get("week_start");
    const defaults = weekRangeUtc(week_starts_on, week_start);
    const from = String(url.searchParams.get("from") || defaults.from);
    const to = String(url.searchParams.get("to") || defaults.to);

    const rows = await sql/*sql*/`
      SELECT
        es.schedule_id,
        es.user_id,
        u.name AS user_name,
        u.login_id AS user_login_id,
        es.business_date,
        es.shift_start_at,
        es.shift_end_at,
        es.break_minutes,
        es.static_schedule,
        es.status,
        es.preferred_drawer_id,
        td.drawer_name AS preferred_drawer_name,
        es.notes,
        es.updated_at
      FROM app.employee_schedules es
      JOIN app.users u ON u.user_id = es.user_id
      LEFT JOIN app.tenant_drawers td ON td.drawer_id = es.preferred_drawer_id
      WHERE es.tenant_id = ${tenant_id}::uuid
        AND es.shift_start_at >= ${from}::timestamptz
        AND es.shift_start_at <= ${to}::timestamptz
      ORDER BY es.shift_start_at, u.name
    `;

    return json({ ok: true, from, to, week_starts_on, rows });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
