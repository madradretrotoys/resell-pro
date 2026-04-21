import { neon } from "@neondatabase/serverless";
import { canManageTenantSettings, getTenantActor, requireSessionActor } from "../../../_shared/auth";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

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

    const weekly = await sql/*sql*/`
      SELECT
        business_hour_id,
        day_of_week,
        is_closed,
        open_time,
        close_time,
        effective_start_date,
        effective_end_date,
        updated_at
      FROM app.tenant_business_hours
      WHERE tenant_id = ${tenant_id}::uuid
      ORDER BY day_of_week, coalesce(effective_start_date, date '1900-01-01')
    `;

    const exceptions = await sql/*sql*/`
      SELECT
        business_hour_exception_id,
        exception_date,
        is_closed,
        open_time,
        close_time,
        reason,
        updated_at
      FROM app.tenant_business_hour_exceptions
      WHERE tenant_id = ${tenant_id}::uuid
      ORDER BY exception_date
    `;

    return json({ ok: true, weekly, exceptions });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
