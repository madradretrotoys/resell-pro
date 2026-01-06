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

    // Evaluate the MOST RECENT saved count against the PREVIOUS saved count + ledger between them.
    // This is the canonical "needs review" signal for managers.
    const latestRows = await sql/*sql*/`
      SELECT *
      FROM app.cash_drawer_counts
      WHERE drawer = ${Number(drawer)}
      ORDER BY
        COALESCE(count_ts, updated_at) DESC,
        count_id DESC
      LIMIT 2
    `;

    const latest = latestRows[0] || null;
    const prev = latestRows[1] || null;

    let expected_at_latest: number | null = null;
    let variance_at_latest: number | null = null;
    let review_status: "balanced" | "needs_review" | null = null;

    if (latest && prev) {
      const prevTs = prev.count_ts || prev.updated_at;
      const prevTotal = toMoney(prev.grand_total);

      const ledgerRows = await sql/*sql*/`
        SELECT
          COALESCE(SUM(CASE WHEN to_location = ${drawerLocation} THEN amount ELSE 0 END), 0) AS inflow,
          COALESCE(SUM(CASE WHEN from_location = ${drawerLocation} THEN amount ELSE 0 END), 0) AS outflow
        FROM app.cash_ledger
        WHERE created_at > ${prevTs}
          AND created_at <= ${latest.count_ts || latest.updated_at}
          AND (from_location = ${drawerLocation} OR to_location = ${drawerLocation})
      `;

      const inflow = toMoney(ledgerRows?.[0]?.inflow);
      const outflow = toMoney(ledgerRows?.[0]?.outflow);

      expected_at_latest = toMoney(prevTotal + inflow - outflow);
      variance_at_latest = toMoney(toMoney(latest.grand_total) - expected_at_latest);
      review_status = Math.abs(variance_at_latest) <= 0.009 ? "balanced" : "needs_review";
    } else {
      expected_at_latest = null;
      variance_at_latest = null;
      review_status = null;
    }

   return json({
      date: ymd,
      drawer,
      open,
      close: closeToday,

      // latest evaluation status (manager signal)
      review_status,
      expected_at_latest,
      variance_at_latest,

      latest_count_id: latest?.count_id || null,
      latest_grand_total: latest ? toMoney(latest.grand_total) : null,
      prev_count_id: prev?.count_id || null,
      prev_grand_total: prev ? toMoney(prev.grand_total) : null,

      _debug: {
        drawerLocation,
      },
    });
  } catch (e: any) {
    return json({ error: e?.message || "load_failed" }, 500);
  }
};
