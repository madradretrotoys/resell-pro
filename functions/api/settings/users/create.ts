import { neon } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";
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
    const name = String((body as any).name || "").trim();
    const email = String((body as any).email || "").trim().toLowerCase();
    const login_id = String((body as any).login_id || "").trim();
    const temp_password = String((body as any).temp_password || "").trim();
    const role = String((body as any).role || "clerk").trim().toLowerCase() as "owner" | "admin" | "manager" | "clerk";

    if (!name || !email || !login_id) return json({ ok: false, error: "missing_required_fields" }, 400);
    if (!["owner", "admin", "manager", "clerk"].includes(role)) return json({ ok: false, error: "invalid_role" }, 400);

    // Role gate: owner can create any role, admin can create manager/clerk, manager can create clerk.
    const actorRole = actor.role;
    const allowed =
      actorRole === "owner" ||
      (actorRole === "admin" && ["manager", "clerk"].includes(role)) ||
      (actorRole === "manager" && role === "clerk");
    if (!allowed) return json({ ok: false, error: "insufficient_role" }, 403);

    const generatedPassword = temp_password || crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const password_hash = await bcrypt.hash(generatedPassword, 10);

    const [u] = await sql/*sql*/`
      INSERT INTO app.users (email, name, login_id, password_hash, is_active)
      VALUES (${email}, ${name}, ${login_id}, ${password_hash}, true)
      ON CONFLICT (email) DO UPDATE SET
        name=EXCLUDED.name,
        login_id=EXCLUDED.login_id,
        is_active=true
      RETURNING user_id, email, name, login_id
    `;

    await sql/*sql*/`
      INSERT INTO app.memberships (tenant_id, user_id, role, active)
      VALUES (${tenant_id}, ${u.user_id}, ${role}, true)
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET
        role=EXCLUDED.role,
        active=true
    `;

    const perms = (body as any).permissions || {};
    const notes = (body as any).notifications || {};
    const discount_max = ((body as any).discount_max === null || (body as any).discount_max === "")
      ? null
      : Number((body as any).discount_max);

    await sql/*sql*/`
      INSERT INTO app.permissions (
        user_id, name, email, role,
        can_pos, can_cash_drawer, can_cash_payouts, can_item_research,
        can_inventory, can_inventory_intake, can_drop_off_form,
        can_estimates_buy_tickets, can_timekeeping, clockin_required, can_settings,
        notify_cash_drawer, notify_daily_sales_summary, discount_max
      )
      VALUES (
        ${u.user_id}, ${name}, ${email}, ${role},
        ${!!perms.can_pos}, ${!!perms.can_cash_drawer}, ${!!perms.can_cash_payouts}, ${!!perms.can_item_research},
        ${!!perms.can_inventory}, ${!!perms.can_inventory_intake}, ${!!perms.can_drop_off_form},
        ${!!perms.can_estimates_buy_tickets}, ${!!perms.can_timekeeping}, ${!!perms.clockin_required}, ${!!perms.can_settings},
        ${!!notes.notify_cash_drawer}, ${!!notes.notify_daily_sales_summary}, ${discount_max}
      )
      ON CONFLICT (user_id) DO UPDATE SET
        name=EXCLUDED.name,
        email=EXCLUDED.email,
        role=EXCLUDED.role,
        can_pos=EXCLUDED.can_pos,
        can_cash_drawer=EXCLUDED.can_cash_drawer,
        can_cash_payouts=EXCLUDED.can_cash_payouts,
        can_item_research=EXCLUDED.can_item_research,
        can_inventory=EXCLUDED.can_inventory,
        can_inventory_intake=EXCLUDED.can_inventory_intake,
        can_drop_off_form=EXCLUDED.can_drop_off_form,
        can_estimates_buy_tickets=EXCLUDED.can_estimates_buy_tickets,
        can_timekeeping=EXCLUDED.can_timekeeping,
        clockin_required=EXCLUDED.clockin_required,
        can_settings=EXCLUDED.can_settings,
        notify_cash_drawer=EXCLUDED.notify_cash_drawer,
        notify_daily_sales_summary=EXCLUDED.notify_daily_sales_summary,
        discount_max=EXCLUDED.discount_max,
        updated_at=now()
    `;

    return json({ ok: true, user_id: u.user_id, temp_password_generated: !temp_password });
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
