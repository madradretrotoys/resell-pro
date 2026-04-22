import { neon } from "@neondatabase/serverless";
import { canManageTenantSettings, getTenantActor, requireSessionActor } from "../../../_shared/auth";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function weekRangeUtc() {
  const now = new Date();
  const day = now.getUTCDay();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day, 0, 0, 0, 0));
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

    const url = new URL(request.url);
    const defaults = weekRangeUtc();
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

    return json({ ok: true, from, to, rows });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
