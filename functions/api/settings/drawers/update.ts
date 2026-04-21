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
    const drawer_name = String((body as any).drawer_name || "").trim();
    const drawer_code_raw = String((body as any).drawer_code || "").trim();
    const location_name = String((body as any).location_name || "").trim() || null;
    const currency_code = String((body as any).currency_code || "USD").trim().toUpperCase();
    const starting_float_default = Number((body as any).starting_float_default ?? 0);

    if (!drawer_id) return json({ ok: false, error: "drawer_id_required" }, 400);
    if (!drawer_name) return json({ ok: false, error: "drawer_name_required" }, 400);
    if (!Number.isFinite(starting_float_default) || starting_float_default < 0) {
      return json({ ok: false, error: "bad_starting_float_default" }, 400);
    }

    const drawer_code = drawer_code_raw || null;

    const sql = neon(String(env.DATABASE_URL));
    const actor = await getTenantActor(sql, tenant_id, auth.actor_user_id);

    if (!actor || actor.active === false || !canManageTenantSettings(actor)) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const rows = await sql/*sql*/`
      UPDATE app.tenant_drawers
      SET
        drawer_name = ${drawer_name},
        drawer_code = ${drawer_code},
        location_name = ${location_name},
        currency_code = ${currency_code},
        starting_float_default = ${starting_float_default},
        updated_at = now(),
        updated_by_user_id = ${auth.actor_user_id}
      WHERE tenant_id = ${tenant_id}
        AND drawer_id = ${drawer_id}::uuid
      RETURNING drawer_id, drawer_name, drawer_code, location_name, currency_code, starting_float_default, is_active
    `;

    if (!rows.length) return json({ ok: false, error: "not_found" }, 404);
    return json({ ok: true, drawer: rows[0] });
  } catch (e: any) {
    if (String(e?.message || "").includes("ux_tenant_drawers_tenant_name")) {
      return json({ ok: false, error: "drawer_name_exists" }, 409);
    }
    if (String(e?.message || "").includes("ux_tenant_drawers_tenant_code")) {
      return json({ ok: false, error: "drawer_code_exists" }, 409);
    }
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
