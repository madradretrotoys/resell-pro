import { neon } from "@neondatabase/serverless";
import { canManageTenantSettings, getTenantActor, requireSessionActor } from "../../_shared/auth";

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
    const user_id = String((body as any).user_id || "").trim();
    const business_date = String((body as any).business_date || "").trim();
    const starts_at = (body as any).starts_at ? String((body as any).starts_at) : null;
    const ends_at = (body as any).ends_at ? String((body as any).ends_at) : null;
    const status = String((body as any).status || "scheduled").trim().toLowerCase();
    const notes = (body as any).notes ? String((body as any).notes).slice(0, 2000) : null;

    if (!drawer_id) return json({ ok: false, error: "drawer_id_required" }, 400);
    if (!user_id) return json({ ok: false, error: "user_id_required" }, 400);
    if (!business_date || !/^\d{4}-\d{2}-\d{2}$/.test(business_date)) {
      return json({ ok: false, error: "business_date_required" }, 400);
    }

    const sql = neon(String(env.DATABASE_URL));
    const actor = await getTenantActor(sql, tenant_id, auth.actor_user_id);

    if (!actor || actor.active === false || !canManageTenantSettings(actor)) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const rows = await sql/*sql*/`
      INSERT INTO app.drawer_assignments (
        tenant_id, drawer_id, user_id, business_date, starts_at, ends_at, status, notes, assigned_by_user_id
      ) VALUES (
        ${tenant_id}::uuid,
        ${drawer_id}::uuid,
        ${user_id}::uuid,
        ${business_date}::date,
        ${starts_at}::timestamptz,
        ${ends_at}::timestamptz,
        ${status},
        ${notes},
        ${auth.actor_user_id}::uuid
      )
      RETURNING assignment_id, drawer_id, user_id, business_date, starts_at, ends_at, status, notes
    `;

    return json({ ok: true, assignment: rows[0] });
  } catch (e: any) {
    if (String(e?.message || "").includes("ux_drawer_assignments_active_drawer")) {
      return json({ ok: false, error: "drawer_already_active" }, 409);
    }
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
