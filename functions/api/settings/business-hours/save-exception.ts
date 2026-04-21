import { neon } from "@neondatabase/serverless";
import { canManageTenantSettings, getTenantActor, requireSessionActor } from "../../../_shared/auth";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function normTime(v: any): string | null {
  const s = String(v || "").trim();
  if (!s) return null;
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(s)) return null;
  return s.length === 5 ? `${s}:00` : s;
}

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

    const body = await request.json().catch(() => ({}));
    const exception_date = String((body as any).exception_date || "").trim();
    const is_closed = (body as any).is_closed !== false;
    const open_time = normTime((body as any).open_time);
    const close_time = normTime((body as any).close_time);
    const reason = (body as any).reason ? String((body as any).reason).slice(0, 200) : null;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(exception_date)) {
      return json({ ok: false, error: "bad_exception_date" }, 400);
    }
    if (!is_closed && (!open_time || !close_time)) {
      return json({ ok: false, error: "open_and_close_required" }, 400);
    }

    const rows = await sql/*sql*/`
      INSERT INTO app.tenant_business_hour_exceptions (
        tenant_id,
        exception_date,
        is_closed,
        open_time,
        close_time,
        reason,
        updated_at
      )
      VALUES (
        ${tenant_id}::uuid,
        ${exception_date}::date,
        ${is_closed},
        ${is_closed ? null : open_time}::time,
        ${is_closed ? null : close_time}::time,
        ${reason},
        now()
      )
      ON CONFLICT (tenant_id, exception_date)
      DO UPDATE SET
        is_closed = EXCLUDED.is_closed,
        open_time = EXCLUDED.open_time,
        close_time = EXCLUDED.close_time,
        reason = EXCLUDED.reason,
        updated_at = now()
      RETURNING business_hour_exception_id, exception_date, is_closed, open_time, close_time, reason
    `;

    return json({ ok: true, exception: rows[0] });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
