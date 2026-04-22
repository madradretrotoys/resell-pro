import { neon } from "@neondatabase/serverless";
import { canManageTenantSettings, getTenantActor, requireSessionActor } from "../../../_shared/auth";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const auth = await requireSessionActor(request, env, json);
    if ("error" in auth) return auth.error;

    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) return json({ ok: false, error: "missing_tenant" }, 400);

    const body = await request.json().catch(() => ({}));
    const drawer_id = String((body as any).drawer_id || "").trim();
    const is_active = Boolean((body as any).is_active);
    if (!drawer_id) return json({ ok: false, error: "drawer_id_required" }, 400);

    const sql = neon(String(env.DATABASE_URL));
    const actor = await getTenantActor(sql, tenant_id, auth.actor_user_id);

    if (!actor || actor.active === false || !canManageTenantSettings(actor)) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const rows = await sql/*sql*/`
      UPDATE app.tenant_drawers
      SET
        is_active = ${is_active},
        updated_at = now(),
        updated_by_user_id = ${auth.actor_user_id}
      WHERE tenant_id = ${tenant_id}
        AND drawer_id = ${drawer_id}::uuid
      RETURNING drawer_id, drawer_name, is_active
    `;

    if (!rows.length) return json({ ok: false, error: "not_found" }, 404);
    return json({ ok: true, drawer: rows[0] });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
