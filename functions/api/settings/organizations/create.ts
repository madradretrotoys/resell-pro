import { neon } from "@neondatabase/serverless";
import { requireSessionActor } from "../../../_shared/auth";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function cleanOptionalText(value: unknown, max = 255) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

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

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const auth = await requireSessionActor(request, env, json);
    if ("error" in auth) return auth.error;

    const sql = neon(String(env.DATABASE_URL));
    if (!(await canManageTenantSetup(sql, auth.actor_user_id))) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const body = await request.json().catch(() => ({} as any));
    const organizationName = cleanOptionalText(body.organization_name, 255);
    const businessName = cleanOptionalText(body.business_name, 255);
    const organizationSlug = slugify(cleanOptionalText(body.organization_slug, 80) || organizationName || "");
    const businessSlug = slugify(cleanOptionalText(body.business_slug, 80) || businessName || "");

    if (!organizationName) return json({ ok: false, error: "missing_organization_name" }, 400);
    if (!businessName) return json({ ok: false, error: "missing_business_name" }, 400);
    if (!organizationSlug) return json({ ok: false, error: "invalid_organization_slug" }, 400);
    if (!businessSlug) return json({ ok: false, error: "invalid_business_slug" }, 400);

    const [organization] = await sql/*sql*/`
      INSERT INTO app.organizations (name, slug, created_by_user_id, updated_by_user_id)
      VALUES (${organizationName}, ${organizationSlug}, ${auth.actor_user_id}, ${auth.actor_user_id})
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        status = 'active',
        updated_by_user_id = EXCLUDED.updated_by_user_id,
        updated_at = now()
      RETURNING organization_id, name, slug, status, created_at, updated_at
    `;

    await sql/*sql*/`
      INSERT INTO app.organization_memberships (organization_id, user_id, role, active)
      VALUES (${organization.organization_id}, ${auth.actor_user_id}, 'owner', true)
      ON CONFLICT (organization_id, user_id) DO UPDATE SET
        role = EXCLUDED.role,
        active = true,
        updated_at = now()
    `;

    const [business] = await sql/*sql*/`
      INSERT INTO app.businesses (organization_id, name, slug, created_by_user_id, updated_by_user_id)
      VALUES (${organization.organization_id}, ${businessName}, ${businessSlug}, ${auth.actor_user_id}, ${auth.actor_user_id})
      ON CONFLICT (organization_id, slug) DO UPDATE SET
        name = EXCLUDED.name,
        status = 'active',
        updated_by_user_id = EXCLUDED.updated_by_user_id,
        updated_at = now()
      RETURNING business_id, organization_id, name, slug, status, created_at, updated_at
    `;

    await sql/*sql*/`
      INSERT INTO app.business_memberships (business_id, user_id, role, active)
      VALUES (${business.business_id}, ${auth.actor_user_id}, 'owner', true)
      ON CONFLICT (business_id, user_id) DO UPDATE SET
        role = EXCLUDED.role,
        active = true,
        updated_at = now()
    `;

    return json({ ok: true, organization, business });
  } catch (e: any) {
    const message = e?.message || String(e);
    if (message.includes('relation "app.organizations" does not exist') || message.includes('relation "app.businesses" does not exist')) {
      return json({ ok: false, error: "hierarchy_schema_missing", message: "Apply the organizations/businesses migration before creating organizations and businesses." }, 409);
    }
    return json({ ok: false, error: "server_error", message }, 500);
  }
};
