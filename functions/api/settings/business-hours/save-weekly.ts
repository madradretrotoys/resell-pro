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
    const weekly = Array.isArray((body as any).weekly) ? (body as any).weekly : [];
    if (!weekly.length) return json({ ok: false, error: "weekly_required" }, 400);

    await sql/*sql*/`
      DELETE FROM app.tenant_business_hours
      WHERE tenant_id = ${tenant_id}::uuid
        AND effective_start_date IS NULL
        AND effective_end_date IS NULL
    `;

    for (const row of weekly) {
      const day_of_week = Number(row?.day_of_week);
      if (!Number.isFinite(day_of_week) || day_of_week < 0 || day_of_week > 6) {
        return json({ ok: false, error: "bad_day_of_week" }, 400);
      }

      const is_closed = !!row?.is_closed;
      const open_time = normTime(row?.open_time);
      const close_time = normTime(row?.close_time);
      if (!is_closed && (!open_time || !close_time)) {
        return json({ ok: false, error: "open_and_close_required" }, 400);
      }

      await sql/*sql*/`
        INSERT INTO app.tenant_business_hours (
          tenant_id,
          day_of_week,
          is_closed,
          open_time,
          close_time,
          effective_start_date,
          effective_end_date,
          updated_at
        )
        VALUES (
          ${tenant_id}::uuid,
          ${day_of_week},
          ${is_closed},
          ${is_closed ? null : open_time}::time,
          ${is_closed ? null : close_time}::time,
          null,
          null,
          now()
        )
      `;
    }

    return json({ ok: true });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
