import { json, error } from '../../_shared/http';
import { requireSession } from '../../_shared/auth';
import { db } from '../../_shared/db';

export async function onRequest({ request, env }: any) {
  const session = await requireSession({ request, env });
  const userId = session.user?.user_id;
  if (!userId) throw error(401, 'Unauthorized');

  const url = new URL(request.url);
  const drawer = url.searchParams.get('drawer') || '1';
  const limit = Math.min(Number(url.searchParams.get('limit') || 30), 100);

  // Tenant from membership (same logic style as cash-ledger)
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
      select
        count_id,
        drawer,
        period,
        count_ts,
        pennies, nickels, dimes, quarters, halfdollars,
        ones, twos, fives, tens, twenties, fifties, hundreds,
        coin_total,
        bill_total,
        grand_total,
        notes
      from app.cash_drawer_counts
      where tenant_id = $1
        and drawer = $2
        and count_ts >= now() - interval '30 days'
      order by count_ts desc
      limit $3
    `,
    [tenantId, drawer, limit]
  );

  return json({ rows });
}
