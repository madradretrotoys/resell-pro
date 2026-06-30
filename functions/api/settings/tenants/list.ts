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

    const tenants = await listTenants(sql, auth.actor_user_id);

    return json({ ok: true, tenants });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};

async function listTenants(sql: ReturnType<typeof neon>, actorUserId: string) {
  try {
    return await sql/*sql*/`
      SELECT t.tenant_id, t.name, t.slug, t.business_id, t.created_at,
             t."Street Address" AS street_address,
             t."City" AS city, t."State" AS state, t."Zip" AS zip, t."Phone" AS phone, t.email,
             b.name AS business_name,
             b.slug AS business_slug,
             o.organization_id,
             o.name AS organization_name,
             o.slug AS organization_slug,
             tl.cdn_url AS logo_url,
             COALESCE(m.role::text, '') AS actor_role,
             COALESCE(m.active, false) AS actor_member_active
      FROM app.tenants t
      LEFT JOIN app.businesses b
        ON b.business_id = t.business_id
      LEFT JOIN app.organizations o
        ON o.organization_id = b.organization_id
      LEFT JOIN app.memberships m
        ON m.tenant_id = t.tenant_id AND m.user_id = ${actorUserId}
      LEFT JOIN app.tenant_logos tl
        ON tl.tenant_id = t.tenant_id AND tl.is_active = true
      ORDER BY o.name ASC NULLS LAST, b.name ASC NULLS LAST, t.created_at DESC, t.name ASC
    `;
  } catch (e: any) {
    const message = e?.message || String(e);
    if (
      !message.includes('relation "app.businesses" does not exist') &&
      !message.includes('relation "app.organizations" does not exist') &&
      !message.includes("column t.business_id does not exist")
    ) {
      throw e;
    }

    return await sql/*sql*/`
      SELECT t.tenant_id, t.name, t.slug, NULL::uuid AS business_id, t.created_at,
             t."Street Address" AS street_address,
             t."City" AS city, t."State" AS state, t."Zip" AS zip, t."Phone" AS phone, t.email,
             NULL::text AS business_name,
             NULL::text AS business_slug,
             NULL::uuid AS organization_id,
             NULL::text AS organization_name,
             NULL::text AS organization_slug,
             tl.cdn_url AS logo_url,
             COALESCE(m.role::text, '') AS actor_role,
             COALESCE(m.active, false) AS actor_member_active
      FROM app.tenants t
      LEFT JOIN app.memberships m
        ON m.tenant_id = t.tenant_id AND m.user_id = ${actorUserId}
      LEFT JOIN app.tenant_logos tl
        ON tl.tenant_id = t.tenant_id AND tl.is_active = true
      ORDER BY t.created_at DESC, t.name ASC
    `;
  }
}
