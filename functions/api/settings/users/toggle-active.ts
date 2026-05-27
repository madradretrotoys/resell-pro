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

    const sql = neon(String(env.DATABASE_URL));
    const actor = await getTenantActor(sql, tenant_id, auth.actor_user_id);
    if (!actor || actor.active === false || !canManageTenantSettings(actor)) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const body = await request.json().catch(() => ({} as any));
    const user_id = String((body as any).user_id || "").trim();
    if (!user_id) return json({ ok: false, error: "missing_user_id" }, 400);

    const [row] = await sql/*sql*/`
      UPDATE app.memberships m
      SET active = NOT m.active
      WHERE m.tenant_id = ${tenant_id} AND m.user_id = ${user_id}
      RETURNING m.active
    `;
    if (!row) return json({ ok: false, error: "not_found" }, 404);

    return json({ ok: true, active: !!row.active });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
