import { json, error } from '../../_shared/http';
import { requireSession } from '../../_shared/auth';
import { db } from '../../_shared/db';

export async function onRequest({ request, env }: any) {
  const session = await requireSession({ request, env });
  const userId = session.user?.user_id;
  if (!userId) throw error(401, 'Unauthorized');

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit') || 30), 100);

  const membership = await db.oneOrNone(
    `
      select tenant_id
      from app.user_tenants
      where user_id = $1
      order by created_at asc
      limit 1
    `,
    [userId]
  );

  if (!membership?.tenant_id) throw error(403, 'No tenant membership');
  const tenantId = membership.tenant_id;

  const rows = await db.any(
    `
      select ledger_id, from_location, to_location, amount, notes, created_at
      from app.cash_ledger
      where tenant_id = $1
        and created_at >= now() - interval '30 days'
      order by created_at desc
      limit $2
    `,
    [tenantId, limit]
  );

  return json({ rows });
}
