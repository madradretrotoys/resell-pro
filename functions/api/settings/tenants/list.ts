import { neon } from "@neondatabase/serverless";
import { requireSessionActor } from "../../../_shared/auth";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const auth = await requireSessionActor(request, env, json);
    if ("error" in auth) return auth.error;

    const sql = neon(String(env.DATABASE_URL));
    const [access] = await sql<{ has_active_membership: boolean; can_add_tenant: boolean }[]>`
      SELECT
        EXISTS (
          SELECT 1
          FROM app.memberships m
          WHERE m.user_id = ${auth.actor_user_id} AND m.active = true
        ) AS has_active_membership,
        (
          EXISTS (
            SELECT 1
            FROM app.memberships m
            WHERE m.user_id = ${auth.actor_user_id} AND m.active = true AND m.role = 'owner'
          )
          OR EXISTS (
            SELECT 1
            FROM app.permissions p
            WHERE p.user_id = ${auth.actor_user_id} AND COALESCE(p.can_add_tenant, false) = true
          )
        ) AS can_add_tenant
    `;

    if (!access?.has_active_membership || !access.can_add_tenant) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

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
