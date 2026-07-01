import { neon } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";
import { canAccessSettingsUser, canAssignSettingsUserRole, canManagePlatform, canManageTenantSettings, getPlatformActor, getTenantActor, requireSessionActor } from "../../../_shared/auth";

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

function roleOptionsForAccess(access: { platform: boolean; platformRole?: string | null; tenantActor?: any }) {
  if (access.platform) {
    const platformRoles = access.platformRole === "platform_owner" ? PLATFORM_ROLES : ["platform_admin", "platform_support", "platform_readonly"];
    return { platform: platformRoles, organization: TENANT_ROLES, business: TENANT_ROLES, tenant: TENANT_ROLES };
  }
  const actorRole = String(access.tenantActor?.role || "").toLowerCase();
  if (actorRole === "owner") return { platform: [], organization: TENANT_ROLES, business: TENANT_ROLES, tenant: TENANT_ROLES };
  if (actorRole === "admin") return { platform: [], organization: ["manager", "clerk"], business: ["manager", "clerk"], tenant: ["manager", "clerk"] };
  if (actorRole === "manager") return { platform: [], organization: [], business: [], tenant: ["clerk"] };
  return { platform: [], organization: [], business: [], tenant: [] };
}

function canAssignRequestedRole(access: { platform: boolean; platformRole?: string | null; tenantActor?: any }, scope: string, role: string) {
  return (roleOptionsForAccess(access) as any)[scope]?.includes(role) === true;
}

