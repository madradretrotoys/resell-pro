import { json, error } from '../../_shared/http';
import { requireSession } from '../../_shared/auth';
import { db } from '../../_shared/db';

export async function onRequest({ request, env }: any) {
  const session = await requireSession({ request, env });
  const userId = session.user?.user_id;
  if (!userId) throw error(401, 'Unauthorized');

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

  const row = await db.oneOrNone(
    `
      select safe_count_id, period, amount, notes, count_date
      from app.cash_safe_counts
      where tenant_id = $1
        and count_date::date = current_date
      order by count_date desc
      limit 1
    `,
    [tenantId]
  );

  return json({ row });
}
