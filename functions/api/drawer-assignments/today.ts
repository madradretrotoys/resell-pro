import { neon } from "@neondatabase/serverless";
import { getTenantActor, requireSessionActor } from "../../_shared/auth";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function todayUtcYmd() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const auth = await requireSessionActor(request, env, json);
    if ("error" in auth) return auth.error;

    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) return json({ ok: false, error: "missing_tenant" }, 400);

    const url = new URL(request.url);
    const business_date = String(url.searchParams.get("business_date") || todayUtcYmd());

    const sql = neon(String(env.DATABASE_URL));
    const actor = await getTenantActor(sql, tenant_id, auth.actor_user_id);

    if (!actor || actor.active === false) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const rows = await sql/*sql*/`
      SELECT
        da.assignment_id,
        da.business_date,
        da.starts_at,
        da.ends_at,
        da.status,
        da.notes,
        da.drawer_id,
        td.drawer_name,
        td.drawer_code,
        da.user_id,
        u.name AS user_name,
        u.login_id AS user_login_id
      FROM app.drawer_assignments da
      JOIN app.tenant_drawers td
        ON td.drawer_id = da.drawer_id
      JOIN app.users u
        ON u.user_id = da.user_id
      WHERE da.tenant_id = ${tenant_id}
        AND da.business_date = ${business_date}::date
      ORDER BY td.drawer_name, da.starts_at nulls first, u.name
    `;

    return json({ ok: true, business_date, assignments: rows });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
