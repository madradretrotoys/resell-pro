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
    if (user_id === auth.actor_user_id) return json({ ok: false, error: "cannot_delete_self" }, 400);

    const targetMembership = await sql<{ role: string; active: boolean }[]>`
      SELECT role, active
      FROM app.memberships
      WHERE tenant_id = ${tenant_id} AND user_id = ${user_id}
      LIMIT 1
    `;
    if (!targetMembership.length) return json({ ok: false, error: "not_found" }, 404);

    const targetRole = String(targetMembership[0].role || "").toLowerCase();
    const actorRole = String(actor.role || "").toLowerCase();
    const canDelete =
      actorRole === "owner" ||
      (actorRole === "admin" && ["manager", "clerk"].includes(targetRole)) ||
      (actorRole === "manager" && targetRole === "clerk");
    if (!canDelete) return json({ ok: false, error: "insufficient_role" }, 403);

    await sql`DELETE FROM app.memberships WHERE tenant_id = ${tenant_id} AND user_id = ${user_id}`;
    await sql`DELETE FROM app.permissions WHERE user_id = ${user_id}`;

    const membershipsLeft = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM app.memberships WHERE user_id = ${user_id}
    `;
    if ((membershipsLeft[0]?.n || 0) === 0) {
      await sql`DELETE FROM app.users WHERE user_id = ${user_id}`;
    }

    return json({ ok: true });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
