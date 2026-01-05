// GET /api/cash-drawer/today?drawer=1
// Returns { open, close, expected_open_total, variance_open_total } (America/Denver)
import { neon } from "@neondatabase/serverless";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function ymdKeyTZ(date: Date, tz = "America/Denver") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(date)
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {} as any);

  return `${parts.year}-${parts.month}-${parts.day}`; // YYYY-MM-DD
}

function todayKeyTZ(tz = "America/Denver") {
  return ymdKeyTZ(new Date(), tz);
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

    // 1) Load today's OPEN and CLOSE (same as before)
    const rowsToday = await sql/*sql*/`
      SELECT *
      FROM app.cash_drawer_counts
      WHERE count_id IN (${ymd + "#" + drawer + "#OPEN"}, ${ymd + "#" + drawer + "#CLOSE"})
    `;

    const open = rowsToday.find((r: any) => r.period === "OPEN") || null;
    const closeToday = rowsToday.find((r: any) => r.period === "CLOSE") || null;

    // 2) Find the most recent CLOSE record for this drawer (before today)
    const lastCloseRows = await sql/*sql*/`
      SELECT *
      FROM app.cash_drawer_counts
      WHERE drawer = ${Number(drawer)}
        AND period = 'CLOSE'
        AND count_id < ${ymd + "#" + drawer + "#OPEN"}
      ORDER BY count_id DESC
      LIMIT 1
    `;

    const lastClose = lastCloseRows[0] || null;

    // If no prior close exists, expected_open_total can't be computed
    let expected_open_total: number | null = null;
    let variance_open_total: number | null = null;

    if (lastClose) {
      // ✅ FIX: cash_drawer_counts does not have created_at
      // Use count_ts if available, otherwise updated_at
      const closeTs = lastClose.count_ts || lastClose.updated_at;

      // 3) Sum ledger movements affecting this drawer AFTER the last close timestamp
      // Net = inflows - outflows
      const ledgerRows = await sql/*sql*/`
        SELECT
          COALESCE(SUM(CASE WHEN to_location = ${drawerLocation} THEN amount ELSE 0 END), 0) AS inflow,
          COALESCE(SUM(CASE WHEN from_location = ${drawerLocation} THEN amount ELSE 0 END), 0) AS outflow
        FROM app.cash_ledger
        WHERE created_at > ${closeTs}
          AND (from_location = ${drawerLocation} OR to_location = ${drawerLocation})
      `;

      const inflow = toMoney(ledgerRows?.[0]?.inflow);
      const outflow = toMoney(ledgerRows?.[0]?.outflow);

      const closeTotal = toMoney(lastClose.grand_total);
      expected_open_total = toMoney(closeTotal + inflow - outflow);

      if (open) {
        const openTotal = toMoney(open.grand_total);
        variance_open_total = toMoney(openTotal - expected_open_total);
      }
    }

    return json({
      date: ymd,
      drawer,
      open,
      close: closeToday,
      expected_open_total,
      variance_open_total,
      _debug: {
        drawerLocation,
        last_close_count_id: lastClose?.count_id || null,
        last_close_ts: lastClose?.count_ts || null,
        last_close_updated_at: lastClose?.updated_at || null,
      },
    });
  } catch (e: any) {
    return json({ error: e?.message || "load_failed" }, 500);
  }
};
