import { neon } from "@neondatabase/serverless";
import { requireSessionActor } from "../../../_shared/auth";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export const onRequestPost: PagesFunction = async ({ request, env }) => {
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

    const body = await request.json().catch(() => ({} as any));
    const name = String((body as any).name || "").trim();
    const requestedSlug = String((body as any).slug || "").trim();
    const slug = slugify(requestedSlug || name);

    if (!name) return json({ ok: false, error: "missing_name" }, 400);
    if (!slug) return json({ ok: false, error: "invalid_slug" }, 400);

    const [created] = await sql/*sql*/`
      WITH new_tenant AS (
        INSERT INTO app.tenants (name, slug)
        VALUES (${name}, ${slug})
        RETURNING tenant_id, name, slug, created_at
      ), new_membership AS (
        INSERT INTO app.memberships (tenant_id, user_id, role, active)
        SELECT tenant_id, ${auth.actor_user_id}, 'owner', true
        FROM new_tenant
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, active = true
      ), new_settings AS (
        INSERT INTO app.tenant_settings (tenant_id, created_by_user_id, updated_by_user_id)
        SELECT tenant_id, ${auth.actor_user_id}, ${auth.actor_user_id}
        FROM new_tenant
        ON CONFLICT (tenant_id) DO NOTHING
      )
      SELECT tenant_id, name, slug, created_at
      FROM new_tenant
    `;

    return json({ ok: true, tenant: created });
  } catch (e: any) {
    const message = e?.message || String(e);
    if (message.includes("tenants_slug_key")) return json({ ok: false, error: "slug_exists" }, 409);
    return json({ ok: false, error: "server_error", message }, 500);
  }
};
