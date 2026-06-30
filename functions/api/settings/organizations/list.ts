import { neon } from "@neondatabase/serverless";
import { requireSessionActor } from "../../../_shared/auth";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

async function canManageTenantSetup(sql: ReturnType<typeof neon>, actorUserId: string) {
  const [access] = await sql<{ has_active_membership: boolean; can_add_tenant: boolean }[]>`
    SELECT
      EXISTS (
        SELECT 1
        FROM app.memberships m
        WHERE m.user_id = ${actorUserId} AND m.active = true
      ) AS has_active_membership,
      (
        EXISTS (
          SELECT 1
          FROM app.memberships m
          WHERE m.user_id = ${actorUserId} AND m.active = true AND m.role = 'owner'
        )
        OR EXISTS (
          SELECT 1
          FROM app.permissions p
          WHERE p.user_id = ${actorUserId} AND COALESCE(p.can_add_tenant, false) = true
        )
      ) AS can_add_tenant
  `;

  return !!access?.has_active_membership && !!access?.can_add_tenant;
}

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const auth = await requireSessionActor(request, env, json);
    if ("error" in auth) return auth.error;

    const sql = neon(String(env.DATABASE_URL));
    if (!(await canManageTenantSetup(sql, auth.actor_user_id))) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const organizations = await sql/*sql*/`
      SELECT
        o.organization_id,
        o.name,
        o.slug,
        o.status,
        o.created_at,
        COALESCE(
          json_agg(
            json_build_object(
              'business_id', b.business_id,
              'name', b.name,
              'slug', b.slug,
              'status', b.status,
              'created_at', b.created_at
            )
            ORDER BY b.name ASC
          ) FILTER (WHERE b.business_id IS NOT NULL),
          '[]'::json
        ) AS businesses
      FROM app.organizations o
      LEFT JOIN app.businesses b
        ON b.organization_id = o.organization_id
      GROUP BY o.organization_id
      ORDER BY o.name ASC
    `;

    return json({ ok: true, organizations });
  } catch (e: any) {
    const message = e?.message || String(e);
    if (message.includes('relation "app.organizations" does not exist') || message.includes('relation "app.businesses" does not exist')) {
      return json({ ok: true, organizations: [], hierarchy_schema_missing: true });
    }
    return json({ ok: false, error: "server_error", message }, 500);
  }
};