async function validateAssignmentScope(sql: ReturnType<typeof neon>, tenantId: string, access: any, scope: string, entityId: string) {
  if (access.platform || scope === "platform") return true;
  const [currentTenant] = tenantId ? await sql<{ tenant_id: string; business_id: string | null; organization_id: string | null }[]>`
    SELECT t.tenant_id, t.business_id, b.organization_id
    FROM app.tenants t
    LEFT JOIN app.businesses b ON b.business_id = t.business_id
    WHERE t.tenant_id = ${tenantId}
    LIMIT 1
  ` : [];
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
    return !!row?.ok;
  }
  if (scope === "business" && currentTenant?.organization_id) {
    const [row] = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM app.businesses WHERE business_id = ${entityId}::uuid AND organization_id = ${currentTenant.organization_id}::uuid) AS ok
    `;
    return !!row?.ok;
  }
  if (scope === "organization" && currentTenant?.organization_id) return entityId === currentTenant.organization_id;
  return false;
}

async function applyInitialAssignment(sql: ReturnType<typeof neon>, assignment: any, userId: string) {
  if (!assignment) return;
  const scope = String(assignment.scope || "").trim().toLowerCase();
  const entityId = String(assignment.entity_id || "").trim();
  const role = String(assignment.role || "").trim().toLowerCase();
  const active = assignment.active !== false;
  if (scope === "platform") {
    await sql/*sql*/`
      INSERT INTO app.platform_memberships (user_id, role, active)
      VALUES (${userId}, ${role}, ${active})
      ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active, updated_at = now()
    `;
  } else if (scope === "organization") {
    await sql/*sql*/`
      INSERT INTO app.organization_memberships (organization_id, user_id, role, active)
      VALUES (${entityId}::uuid, ${userId}, ${role}, ${active})
      ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active, updated_at = now()
    `;
  } else if (scope === "business") {
    await sql/*sql*/`
      INSERT INTO app.business_memberships (business_id, user_id, role, active)
      VALUES (${entityId}::uuid, ${userId}, ${role}, ${active})
      ON CONFLICT (business_id, user_id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active, updated_at = now()
    `;
  } else if (scope === "tenant") {
    await sql/*sql*/`
      INSERT INTO app.memberships (tenant_id, user_id, role, active)
      VALUES (${entityId}::uuid, ${userId}, ${role}, ${active})
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active
    `;
  }
}

async function auditInitialAssignment(sql: ReturnType<typeof neon>, actorUserId: string, tenantId: string, assignment: any, userId: string) {
  if (!assignment) return;
  await sql/*sql*/`
    INSERT INTO app.audit_log (tenant_id, user_id, action, meta)
    VALUES (${tenantId}::uuid, ${actorUserId}, 'settings.users.initial_assignment', ${JSON.stringify({ target_user_id: userId, assignment })}::jsonb)
  `;
}

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const auth = await requireSessionActor(request, env, json);
    if ("error" in auth) return auth.error;

    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) return json({ ok: false, error: "missing_tenant" }, 400);

    const sql = neon(String(env.DATABASE_URL));
    const platformActor = await getPlatformActor(sql, auth.actor_user_id).catch(() => null);
    const actor = await getTenantActor(sql, tenant_id, auth.actor_user_id);
    const access = canManagePlatform(platformActor)
      ? { ok: true, platform: true, platformRole: platformActor?.role || null, tenantActor: actor }
      : { ok: !!actor && actor.active !== false && canManageTenantSettings(actor), platform: false, platformRole: null, tenantActor: actor };
    if (!access.ok) return json({ ok: false, error: "forbidden" }, 403);

    const body = await request.json().catch(() => ({} as any));
    const user_id = String((body as any).user_id || "").trim();
    const name = String((body as any).name || "").trim();
    const email = String((body as any).email || "").trim().toLowerCase();
    const login_id = String((body as any).login_id || "").trim();
    const temp_password = String((body as any).temp_password || "").trim();
    const role = String((body as any).role || "clerk").trim().toLowerCase() as "owner" | "admin" | "manager" | "clerk";
    const assignment = (body as any).assignment || null;

    if (!name || !email || !login_id) return json({ ok: false, error: "missing_required_fields" }, 400);
    if (!["owner", "admin", "manager", "clerk"].includes(role)) return json({ ok: false, error: "invalid_role" }, 400);

    if (!access.platform && !canAssignSettingsUserRole(actor, role)) return json({ ok: false, error: "insufficient_role" }, 403);

    if (assignment) {
      const assignmentScope = String(assignment.scope || "").trim().toLowerCase();
      const assignmentEntityId = String(assignment.entity_id || "").trim();
      const assignmentRole = String(assignment.role || "").trim().toLowerCase();
      if (!SCOPES.includes(assignmentScope)) return json({ ok: false, error: "invalid_assignment_scope" }, 400);
      if (assignmentScope === "platform" ? !PLATFORM_ROLES.includes(assignmentRole) : !TENANT_ROLES.includes(assignmentRole)) {
        return json({ ok: false, error: "invalid_assignment_role" }, 400);
      }
      if (assignmentScope !== "platform" && !isUuid(assignmentEntityId)) return json({ ok: false, error: "invalid_assignment_entity" }, 400);
      if (assignmentScope === "platform" && !access.platform) return json({ ok: false, error: "forbidden_platform" }, 403);
      if (!canAssignRequestedRole(access, assignmentScope, assignmentRole)) return json({ ok: false, error: "insufficient_role_scope" }, 403);
      const allowedScope = await validateAssignmentScope(sql, tenant_id, access, assignmentScope, assignmentEntityId);
      if (!allowedScope) return json({ ok: false, error: "forbidden_scope" }, 403);
    }

    let u: { user_id: string; email: string; name: string; login_id: string };
    let tempPasswordGenerated = false;

    if (user_id) {
      const [target] = await sql<{ user_id: string; role: string }[]>`
        SELECT user_id, role
        FROM app.memberships
        WHERE tenant_id = ${tenant_id} AND user_id = ${user_id}
        LIMIT 1
      `;
      if (!target) return json({ ok: false, error: "not_found" }, 404);
      if (!canAccessSettingsUser(actor, auth.actor_user_id, target)) {
        return json({ ok: false, error: "insufficient_role" }, 403);
      }

      const [updated] = await sql/*sql*/`
        UPDATE app.users
        SET email = ${email}, name = ${name}, login_id = ${login_id}, is_active = true
        WHERE user_id = ${user_id}
        RETURNING user_id, email, name, login_id
      `;
      if (!updated) return json({ ok: false, error: "not_found" }, 404);
      u = updated as typeof u;

      await sql/*sql*/`
        UPDATE app.memberships
        SET role = ${role}
        WHERE tenant_id = ${tenant_id} AND user_id = ${u.user_id}
      `;
    } else {
      const generatedPassword = temp_password || crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      const password_hash = await bcrypt.hash(generatedPassword, 10);
      tempPasswordGenerated = !temp_password;

      const [created] = await sql/*sql*/`
        INSERT INTO app.users (email, name, login_id, password_hash, is_active)
        VALUES (${email}, ${name}, ${login_id}, ${password_hash}, true)
        RETURNING user_id, email, name, login_id
      `;
      u = created as typeof u;

      if (assignment) {
        await applyInitialAssignment(sql, assignment, u.user_id);
        await auditInitialAssignment(sql, auth.actor_user_id, tenant_id, assignment, u.user_id);
      } else {
        await sql/*sql*/`
          INSERT INTO app.memberships (tenant_id, user_id, role, active)
          VALUES (${tenant_id}, ${u.user_id}, ${role}, true)
          ON CONFLICT (tenant_id, user_id) DO UPDATE SET
            role=EXCLUDED.role,
            active=true
        `;
      }
    }

    const perms = (body as any).permissions || {};
    const notes = (body as any).notifications || {};
    const discount_max = ((body as any).discount_max === null || (body as any).discount_max === "")
      ? null
      : Number((body as any).discount_max);

    await sql/*sql*/`
      INSERT INTO app.permissions (
        user_id, name, email, role,
        can_pos, can_cash_drawer, can_cash_payouts, can_item_research,
        can_inventory, can_inventory_intake, can_drop_off_form,
        can_estimates_buy_tickets, can_timekeeping, clockin_required, can_settings, can_add_tenant,
        notify_cash_drawer, notify_daily_sales_summary, discount_max
      )
      VALUES (
        ${u.user_id}, ${name}, ${email}, ${role},
        ${!!perms.can_pos}, ${!!perms.can_cash_drawer}, ${!!perms.can_cash_payouts}, ${!!perms.can_item_research},
        ${!!perms.can_inventory}, ${!!perms.can_inventory_intake}, ${!!perms.can_drop_off_form},
        ${!!perms.can_estimates_buy_tickets}, ${!!perms.can_timekeeping}, ${!!perms.clockin_required}, ${!!perms.can_settings}, ${!!perms.can_add_tenant},
        ${!!notes.notify_cash_drawer}, ${!!notes.notify_daily_sales_summary}, ${discount_max}
      )
      ON CONFLICT (user_id) DO UPDATE SET
        name=EXCLUDED.name,
        email=EXCLUDED.email,
        role=EXCLUDED.role,
        can_pos=EXCLUDED.can_pos,
        can_cash_drawer=EXCLUDED.can_cash_drawer,
        can_cash_payouts=EXCLUDED.can_cash_payouts,
        can_item_research=EXCLUDED.can_item_research,
        can_inventory=EXCLUDED.can_inventory,
        can_inventory_intake=EXCLUDED.can_inventory_intake,
        can_drop_off_form=EXCLUDED.can_drop_off_form,
        can_estimates_buy_tickets=EXCLUDED.can_estimates_buy_tickets,
        can_timekeeping=EXCLUDED.can_timekeeping,
        clockin_required=EXCLUDED.clockin_required,
        can_settings=EXCLUDED.can_settings,
        can_add_tenant=EXCLUDED.can_add_tenant,
        notify_cash_drawer=EXCLUDED.notify_cash_drawer,
        notify_daily_sales_summary=EXCLUDED.notify_daily_sales_summary,
        discount_max=EXCLUDED.discount_max,
        updated_at=now()
    `;

    return json({ ok: true, user_id: u.user_id, temp_password_generated: tempPasswordGenerated });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
