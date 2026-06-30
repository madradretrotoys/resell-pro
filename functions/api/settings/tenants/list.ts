import { neon } from "@neondatabase/serverless";
import { getTenantActor, requireSessionActor } from "../../../_shared/auth";

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
    if (!actor || actor.active === false) return json({ ok: false, error: "forbidden" }, 403);

    const [permission] = await sql<{ can_add_tenant: boolean | null }[]>`
      SELECT COALESCE(can_add_tenant, false) AS can_add_tenant
      FROM app.permissions
      WHERE user_id = ${auth.actor_user_id}
      LIMIT 1
    `;
    const can_add_tenant = actor.role === "owner" || !!permission?.can_add_tenant;
    if (!can_add_tenant) return json({ ok: false, error: "forbidden" }, 403);

    const tenants = await sql/*sql*/`
      SELECT t.tenant_id, t.name, t.slug, t.created_at,
             COALESCE(m.role::text, '') AS actor_role,
             COALESCE(m.active, false) AS actor_member_active
      FROM app.tenants t
      LEFT JOIN app.memberships m
        ON m.tenant_id = t.tenant_id AND m.user_id = ${auth.actor_user_id}
      ORDER BY t.created_at DESC, t.name ASC
    `;

    return json({ ok: true, tenants });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
