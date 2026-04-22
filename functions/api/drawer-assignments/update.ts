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
    const assignment_id = String((body as any).assignment_id || "").trim();
    const starts_at = (body as any).starts_at ? String((body as any).starts_at) : null;
    const ends_at = (body as any).ends_at ? String((body as any).ends_at) : null;
    const status = (body as any).status ? String((body as any).status).trim().toLowerCase() : null;
    const notes = (body as any).notes != null ? String((body as any).notes).slice(0, 2000) : null;

    if (!assignment_id) return json({ ok: false, error: "assignment_id_required" }, 400);

    const sql = neon(String(env.DATABASE_URL));
    const actor = await getTenantActor(sql, tenant_id, auth.actor_user_id);

    if (!actor || actor.active === false || !canManageTenantSettings(actor)) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const rows = await sql/*sql*/`
      UPDATE app.drawer_assignments
      SET
        starts_at = COALESCE(${starts_at}::timestamptz, starts_at),
        ends_at = COALESCE(${ends_at}::timestamptz, ends_at),
        status = COALESCE(${status}, status),
        notes = COALESCE(${notes}, notes),
        closed_by_user_id = CASE WHEN COALESCE(${status}, status) = 'closed' THEN ${auth.actor_user_id}::uuid ELSE closed_by_user_id END,
        updated_at = now()
      WHERE assignment_id = ${assignment_id}::uuid
        AND tenant_id = ${tenant_id}::uuid
      RETURNING assignment_id, drawer_id, user_id, business_date, starts_at, ends_at, status, notes
    `;

    if (!rows.length) return json({ ok: false, error: "not_found" }, 404);
    return json({ ok: true, assignment: rows[0] });
  } catch (e: any) {
    if (String(e?.message || "").includes("ux_drawer_assignments_active_drawer")) {
      return json({ ok: false, error: "drawer_already_active" }, 409);
    }
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
