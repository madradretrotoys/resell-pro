import { neon } from "@neondatabase/serverless";
import { canManagePlatform, canManageTenantSettings, getPlatformActor, getTenantActor, requireSessionActor } from "../../../../_shared/auth";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const TENANT_ROLES = ["owner", "admin", "manager", "clerk"];
const PLATFORM_ROLES = ["platform_owner", "platform_admin", "platform_support", "platform_readonly"];
const SCOPES = ["platform", "organization", "business", "tenant"];

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function canManageAccess(sql: ReturnType<typeof neon>, tenantId: string | null, actorUserId: string) {
  const platformActor = await getPlatformActor(sql, actorUserId).catch(() => null);
  if (canManagePlatform(platformActor)) return { ok: true, platform: true };
  if (!tenantId) return { ok: false, platform: false };
  const tenantActor = await getTenantActor(sql, tenantId, actorUserId);
  return { ok: !!tenantActor && tenantActor.active !== false && canManageTenantSettings(tenantActor), platform: false };
}

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const auth = await requireSessionActor(request, env, json);
    if ("error" in auth) return auth.error;

    const url = new URL(request.url);
    const userId = String(url.searchParams.get("user_id") || "").trim();
    if (!isUuid(userId)) return json({ ok: false, error: "invalid_user" }, 400);

    const tenantId = request.headers.get("x-tenant-id");
    const sql = neon(String(env.DATABASE_URL));
    const access = await canManageAccess(sql, tenantId, auth.actor_user_id);
    if (!access.ok) return json({ ok: false, error: "forbidden" }, 403);

    const [user] = await sql/*sql*/`
      SELECT user_id, name, email, login_id, COALESCE(is_active, true) AS is_active
      FROM app.users
      WHERE user_id = ${userId}
      LIMIT 1
    `;
    if (!user) return json({ ok: false, error: "user_not_found" }, 404);

    const [currentTenant] = !access.platform && tenantId ? await sql<{ tenant_id: string; business_id: string | null; organization_id: string | null }[]>`
      SELECT t.tenant_id, t.business_id, b.organization_id
      FROM app.tenants t
      LEFT JOIN app.businesses b ON b.business_id = t.business_id
      WHERE t.tenant_id = ${tenantId}
      LIMIT 1
    ` : [null as any];

    const platformAssignments = access.platform ? await sql/*sql*/`
      SELECT 'platform' AS scope, NULL::uuid AS entity_id, 'Resell Pro Platform' AS entity_name,
             role, active, created_at, updated_at
      FROM app.platform_memberships
      WHERE user_id = ${userId}
    ` : [];

    const organizationAssignments = await sql/*sql*/`
      SELECT 'organization' AS scope, om.organization_id AS entity_id, o.name AS entity_name,
             om.role, om.active, om.created_at, om.updated_at
      FROM app.organization_memberships om
      JOIN app.organizations o ON o.organization_id = om.organization_id
      WHERE om.user_id = ${userId}
      ORDER BY lower(o.name)
    `;

    const businessAssignments = await sql/*sql*/`
      SELECT 'business' AS scope, bm.business_id AS entity_id, (o.name || ' / ' || b.name) AS entity_name,
             bm.role, bm.active, bm.created_at, bm.updated_at
      FROM app.business_memberships bm
      JOIN app.businesses b ON b.business_id = bm.business_id
      JOIN app.organizations o ON o.organization_id = b.organization_id
      WHERE bm.user_id = ${userId}
      ORDER BY lower(o.name), lower(b.name)
    `;

    const tenantAssignments = await sql/*sql*/`
      SELECT 'tenant' AS scope, m.tenant_id AS entity_id,
             COALESCE(o.name || ' / ' || b.name || ' / ', '') || t.name AS entity_name,
             m.role::text AS role, m.active, m.created_at, NULL::timestamptz AS updated_at
      FROM app.memberships m
      JOIN app.tenants t ON t.tenant_id = m.tenant_id
      LEFT JOIN app.businesses b ON b.business_id = t.business_id
      LEFT JOIN app.organizations o ON o.organization_id = b.organization_id
      WHERE m.user_id = ${userId}
      ORDER BY lower(COALESCE(o.name, '')), lower(COALESCE(b.name, '')), lower(t.name)
    `;

    const organizations = access.platform ? await sql/*sql*/`
      SELECT organization_id AS entity_id, name AS entity_name
      FROM app.organizations
      WHERE status = 'active'
      ORDER BY lower(name)
    ` : currentTenant?.organization_id ? await sql/*sql*/`
      SELECT organization_id AS entity_id, name AS entity_name
      FROM app.organizations
      WHERE status = 'active' AND organization_id = ${currentTenant.organization_id}
      ORDER BY lower(name)
    ` : [];
    const businesses = access.platform ? await sql/*sql*/`
      SELECT b.business_id AS entity_id, (o.name || ' / ' || b.name) AS entity_name
      FROM app.businesses b
      JOIN app.organizations o ON o.organization_id = b.organization_id
      WHERE b.status = 'active' AND o.status = 'active'
      ORDER BY lower(o.name), lower(b.name)
    ` : currentTenant?.organization_id ? await sql/*sql*/`
      SELECT b.business_id AS entity_id, (o.name || ' / ' || b.name) AS entity_name
      FROM app.businesses b
      JOIN app.organizations o ON o.organization_id = b.organization_id
      WHERE b.status = 'active' AND o.status = 'active' AND b.organization_id = ${currentTenant.organization_id}
      ORDER BY lower(o.name), lower(b.name)
    ` : [];
    const effectiveTenants = access.platform ? await sql/*sql*/`
      WITH inherited AS (
        SELECT t.tenant_id,
               COALESCE(o.name || ' / ' || b.name || ' / ', '') || t.name AS tenant_name,
               'Platform' AS source_scope,
               pm.role AS source_role
        FROM app.platform_memberships pm
        JOIN app.tenants t ON true
        LEFT JOIN app.businesses b ON b.business_id = t.business_id
        LEFT JOIN app.organizations o ON o.organization_id = b.organization_id
        WHERE pm.user_id = ${userId} AND pm.active = true
        UNION ALL
        SELECT t.tenant_id,
               COALESCE(o.name || ' / ' || b.name || ' / ', '') || t.name AS tenant_name,
               'Organization' AS source_scope,
               om.role AS source_role
        FROM app.organization_memberships om
        JOIN app.businesses b ON b.organization_id = om.organization_id
        JOIN app.tenants t ON t.business_id = b.business_id
        LEFT JOIN app.organizations o ON o.organization_id = b.organization_id
        WHERE om.user_id = ${userId} AND om.active = true
        UNION ALL
        SELECT t.tenant_id,
               COALESCE(o.name || ' / ' || b.name || ' / ', '') || t.name AS tenant_name,
               'Business' AS source_scope,
               bm.role AS source_role
        FROM app.business_memberships bm
        JOIN app.tenants t ON t.business_id = bm.business_id
        LEFT JOIN app.businesses b ON b.business_id = t.business_id
        LEFT JOIN app.organizations o ON o.organization_id = b.organization_id
        WHERE bm.user_id = ${userId} AND bm.active = true
        UNION ALL
        SELECT t.tenant_id,
               COALESCE(o.name || ' / ' || b.name || ' / ', '') || t.name AS tenant_name,
               'Tenant' AS source_scope,
               m.role::text AS source_role
        FROM app.memberships m
        JOIN app.tenants t ON t.tenant_id = m.tenant_id
        LEFT JOIN app.businesses b ON b.business_id = t.business_id
        LEFT JOIN app.organizations o ON o.organization_id = b.organization_id
        WHERE m.user_id = ${userId} AND m.active = true
      )
      SELECT tenant_id, tenant_name,
             string_agg(source_scope || ' ' || source_role, ', ' ORDER BY source_scope) AS access_source
      FROM inherited
      GROUP BY tenant_id, tenant_name
      ORDER BY lower(tenant_name)
    ` : await sql/*sql*/`
      WITH inherited AS (
        SELECT t.tenant_id,
               COALESCE(o.name || ' / ' || b.name || ' / ', '') || t.name AS tenant_name,
               'Organization' AS source_scope,
               om.role AS source_role
        FROM app.organization_memberships om
        JOIN app.businesses b ON b.organization_id = om.organization_id
        JOIN app.tenants t ON t.business_id = b.business_id
        LEFT JOIN app.organizations o ON o.organization_id = b.organization_id
        WHERE om.user_id = ${userId} AND om.active = true
        UNION ALL
        SELECT t.tenant_id,
               COALESCE(o.name || ' / ' || b.name || ' / ', '') || t.name AS tenant_name,
               'Business' AS source_scope,
               bm.role AS source_role
        FROM app.business_memberships bm
        JOIN app.tenants t ON t.business_id = bm.business_id
        LEFT JOIN app.businesses b ON b.business_id = t.business_id
        LEFT JOIN app.organizations o ON o.organization_id = b.organization_id
        WHERE bm.user_id = ${userId} AND bm.active = true
        UNION ALL
        SELECT t.tenant_id,
               COALESCE(o.name || ' / ' || b.name || ' / ', '') || t.name AS tenant_name,
               'Tenant' AS source_scope,
               m.role::text AS source_role
        FROM app.memberships m
        JOIN app.tenants t ON t.tenant_id = m.tenant_id
        LEFT JOIN app.businesses b ON b.business_id = t.business_id
        LEFT JOIN app.organizations o ON o.organization_id = b.organization_id
        WHERE m.user_id = ${userId} AND m.active = true
      )
      SELECT tenant_id, tenant_name,
             string_agg(source_scope || ' ' || source_role, ', ' ORDER BY source_scope) AS access_source
      FROM inherited
      GROUP BY tenant_id, tenant_name
      ORDER BY lower(tenant_name)
    `;

    const tenants = access.platform ? await sql/*sql*/`
      SELECT t.tenant_id AS entity_id, COALESCE(o.name || ' / ' || b.name || ' / ', '') || t.name AS entity_name
      FROM app.tenants t
      LEFT JOIN app.businesses b ON b.business_id = t.business_id
      LEFT JOIN app.organizations o ON o.organization_id = b.organization_id
      ORDER BY lower(COALESCE(o.name, '')), lower(COALESCE(b.name, '')), lower(t.name)
    ` : currentTenant?.organization_id ? await sql/*sql*/`
      SELECT t.tenant_id AS entity_id, COALESCE(o.name || ' / ' || b.name || ' / ', '') || t.name AS entity_name
      FROM app.tenants t
      LEFT JOIN app.businesses b ON b.business_id = t.business_id
      LEFT JOIN app.organizations o ON o.organization_id = b.organization_id
      WHERE b.organization_id = ${currentTenant.organization_id}
      ORDER BY lower(COALESCE(o.name, '')), lower(COALESCE(b.name, '')), lower(t.name)
    ` : await sql/*sql*/`
      SELECT t.tenant_id AS entity_id, t.name AS entity_name
      FROM app.tenants t
      WHERE t.tenant_id = ${tenantId}
      ORDER BY lower(t.name)
    `;

    return json({
      ok: true,
      user,
      can_manage_platform: access.platform,
      assignments: [...platformAssignments, ...organizationAssignments, ...businessAssignments, ...tenantAssignments],
      effective_tenants: effectiveTenants,
      options: { organizations, businesses, tenants, tenant_roles: TENANT_ROLES, platform_roles: PLATFORM_ROLES },
    });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const auth = await requireSessionActor(request, env, json);
    if ("error" in auth) return auth.error;

    const body: any = await request.json().catch(() => ({}));
    const userId = String(body.user_id || "").trim();
    const scope = String(body.scope || "").trim().toLowerCase();
    const entityId = String(body.entity_id || "").trim();
    const role = String(body.role || "").trim().toLowerCase();
    const active = body.active !== false;
    const remove = body.remove === true;

    if (!isUuid(userId)) return json({ ok: false, error: "invalid_user" }, 400);
    if (!SCOPES.includes(scope)) return json({ ok: false, error: "invalid_scope" }, 400);
    if (scope === "platform" ? !PLATFORM_ROLES.includes(role) : !TENANT_ROLES.includes(role)) {
      return json({ ok: false, error: "invalid_role" }, 400);
    }
    if (scope !== "platform" && !isUuid(entityId)) return json({ ok: false, error: "invalid_entity" }, 400);

    const tenantId = request.headers.get("x-tenant-id");
    const sql = neon(String(env.DATABASE_URL));
    const access = await canManageAccess(sql, tenantId, auth.actor_user_id);
    if (!access.ok) return json({ ok: false, error: "forbidden" }, 403);
    if (scope === "platform" && !access.platform) return json({ ok: false, error: "forbidden_platform" }, 403);

    if (!access.platform && scope !== "platform") {
      const [currentTenant] = tenantId ? await sql<{ tenant_id: string; business_id: string | null; organization_id: string | null }[]>`
        SELECT t.tenant_id, t.business_id, b.organization_id
        FROM app.tenants t
        LEFT JOIN app.businesses b ON b.business_id = t.business_id
        WHERE t.tenant_id = ${tenantId}
        LIMIT 1
      ` : [];
      let allowed = false;
      if (scope === "tenant") {
        const [row] = await sql<{ ok: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM app.tenants t
            LEFT JOIN app.businesses b ON b.business_id = t.business_id
            WHERE t.tenant_id = ${entityId}::uuid
              AND (${currentTenant?.organization_id || null}::uuid IS NOT NULL AND b.organization_id = ${currentTenant?.organization_id || null}::uuid
                   OR ${currentTenant?.organization_id || null}::uuid IS NULL AND t.tenant_id = ${tenantId}::uuid)
          ) AS ok
        `;
        allowed = !!row?.ok;
      } else if (scope === "business" && currentTenant?.organization_id) {
        const [row] = await sql<{ ok: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM app.businesses WHERE business_id = ${entityId}::uuid AND organization_id = ${currentTenant.organization_id}::uuid) AS ok
        `;
        allowed = !!row?.ok;
      } else if (scope === "organization" && currentTenant?.organization_id) {
        allowed = entityId === currentTenant.organization_id;
      }
      if (!allowed) return json({ ok: false, error: "forbidden_scope" }, 403);
    }

    const [user] = await sql/*sql*/`SELECT user_id FROM app.users WHERE user_id = ${userId} LIMIT 1`;
    if (!user) return json({ ok: false, error: "user_not_found" }, 404);

    if (scope === "platform") {
      if (remove) await sql/*sql*/`DELETE FROM app.platform_memberships WHERE user_id = ${userId}`;
      else await sql/*sql*/`
        INSERT INTO app.platform_memberships (user_id, role, active)
        VALUES (${userId}, ${role}, ${active})
        ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active, updated_at = now()
      `;
    } else if (scope === "organization") {
      if (remove) await sql/*sql*/`DELETE FROM app.organization_memberships WHERE organization_id = ${entityId}::uuid AND user_id = ${userId}`;
      else await sql/*sql*/`
        INSERT INTO app.organization_memberships (organization_id, user_id, role, active)
        VALUES (${entityId}::uuid, ${userId}, ${role}, ${active})
        ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active, updated_at = now()
      `;
    } else if (scope === "business") {
      if (remove) await sql/*sql*/`DELETE FROM app.business_memberships WHERE business_id = ${entityId}::uuid AND user_id = ${userId}`;
      else await sql/*sql*/`
        INSERT INTO app.business_memberships (business_id, user_id, role, active)
        VALUES (${entityId}::uuid, ${userId}, ${role}, ${active})
        ON CONFLICT (business_id, user_id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active, updated_at = now()
      `;
    } else if (scope === "tenant") {
      if (remove) await sql/*sql*/`DELETE FROM app.memberships WHERE tenant_id = ${entityId}::uuid AND user_id = ${userId}`;
      else await sql/*sql*/`
        INSERT INTO app.memberships (tenant_id, user_id, role, active)
        VALUES (${entityId}::uuid, ${userId}, ${role}, ${active})
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active
      `;
    }

    return json({ ok: true });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
