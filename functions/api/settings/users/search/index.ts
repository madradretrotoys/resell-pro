import { neon } from "@neondatabase/serverless";
import { canManagePlatform, canManageTenantSettings, getPlatformActor, getTenantActor, requireSessionActor } from "../../../../_shared/auth";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function canSearchUsers(sql: ReturnType<typeof neon>, tenantId: string | null, actorUserId: string) {
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
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
    if (q.length < 2) return json({ ok: true, users: [] });

    const tenantId = request.headers.get("x-tenant-id");
    const sql = neon(String(env.DATABASE_URL));
    const access = await canSearchUsers(sql, tenantId, auth.actor_user_id);
    if (!access.ok) return json({ ok: false, error: "forbidden" }, 403);

    const scopedUsers = access.platform ? await sql/*sql*/`
      SELECT u.user_id, u.name, u.email, u.login_id, COALESCE(u.is_active, true) AS is_active,
             'platform directory' AS match_source
      FROM app.users u
      WHERE lower(u.email::text) LIKE ${`%${q}%`}
         OR lower(u.login_id) LIKE ${`%${q}%`}
         OR lower(u.name) LIKE ${`%${q}%`}
      ORDER BY lower(u.name)
      LIMIT 25
    ` : await sql/*sql*/`
      WITH current_scope AS (
        SELECT t.tenant_id, t.business_id, b.organization_id
        FROM app.tenants t
        LEFT JOIN app.businesses b ON b.business_id = t.business_id
        WHERE t.tenant_id = ${tenantId}
        LIMIT 1
      ), scoped_users AS (
        SELECT om.user_id, 'organization assignment' AS match_source
        FROM app.organization_memberships om
        JOIN current_scope cs ON cs.organization_id = om.organization_id
        UNION
        SELECT bm.user_id, 'business assignment' AS match_source
        FROM app.business_memberships bm
        JOIN app.businesses b ON b.business_id = bm.business_id
        JOIN current_scope cs ON cs.organization_id = b.organization_id
        UNION
        SELECT m.user_id, 'tenant assignment' AS match_source
        FROM app.memberships m
        JOIN app.tenants t ON t.tenant_id = m.tenant_id
        LEFT JOIN app.businesses b ON b.business_id = t.business_id
        JOIN current_scope cs ON (cs.organization_id IS NOT NULL AND b.organization_id = cs.organization_id)
                              OR (cs.organization_id IS NULL AND t.tenant_id = cs.tenant_id)
        UNION
        SELECT u.user_id, 'exact email/login match' AS match_source
        FROM app.users u
        WHERE lower(u.email::text) = ${q} OR lower(u.login_id) = ${q}
      )
      SELECT DISTINCT ON (u.user_id) u.user_id, u.name, u.email, u.login_id, COALESCE(u.is_active, true) AS is_active,
             su.match_source
      FROM scoped_users su
      JOIN app.users u ON u.user_id = su.user_id
      WHERE lower(u.email::text) LIKE ${`%${q}%`}
         OR lower(u.login_id) LIKE ${`%${q}%`}
         OR lower(u.name) LIKE ${`%${q}%`}
      ORDER BY u.user_id, lower(u.name)
      LIMIT 25
    `;

    return json({ ok: true, users: scopedUsers });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
