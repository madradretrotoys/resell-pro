import { neon } from "@neondatabase/serverless";
import { canManageTenantSettings, getTenantActor, requireSessionActor } from "../../../_shared/auth";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const DEFAULT_WEEK_STARTS_ON = 0;
const DEFAULT_STATE_CODE = "CA";
const DEFAULT_CONSECUTIVE_LUNCH_HOURS_REQUIRED = 5;
const DEFAULT_LUNCH_MINUTES = 30;

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
      SELECT
        t.week_starts_on,
        ts.state_code,
        ts.consecutive_lunch_hours_required,
        ts.default_lunch_minutes
      FROM app.tenants t
      LEFT JOIN app.tenant_settings ts
        ON ts.tenant_id = t.tenant_id
      WHERE t.tenant_id = ${tenant_id}::uuid
      LIMIT 1
    `;

    const row = rows?.[0] || {};
    return json({
      ok: true,
      week_starts_on: Number(row.week_starts_on ?? DEFAULT_WEEK_STARTS_ON),
      state_code: String(row.state_code || DEFAULT_STATE_CODE),
      consecutive_lunch_hours_required: Number(row.consecutive_lunch_hours_required ?? DEFAULT_CONSECUTIVE_LUNCH_HOURS_REQUIRED),
      default_lunch_minutes: Number(row.default_lunch_minutes ?? DEFAULT_LUNCH_MINUTES),
    });
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

    if ((body as any).week_starts_on !== undefined) {
      const week_starts_on = Number((body as any).week_starts_on);
      if (!Number.isFinite(week_starts_on) || week_starts_on < 0 || week_starts_on > 6) {
        return json({ ok: false, error: "bad_week_starts_on" }, 400);
      }
      await sql/*sql*/`
        UPDATE app.tenants
        SET week_starts_on = ${week_starts_on}
        WHERE tenant_id = ${tenant_id}::uuid
      `;
    }

    const hasTenantSettingsPayload =
      (body as any).state_code !== undefined ||
      (body as any).consecutive_lunch_hours_required !== undefined ||
      (body as any).default_lunch_minutes !== undefined;

    if (hasTenantSettingsPayload) {
      const state_code = String((body as any).state_code || DEFAULT_STATE_CODE).trim().toUpperCase();
      const consecutive_lunch_hours_required = Number((body as any).consecutive_lunch_hours_required ?? DEFAULT_CONSECUTIVE_LUNCH_HOURS_REQUIRED);
      const default_lunch_minutes = Number((body as any).default_lunch_minutes ?? DEFAULT_LUNCH_MINUTES);

      if (state_code.length < 2 || state_code.length > 3) return json({ ok: false, error: "bad_state_code" }, 400);
      if (!Number.isFinite(consecutive_lunch_hours_required) || consecutive_lunch_hours_required <= 0 || consecutive_lunch_hours_required > 24) {
        return json({ ok: false, error: "bad_consecutive_lunch_hours_required" }, 400);
      }
      if (!Number.isFinite(default_lunch_minutes) || default_lunch_minutes < 0 || default_lunch_minutes > 180) {
        return json({ ok: false, error: "bad_default_lunch_minutes" }, 400);
      }

      await sql/*sql*/`
        INSERT INTO app.tenant_settings (
          tenant_id,
          state_code,
          consecutive_lunch_hours_required,
          default_lunch_minutes,
          updated_by_user_id
        )
        VALUES (
          ${tenant_id}::uuid,
          ${state_code},
          ${consecutive_lunch_hours_required},
          ${default_lunch_minutes},
          ${auth.actor_user_id}::uuid
        )
        ON CONFLICT (tenant_id)
        DO UPDATE SET
          state_code = EXCLUDED.state_code,
          consecutive_lunch_hours_required = EXCLUDED.consecutive_lunch_hours_required,
          default_lunch_minutes = EXCLUDED.default_lunch_minutes,
          updated_by_user_id = ${auth.actor_user_id}::uuid,
          updated_at = now()
      `;
    }

    const rows = await sql/*sql*/`
      SELECT
        t.week_starts_on,
        ts.state_code,
        ts.consecutive_lunch_hours_required,
        ts.default_lunch_minutes
      FROM app.tenants t
      LEFT JOIN app.tenant_settings ts
        ON ts.tenant_id = t.tenant_id
      WHERE t.tenant_id = ${tenant_id}::uuid
      LIMIT 1
    `;

    const row = rows?.[0] || {};
    return json({
      ok: true,
      week_starts_on: Number(row.week_starts_on ?? DEFAULT_WEEK_STARTS_ON),
      state_code: String(row.state_code || DEFAULT_STATE_CODE),
      consecutive_lunch_hours_required: Number(row.consecutive_lunch_hours_required ?? DEFAULT_CONSECUTIVE_LUNCH_HOURS_REQUIRED),
      default_lunch_minutes: Number(row.default_lunch_minutes ?? DEFAULT_LUNCH_MINUTES),
    });
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
