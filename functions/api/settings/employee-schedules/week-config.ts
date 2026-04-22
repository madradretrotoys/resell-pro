import { neon } from "@neondatabase/serverless";
import { canManageTenantSettings, getTenantActor, requireSessionActor } from "../../../_shared/auth";

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
    if (!actor || actor.active === false || !canManageTenantSettings(actor)) return json({ ok: false, error: "forbidden" }, 403);

    const rows = await sql/*sql*/`
      SELECT week_starts_on
      FROM app.tenants
      WHERE tenant_id = ${tenant_id}::uuid
      LIMIT 1
    `;

    return json({ ok: true, week_starts_on: Number(rows?.[0]?.week_starts_on ?? 0) });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const auth = await requireSessionActor(request, env, json);
    if ("error" in auth) return auth.error;
    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) return json({ ok: false, error: "missing_tenant" }, 400);

    const sql = neon(String(env.DATABASE_URL));
    const actor = await getTenantActor(sql, tenant_id, auth.actor_user_id);
    if (!actor || actor.active === false || !canManageTenantSettings(actor)) return json({ ok: false, error: "forbidden" }, 403);

    const body = await request.json().catch(() => ({}));
    const week_starts_on = Number((body as any).week_starts_on);
    if (!Number.isFinite(week_starts_on) || week_starts_on < 0 || week_starts_on > 6) {
      return json({ ok: false, error: "bad_week_starts_on" }, 400);
    }

    await sql/*sql*/`
      UPDATE app.tenants
      SET week_starts_on = ${week_starts_on}
      WHERE tenant_id = ${tenant_id}::uuid
    `;

    return json({ ok: true, week_starts_on });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
