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

    const body = await request.json().catch(() => ({}));
    const schedule_id = String((body as any).schedule_id || "").trim() || null;
    const user_id = String((body as any).user_id || "").trim();
    const shift_start_at = String((body as any).shift_start_at || "").trim();
    const shift_end_at = String((body as any).shift_end_at || "").trim();
    const break_minutes = Number((body as any).break_minutes ?? 0);
    const static_schedule = !!(body as any).static_schedule;
    const status = String((body as any).status || "draft").trim().toLowerCase();
    const preferred_drawer_id = String((body as any).preferred_drawer_id || "").trim() || null;
    const notes = (body as any).notes ? String((body as any).notes).slice(0, 2000) : null;

    if (!user_id) return json({ ok: false, error: "user_id_required" }, 400);
    if (!shift_start_at || !shift_end_at) return json({ ok: false, error: "shift_times_required" }, 400);
    if (!Number.isFinite(break_minutes) || break_minutes < 0) return json({ ok: false, error: "bad_break_minutes" }, 400);

    const startMs = Date.parse(shift_start_at);
    const endMs = Date.parse(shift_end_at);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return json({ ok: false, error: "bad_shift_times" }, 400);
    }
    if (endMs <= startMs) return json({ ok: false, error: "end_must_be_after_start" }, 400);

    const durationMinutes = (endMs - startMs) / 60000;
    if (durationMinutes > 24 * 60) {
      return json({ ok: false, error: "shift_too_long_single_day_only" }, 400);
    }
    if (break_minutes > durationMinutes) {
      return json({ ok: false, error: "lunch_exceeds_shift" }, 400);
    }

    const overlap = await sql/*sql*/`
      SELECT schedule_id
      FROM app.employee_schedules
      WHERE tenant_id = ${tenant_id}::uuid
        AND user_id = ${user_id}::uuid
        AND shift_start_at < ${shift_end_at}::timestamptz
        AND shift_end_at > ${shift_start_at}::timestamptz
        AND (${schedule_id}::uuid IS NULL OR schedule_id <> ${schedule_id}::uuid)
      LIMIT 1
    `;

    if (overlap.length) {
      return json({ ok: false, error: "overlap" }, 409);
    }

    if (schedule_id) {
      const updated = await sql/*sql*/`
        UPDATE app.employee_schedules
        SET
          user_id = ${user_id}::uuid,
          shift_start_at = ${shift_start_at}::timestamptz,
          shift_end_at = ${shift_end_at}::timestamptz,
          business_date = (${shift_start_at}::timestamptz AT TIME ZONE 'UTC')::date,
          break_minutes = ${break_minutes},
          static_schedule = ${static_schedule},
          status = ${status},
          preferred_drawer_id = ${preferred_drawer_id}::uuid,
          notes = ${notes},
          updated_by_user_id = ${auth.actor_user_id}::uuid,
          updated_at = now()
        WHERE schedule_id = ${schedule_id}::uuid
          AND tenant_id = ${tenant_id}::uuid
        RETURNING schedule_id
      `;
      if (!updated.length) return json({ ok: false, error: "not_found" }, 404);
      return json({ ok: true, schedule_id: updated[0].schedule_id, updated: true });
    }

    const inserted = await sql/*sql*/`
      INSERT INTO app.employee_schedules (
        tenant_id,
        user_id,
        business_date,
        shift_start_at,
        shift_end_at,
        break_minutes,
        static_schedule,
        status,
        preferred_drawer_id,
        notes,
        created_by_user_id,
        updated_by_user_id
      )
      VALUES (
        ${tenant_id}::uuid,
        ${user_id}::uuid,
        (${shift_start_at}::timestamptz AT TIME ZONE 'UTC')::date,
        ${shift_start_at}::timestamptz,
        ${shift_end_at}::timestamptz,
        ${break_minutes},
        ${static_schedule},
        ${status},
        ${preferred_drawer_id}::uuid,
        ${notes},
        ${auth.actor_user_id}::uuid,
        ${auth.actor_user_id}::uuid
      )
      RETURNING schedule_id
    `;

    return json({ ok: true, schedule_id: inserted[0].schedule_id, inserted: true });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
