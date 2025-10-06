export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const { sql, session } = await getAuthedCtx(env, request); // resolves tenant_id, user_id, role, permissions

  // server-side gate: needs can_settings true
  if (!session.permissions?.can_settings) {
    return json({ ok:false, error:'forbidden' }, 403);
  }

  // list users in tenant + memberships + permissions
  const rows = await sql/*sql*/`
    SELECT u.user_id, u.email, u.name, u.login_id,
           m.role, m.active,
           p.can_pos, p.can_cash_drawer, p.can_cash_payouts, p.can_item_research,
           p.can_inventory, p.can_inventory_intake, p.can_drop_off_form,
           p.can_estimates_buy_tickets, p.can_timekeeping, p.can_settings,
           p.notify_cash_drawer, p.notify_daily_sales_summary, p.discount_max
    FROM app.memberships m
    JOIN app.users u ON u.user_id = m.user_id
    LEFT JOIN app.permissions p ON p.user_id = u.user_id
    WHERE m.tenant_id = ${session.tenant_id}
    ORDER BY lower(u.name)
  `;
  return json({ ok:true, users: rows });
};
