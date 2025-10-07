export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const { sql, session } = await getAuthedCtx(env, request);
  if (!session.permissions?.can_settings) return json({ ok:false, error:'forbidden' }, 403);

  const body = await request.json();
  const user_id = String(body.user_id||'');
  // Flip current active flag
  const [row] = await sql/*sql*/`
    UPDATE app.memberships m
    SET active = NOT m.active
    WHERE m.tenant_id = ${session.tenant_id} AND m.user_id = ${user_id}
    RETURNING m.active
  `;
  if (!row) return json({ ok:false, error:'not_found' }, 404);
  return json({ ok:true, active: row.active });
};
