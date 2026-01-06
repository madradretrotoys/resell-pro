// POST /api/cash-safe/save
// Body: { period: 'OPEN'|'CLOSE', amount: number, notes?: string|null }
// Writes into app.cash_safe_counts
// Duplicate protection is enforced by unique index on (tenant_id, count_date, period)

import { neon } from "@neondatabase/serverless";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

function toMoney(n: any) {
  const x = Number(n);
  if (!Number.isFinite(x)) return NaN;
  return Math.round(x * 100) / 100;
}

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) return json({ error: "missing_tenant" }, 400);

    const body = await request.json().catch(() => ({}));

    const periodRaw = String(body.period || "").trim().toUpperCase();
    const period = periodRaw === "OPEN" ? "OPEN" : periodRaw === "CLOSE" ? "CLOSE" : "";
    if (!period) return json({ error: "invalid_period" }, 400);

    const amount = toMoney(body.amount);
    if (!Number.isFinite(amount) || amount < 0) return json({ error: "invalid_amount" }, 400);

    const notes = body.notes ? String(body.notes).slice(0, 2000) : null;

    // Optional user_id — ONLY if your frontend sends it (most likely it does not yet)
    // This avoids any session/libs and will not break builds.
    const user_id = body.user_id ? String(body.user_id) : null;

    const sql = neon(env.DATABASE_URL);

    // Insert — rely on unique constraint to prevent duplicates per day/period
    // count_date defaults to CURRENT_DATE in the table
    const rows = await sql/*sql*/`
      INSERT INTO app.cash_safe_counts
        (tenant_id, user_id, period, amount, notes)
      VALUES
        (${tenant_id}::uuid, ${user_id}::uuid, ${period}, ${amount}, ${notes})
      RETURNING safe_count_id, tenant_id, count_date, period, amount
    `;

    const row = rows[0];

    return json({
      ok: true,
      safe_count_id: row.safe_count_id,
      tenant_id: row.tenant_id,
      count_date: row.count_date,
      period: row.period,
      amount: row.amount,
    });

  } catch (e: any) {
    const msg = String(e?.message || "");

    // Unique constraint violation: already saved today for this tenant+period
    if (msg.toLowerCase().includes("duplicate key") || e?.code === "23505") {
      return json({ error: "already_saved_today" }, 409);
    }

    return json({ error: msg || "save_failed" }, 500);
  }
};
