import { neon } from "@neondatabase/serverless";
import { getTenantActor, requireSessionActor } from "../../../_shared/auth";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const auth = await requireSessionActor(request, env, json);
    if ("error" in auth) return auth.error;

    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) return json({ ok: false, error: "missing_tenant" }, 400);

    const sql = neon(String(env.DATABASE_URL));
    const actor = await getTenantActor(sql, tenant_id, auth.actor_user_id);

    if (!actor || actor.active === false) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const rows = await sql/*sql*/`
      SELECT
        drawer_id,
        tenant_id,
        drawer_name,
        drawer_code,
        location_name,
        currency_code,
        starting_float_default,
        is_active,
        created_at,
        updated_at
      FROM app.tenant_drawers
      WHERE tenant_id = ${tenant_id}
      ORDER BY is_active DESC, lower(drawer_name), drawer_id
    `;

    return json({ ok: true, drawers: rows });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
