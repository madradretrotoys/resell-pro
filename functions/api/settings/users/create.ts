export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const { sql, session } = await getAuthedCtx(env, request);
  if (!session.permissions?.can_settings) return json({ ok:false, error:'forbidden' }, 403);

  const body = await request.json();
  const name = String(body.name||'').trim();
  const email = String(body.email||'').trim().toLowerCase();
  const login_id = String(body.login_id||'').trim();
  const role = String(body.role||'clerk').toLowerCase() as 'owner'|'admin'|'manager'|'clerk';

  // Role gate
  const actorRole = session.membership_role; // 'owner' | 'admin' | 'manager' | 'clerk'
  const allowed = (actorRole === 'owner') ||
                  (actorRole === 'admin'   && ['manager','clerk'].includes(role)) ||
                  (actorRole === 'manager' && role === 'clerk');
  if (!allowed) return json({ ok:false, error:'insufficient_role' }, 403);

  // Create user
  const [u] = await sql/*sql*/`
    INSERT INTO app.users (email, name, login_id)
    VALUES (${email}, ${name}, ${login_id})
    ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, login_id=EXCLUDED.login_id
    RETURNING user_id, email, name, login_id
  `;

  // Link to tenant with role + active=true
  await sql/*sql*/`
    INSERT INTO app.memberships (tenant_id, user_id, role, active)
    VALUES (${session.tenant_id}, ${u.user_id}, ${role}, true)
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET role=EXCLUDED.role, active=true
  `;

  // Permissions (defaults or from payload)
  const perms = body.permissions || {};
  const notes = body.notifications || {};
  const discount_max = (body.discount_max === null || body.discount_max === '' ? null : Number(body.discount_max));

  await sql/*sql*/`
    INSERT INTO app.permissions (user_id, name, email, role,
      can_pos, can_cash_drawer, can_cash_payouts, can_item_research,
      can_inventory, can_inventory_intake, can_drop_off_form,
      can_estimates_buy_tickets, can_timekeeping, can_settings,
      notify_cash_drawer, notify_daily_sales_summary, discount_max
    )
    VALUES (
      ${u.user_id}, ${name}, ${email}, ${role},
      ${!!perms.can_pos}, ${!!perms.can_cash_drawer}, ${!!perms.can_cash_payouts}, ${!!perms.can_item_research},
      ${!!perms.can_inventory}, ${!!perms.can_inventory_intake}, ${!!perms.can_drop_off_form},
      ${!!perms.can_estimates_buy_tickets}, ${!!perms.can_timekeeping}, ${!!perms.can_settings},
      ${!!notes.notify_cash_drawer}, ${!!notes.notify_daily_sales_summary}, ${discount_max}
    )
    ON CONFLICT (user_id) DO UPDATE SET
      name=EXCLUDED.name, email=EXCLUDED.email, role=EXCLUDED.role,
      can_pos=EXCLUDED.can_pos, can_cash_drawer=EXCLUDED.can_cash_drawer, can_cash_payouts=EXCLUDED.can_cash_payouts,
      can_item_research=EXCLUDED.can_item_research, can_inventory=EXCLUDED.can_inventory,
      can_inventory_intake=EXCLUDED.can_inventory_intake, can_drop_off_form=EXCLUDED.can_drop_off_form,
      can_estimates_buy_tickets=EXCLUDED.can_estimates_buy_tickets, can_timekeeping=EXCLUDED.can_timekeeping,
      can_settings=EXCLUDED.can_settings, notify_cash_drawer=EXCLUDED.notify_cash_drawer,
      notify_daily_sales_summary=EXCLUDED.notify_daily_sales_summary, discount_max=EXCLUDED.discount_max,
      updated_at=now()
  `;

  return json({ ok:true, user_id: u.user_id });
};
