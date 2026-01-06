// GET /api/cash-drawer/today?drawer=1
// Returns { open, close, expected_now_total, variance_now_total } (America/Denver)
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

    // 1) Load today's OPEN and CLOSE (count_id based)
    const rowsToday = await sql/*sql*/`
      SELECT *
      FROM app.cash_drawer_counts
      WHERE count_id IN (${ymd + "#" + drawer + "#OPEN"}, ${ymd + "#" + drawer + "#CLOSE"})
    `;

    const open = rowsToday.find((r: any) => r.period === "OPEN") || null;
    const closeToday = rowsToday.find((r: any) => r.period === "CLOSE") || null;

    // 2) Find the MOST RECENT count for this drawer (OPEN or CLOSE, any date)
    // Anchor = last counted truth for this drawer.
    const anchorRows = await sql/*sql*/`
      SELECT *
      FROM app.cash_drawer_counts
      WHERE drawer = ${Number(drawer)}
      ORDER BY
        COALESCE(count_ts, updated_at) DESC,
        count_id DESC
      LIMIT 1
    `;

    const anchor = anchorRows[0] || null;

    let expected_now_total: number | null = null;
    let variance_now_total: number | null = null;

    if (anchor) {
      const anchorTs = anchor.count_ts || anchor.updated_at;
      const anchorTotal = toMoney(anchor.grand_total);

      // 3) Sum ledger movements affecting this drawer AFTER the anchor timestamp
      const ledgerRows = await sql/*sql*/`
        SELECT
          COALESCE(SUM(CASE WHEN to_location = ${drawerLocation} THEN amount ELSE 0 END), 0) AS inflow,
          COALESCE(SUM(CASE WHEN from_location = ${drawerLocation} THEN amount ELSE 0 END), 0) AS outflow
        FROM app.cash_ledger
        WHERE created_at > ${anchorTs}
          AND (from_location = ${drawerLocation} OR to_location = ${drawerLocation})
      `;

      const inflow = toMoney(ledgerRows?.[0]?.inflow);
      const outflow = toMoney(ledgerRows?.[0]?.outflow);

      expected_now_total = toMoney(anchorTotal + inflow - outflow);

      // 4) Variance logic:
      // - If CLOSE exists today, compare CLOSE vs expected_now_total
      // - Else if OPEN exists today, compare OPEN vs expected_at_open (which is expected_now_total
      //   only if anchor == last close/prev count, but we keep it simple for Phase 1)
      if (closeToday) {
        variance_now_total = toMoney(toMoney(closeToday.grand_total) - expected_now_total);
      } else if (open) {
        // If user is opening, compare OPEN to expected based on prior anchor snapshot
        // (If the anchor itself is the open, this will evaluate to ~0)
        variance_now_total = toMoney(toMoney(open.grand_total) - expected_now_total);
      }
    }

    return json({
      date: ymd,
      drawer,
      open,
      close: closeToday,
      expected_now_total,
      variance_now_total,
      _debug: {
        drawerLocation,
        anchor_count_id: anchor?.count_id || null,
        anchor_period: anchor?.period || null,
        anchor_ts: anchor?.count_ts || null,
        anchor_updated_at: anchor?.updated_at || null,
      },
    });
  } catch (e: any) {
    return json({ error: e?.message || "load_failed" }, 500);
  }
};
