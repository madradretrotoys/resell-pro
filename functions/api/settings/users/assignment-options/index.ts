import { neon } from "@neondatabase/serverless";
import { canManagePlatform, canManageTenantSettings, getPlatformActor, getTenantActor, requireSessionActor } from "../../../../_shared/auth";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const TENANT_ROLES = ["owner", "admin", "manager", "clerk"];
const PLATFORM_ROLES = ["platform_owner", "platform_admin", "platform_support", "platform_readonly"];

async function resolveAccess(sql: ReturnType<typeof neon>, tenantId: string | null, actorUserId: string) {
  const platformActor = await getPlatformActor(sql, actorUserId).catch(() => null);
  if (canManagePlatform(platformActor)) return { ok: true, platform: true, platformRole: platformActor?.role || null, tenantActor: null as any };
  if (!tenantId) return { ok: false, platform: false, platformRole: null, tenantActor: null as any };
  const tenantActor = await getTenantActor(sql, tenantId, actorUserId);
  return {
    ok: !!tenantActor && tenantActor.active !== false && canManageTenantSettings(tenantActor),
    platform: false,
    platformRole: null,
    tenantActor,
  };
}

function roleOptionsForAccess(access: { platform: boolean; platformRole?: string | null; tenantActor?: any }) {
  if (access.platform) {
    const platformRoles = access.platformRole === "platform_owner"
      ? PLATFORM_ROLES
      : ["platform_admin", "platform_support", "platform_readonly"];
    return { platform: platformRoles, organization: TENANT_ROLES, business: TENANT_ROLES, tenant: TENANT_ROLES };
  }
  const actorRole = String(access.tenantActor?.role || "").toLowerCase();
  if (actorRole === "owner") return { platform: [], organization: TENANT_ROLES, business: TENANT_ROLES, tenant: TENANT_ROLES };
  if (actorRole === "admin") return { platform: [], organization: ["manager", "clerk"], business: ["manager", "clerk"], tenant: ["manager", "clerk"] };
  if (actorRole === "manager") return { platform: [], organization: [], business: [], tenant: ["clerk"] };
  return { platform: [], organization: [], business: [], tenant: [] };
}

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const auth = await requireSessionActor(request, env, json);
    if ("error" in auth) return auth.error;

    const tenantId = request.headers.get("x-tenant-id");
    const sql = neon(String(env.DATABASE_URL));
    const access = await resolveAccess(sql, tenantId, auth.actor_user_id);
    if (!access.ok) return json({ ok: false, error: "forbidden" }, 403);

    const [currentTenant] = !access.platform && tenantId ? await sql<{ tenant_id: string; business_id: string | null; organization_id: string | null }[]>`
      SELECT t.tenant_id, t.business_id, b.organization_id
      FROM app.tenants t
      LEFT JOIN app.businesses b ON b.business_id = t.business_id
      WHERE t.tenant_id = ${tenantId}
      LIMIT 1
    ` : [null as any];

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
      options: {
        organizations,
        businesses,
        tenants,
        role_options_by_scope: roleOptionsForAccess(access),
      },
    });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
