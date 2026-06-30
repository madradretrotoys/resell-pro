import { neon } from "@neondatabase/serverless";
import { requireSessionActor } from "../../../_shared/auth";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function slugify(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const auth = await requireSessionActor(request, env, json);
    if ("error" in auth) return auth.error;
    const sql = neon(String(env.DATABASE_URL));
    const [access] = await sql<{ can_add_tenant: boolean }[]>`
      SELECT (
        EXISTS (SELECT 1 FROM app.memberships m WHERE m.user_id = ${auth.actor_user_id} AND m.active = true AND m.role = 'owner')
        OR EXISTS (SELECT 1 FROM app.organization_memberships om WHERE om.user_id = ${auth.actor_user_id} AND om.active = true AND om.role IN ('owner','admin','manager'))
        OR EXISTS (SELECT 1 FROM app.business_memberships bm WHERE bm.user_id = ${auth.actor_user_id} AND bm.active = true AND bm.role IN ('owner','admin','manager'))
        OR EXISTS (SELECT 1 FROM app.permissions p WHERE p.user_id = ${auth.actor_user_id} AND COALESCE(p.can_add_tenant, false) = true)
      ) AS can_add_tenant
    `;
    if (!access?.can_add_tenant) return json({ ok: false, error: "forbidden" }, 403);

    const organizations = await sql/*sql*/`
      SELECT o.organization_id, o.name, o.slug, o.status, o.created_at,
             COALESCE(om.role, '') AS actor_role, COALESCE(om.active, false) AS actor_member_active
      FROM app.organizations o
      LEFT JOIN app.organization_memberships om ON om.organization_id = o.organization_id AND om.user_id = ${auth.actor_user_id}
      ORDER BY o.created_at DESC, o.name ASC
    `;
    const businesses = await sql/*sql*/`
      SELECT b.business_id, b.organization_id, b.name, b.slug, b.status, b.created_at,
             COALESCE(bm.role, '') AS actor_role, COALESCE(bm.active, false) AS actor_member_active
      FROM app.businesses b
      LEFT JOIN app.business_memberships bm ON bm.business_id = b.business_id AND bm.user_id = ${auth.actor_user_id}
      ORDER BY b.created_at DESC, b.name ASC
    `;
    return json({ ok: true, organizations, businesses });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const auth = await requireSessionActor(request, env, json);
    if ("error" in auth) return auth.error;
    const body: any = await request.json().catch(() => ({}));
    const type = String(body.type || "").trim();
    const name = String(body.name || "").trim();
    const slug = slugify(String(body.slug || name));
    if (!name) return json({ ok: false, error: "missing_name" }, 400);
    if (!slug) return json({ ok: false, error: "invalid_slug" }, 400);

    const sql = neon(String(env.DATABASE_URL));
    if (type === "organization") {
      const [created] = await sql/*sql*/`
        WITH new_org AS (
          INSERT INTO app.organizations (name, slug, created_by_user_id, updated_by_user_id)
          VALUES (${name}, ${slug}, ${auth.actor_user_id}, ${auth.actor_user_id})
          RETURNING organization_id, name, slug, status, created_at
        ), new_member AS (
          INSERT INTO app.organization_memberships (organization_id, user_id, role, active)
          SELECT organization_id, ${auth.actor_user_id}, 'owner', true FROM new_org
          ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role, active = true, updated_at = now()
        )
        SELECT * FROM new_org
      `;
      return json({ ok: true, organization: created });
    }

    if (type === "business") {
      const organizationId = String(body.organization_id || "").trim();
      if (!organizationId) return json({ ok: false, error: "missing_organization" }, 400);
      const [allowed] = await sql<{ ok: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM app.organization_memberships
          WHERE organization_id = ${organizationId}::uuid AND user_id = ${auth.actor_user_id} AND active = true AND role IN ('owner','admin','manager')
        ) AS ok
      `;
      if (!allowed?.ok) return json({ ok: false, error: "forbidden" }, 403);
      const [created] = await sql/*sql*/`
        WITH new_business AS (
          INSERT INTO app.businesses (organization_id, name, slug, created_by_user_id, updated_by_user_id)
          VALUES (${organizationId}::uuid, ${name}, ${slug}, ${auth.actor_user_id}, ${auth.actor_user_id})
          RETURNING business_id, organization_id, name, slug, status, created_at
        ), new_member AS (
          INSERT INTO app.business_memberships (business_id, user_id, role, active)
          SELECT business_id, ${auth.actor_user_id}, 'owner', true FROM new_business
          ON CONFLICT (business_id, user_id) DO UPDATE SET role = EXCLUDED.role, active = true, updated_at = now()
        )
        SELECT * FROM new_business
      `;
      return json({ ok: true, business: created });
    }
    return json({ ok: false, error: "invalid_type" }, 400);
  } catch (e: any) {
    const message = e?.message || String(e);
    if (message.includes("organizations_slug_key")) return json({ ok: false, error: "organization_slug_exists" }, 409);
    if (message.includes("businesses_org_slug_unique")) return json({ ok: false, error: "business_slug_exists" }, 409);
    return json({ ok: false, error: "server_error", message }, 500);
  }
};
