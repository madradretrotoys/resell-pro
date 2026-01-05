// GET /api/cash-drawer/today?drawer=1
// Snapshot-driven:
// - Finds the most recent cash_drawer_counts row for this drawer (any period, any date)
// - Computes expected_now_total = last_count.grand_total + net ledger movements since last_count.created_at
// - Returns open/close rows for today too (for UI convenience)

import { neon } from "@neondatabase/serverless";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function todayKeyTZ(tz = "America/Denver") {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(d)
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {} as any);

  return `${parts.year}-${parts.month}-${parts.day}`; // YYYY-MM-DD
}

function toMoney(n: any) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const url = new URL(request.url);
    const drawer = String(url.searchParams.get("drawer") || "1");
    const tz = "America/Denver";

    const ymd = todayKeyTZ(tz);
    const drawerLocation = `Drawer ${drawer}`;

    const sql = neon(env.DATABASE_URL);

    // 1) Load today's OPEN and CLOSE (for existing UI)
    const rowsToday = await sql/*sql*/`
      SELECT *
      FROM app.cash_drawer_counts
      WHERE count_id IN (${ymd + "#" + drawer + "#OPEN"}, ${ymd + "#" + drawer + "#CLOSE"})
    `;

    const open = rowsToday.find((r: any) => r.period === "OPEN") || null;
    const close = rowsToday.find((r: any) => r.period === "CLOSE") || null;

    // 2) Find the most recent snapshot count for this drawer (any period)
    // This is our baseline for expected "now"
    const lastCountRows = await sql/*sql*/`
      SELECT *
      FROM app.cash_drawer_counts
      WHERE drawer = ${drawer}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const last_count = lastCountRows[0] || null;

    let expected_now_total: number | null = null;
    let net_since_last_count: number | null = null;

    // Optional: variance vs "current count" (if a count exists today for selected period)
    // We'll compute variance against today's OPEN if present; otherwise against today's CLOSE if present.
    const current_count = open || close || null;
    let variance_now_total: number | null = null;

    if (last_count) {
      const baselineTotal = toMoney(last_count.grand_total);
      const baselineTs = last_count.created_at;

      // 3) Net ledger movements affecting this drawer AFTER baseline snapshot
      // Net = inflow - outflow
      const ledgerRows = await sql/*sql*/`
        SELECT
          COALESCE(SUM(CASE WHEN to_location = ${drawerLocation} THEN amount ELSE 0 END), 0) AS inflow,
          COALESCE(SUM(CASE WHEN from_location = ${drawerLocation} THEN amount ELSE 0 END), 0) AS outflow
        FROM app.cash_ledger
        WHERE created_at > ${baselineTs}
          AND (from_location = ${drawerLocation} OR to_location = ${drawerLocation})
      `;

      const inflow = toMoney(ledgerRows?.[0]?.inflow);
      const outflow = toMoney(ledgerRows?.[0]?.outflow);

      net_since_last_count = toMoney(inflow - outflow);
      expected_now_total = toMoney(baselineTotal + net_since_last_count);

      if (current_count) {
        const currentTotal = toMoney(current_count.grand_total);
        variance_now_total = toMoney(currentTotal - expected_now_total);
      }
    }

    return json({
      date: ymd,
      drawer,

      // Existing UI support
      open,
      close,

      // Snapshot-driven expected state
      last_count,
      expected_now_total,
      net_since_last_count,
      variance_now_total,

      // Debug helpers (keep during Phase 1)
      _debug: {
        drawerLocation,
        last_count_id: last_count?.count_id || null,
        last_count_period: last_count?.period || null,
        last_count_created_at: last_count?.created_at || null,
        current_count_id: current_count?.count_id || null,
      },
    });
  } catch (e: any) {
    return json({ error: e?.message || "load_failed" }, 500);
  }
};
