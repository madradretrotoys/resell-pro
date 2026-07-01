import { neon } from "@neondatabase/serverless";
import { requireSessionActor } from "../../../_shared/auth";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const auth = await requireSessionActor(request, env, json);
    if ("error" in auth) return auth.error;

    const activeTenantId = readCookie(request.headers.get("cookie") || "", "__Host-rp_tenant");
    const sql = neon(String(env.DATABASE_URL));
    const rows = await sql/*sql*/`
      WITH accessible AS (
        SELECT t.tenant_id, t.name AS tenant_name, t.slug AS tenant_slug, t.business_id,
               b.name AS business_name, b.organization_id, o.name AS organization_name,
               'platform' AS access_scope, pm.role AS access_role, 1 AS priority
        FROM app.platform_memberships pm
        JOIN app.tenants t ON true
        LEFT JOIN app.businesses b ON b.business_id = t.business_id
        LEFT JOIN app.organizations o ON o.organization_id = b.organization_id
        WHERE pm.user_id = ${auth.actor_user_id} AND pm.active = true AND pm.role IN ('platform_owner', 'platform_admin')
        UNION ALL
        SELECT t.tenant_id, t.name AS tenant_name, t.slug AS tenant_slug, t.business_id,
               b.name AS business_name, b.organization_id, o.name AS organization_name,
               'organization' AS access_scope, om.role AS access_role, 2 AS priority
        FROM app.organization_memberships om
        JOIN app.businesses b ON b.organization_id = om.organization_id
        JOIN app.tenants t ON t.business_id = b.business_id
        LEFT JOIN app.organizations o ON o.organization_id = b.organization_id
        WHERE om.user_id = ${auth.actor_user_id} AND om.active = true
        UNION ALL
        SELECT t.tenant_id, t.name AS tenant_name, t.slug AS tenant_slug, t.business_id,
               b.name AS business_name, b.organization_id, o.name AS organization_name,
               'business' AS access_scope, bm.role AS access_role, 3 AS priority
        FROM app.business_memberships bm
        JOIN app.tenants t ON t.business_id = bm.business_id
        LEFT JOIN app.businesses b ON b.business_id = t.business_id
        LEFT JOIN app.organizations o ON o.organization_id = b.organization_id
        WHERE bm.user_id = ${auth.actor_user_id} AND bm.active = true
        UNION ALL
        SELECT t.tenant_id, t.name AS tenant_name, t.slug AS tenant_slug, t.business_id,
               b.name AS business_name, b.organization_id, o.name AS organization_name,
               'tenant' AS access_scope, m.role::text AS access_role, 4 AS priority
        FROM app.memberships m
        JOIN app.tenants t ON t.tenant_id = m.tenant_id
        LEFT JOIN app.businesses b ON b.business_id = t.business_id
        LEFT JOIN app.organizations o ON o.organization_id = b.organization_id
        WHERE m.user_id = ${auth.actor_user_id} AND m.active = true
      ), ranked AS (
        SELECT *, row_number() OVER (PARTITION BY tenant_id ORDER BY priority) AS rn
        FROM accessible
      )
      SELECT tenant_id, tenant_name, tenant_slug, business_id, business_name, organization_id, organization_name,
             access_scope, access_role, priority,
             tenant_id::text = ${activeTenantId || ""} AS is_active
      FROM ranked
      WHERE rn = 1
      ORDER BY lower(COALESCE(organization_name, 'Unassigned')), lower(COALESCE(business_name, 'Unassigned')), lower(tenant_name)
    `;

    return json({ ok: true, active_tenant_id: activeTenantId || null, tenants: rows });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};

function readCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/; */)) {
    const [k, ...rest] = part.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}
