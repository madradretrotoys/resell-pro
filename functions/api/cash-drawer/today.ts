// GET /api/cash-drawer/today?drawer=1
// Returns { open, close } (today in America/Denver)
import { neon } from "@neondatabase/serverless";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function todayKeyTZ(tz = "America/Denver") {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(d)
    .reduce((acc, p) => (acc[p.type] = p.value, acc), {} as any);
  return `${parts.year}-${parts.month}-${parts.day}`; // YYYY-MM-DD
}

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const url = new URL(request.url);
    const drawer = String(url.searchParams.get("drawer") || "1");
    const ymd = todayKeyTZ();

    const sql = neon(env.DATABASE_URL);
    const rows = await sql/*sql*/`
      SELECT *
      FROM app.cash_drawer_counts
      WHERE count_id IN (${ymd + "#" + drawer + "#OPEN"}, ${ymd + "#" + drawer + "#CLOSE"})
    `;

    const open = rows.find((r: any) => r.period === "OPEN") || null;
    const close = rows.find((r: any) => r.period === "CLOSE") || null;

    return json({ date: ymd, drawer, open, close });
  } catch (e: any) {
    return json({ error: e?.message || "load_failed" }, 500);
  }
};
