import { neon } from "@neondatabase/serverless";
import { canManageEmployeeSchedules, getTenantActor, requireSessionActor } from "../../../_shared/auth";

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
    if (!actor || actor.active === false || !canManageEmployeeSchedules(actor)) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const rows = await sql/*sql*/`
      SELECT
        u.user_id,
        u.email,
        u.name,
        u.login_id,
        m.role,
        m.active
      FROM app.memberships m
      JOIN app.users u ON u.user_id = m.user_id
      WHERE m.tenant_id = ${tenant_id}::uuid
      ORDER BY lower(COALESCE(NULLIF(u.name, ''), NULLIF(u.login_id, ''), NULLIF(u.email, ''), u.user_id::text))
    `;

    return json({ ok: true, users: rows });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
