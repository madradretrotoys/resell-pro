// POST /api/cash-drawer/save
// Body: { drawer, period, pennies..hundreds, notes }
// Rules (Phase 1): first-write wins; 409 if already exists
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

function asInt(n: any){ const x = Number(n || 0); return Number.isFinite(x) ? Math.max(0, Math.floor(x)) : 0; }

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  try {
    const body = await request.json();

    const drawer = String(body.drawer || "1");
    const period = String(body.period || "").toUpperCase();
    if (period !== "OPEN" && period !== "CLOSE") return json({ error: "bad_period" }, 400);

    // Denomination counts (integers)
    const pennies     = asInt(body.pennies);
    const nickels     = asInt(body.nickels);
    const dimes       = asInt(body.dimes);
    const quarters    = asInt(body.quarters);
    const halfdollars = asInt(body.halfdollars);
    const ones        = asInt(body.ones);
    const twos        = asInt(body.twos);
    const fives       = asInt(body.fives);
    const tens        = asInt(body.tens);
    const twenties    = asInt(body.twenties);
    const fifties     = asInt(body.fifties);
    const hundreds    = asInt(body.hundreds);
    const notes       = body.notes ? String(body.notes).slice(0, 2000) : null;

    // Totals (authoritative on server)
    const coin_total = pennies*0.01 + nickels*0.05 + dimes*0.10 + quarters*0.25 + halfdollars*0.50;
    const bill_total = ones*1 + twos*2 + fives*5 + tens*10 + twenties*20 + fifties*50 + hundreds*100;
    const grand_total = coin_total + bill_total;

    // Build key in store timezone
    const ymd = todayKeyTZ();
    const count_id = `${ymd}#${drawer}#${period}`;

    const sql = neon(env.DATABASE_URL);

    // First-write wins (Phase 1): insert if not exists, else 409
    // count_id is the PK in app.cash_drawer_counts
    try {
      const rows = await sql/*sql*/`
        INSERT INTO app.cash_drawer_counts
          (count_id, count_ts, period, drawer, user_name,
           pennies, nickels, dimes, quarters, halfdollars,
           ones, twos, fives, tens, twenties, fifties, hundreds,
           coin_total, bill_total, grand_total, notes, updated_at)
        VALUES
          (${count_id}, now(), ${period}, ${drawer}, ${"${user}"},
           ${pennies}, ${nickels}, ${dimes}, ${quarters}, ${halfdollars},
           ${ones}, ${twos}, ${fives}, ${tens}, ${twenties}, ${fifties}, ${hundreds},
           ${coin_total}, ${bill_total}, ${grand_total}, ${notes}, now())
        RETURNING count_id, period, drawer, grand_total
      `;
      // Note: we record the actor as a placeholder "${user}" for Phase 1;
      // in Phase 2 we will pull login_id from /api/auth/session (middleware or fetch).
      const row = rows[0];
      return json({ ok: true, count_id: row.count_id, period: row.period, drawer: row.drawer, grand_total: row.grand_total });
    } catch (e: any) {
      // If the PK (count_id) already exists, treat as conflict
      if ((e?.message || '').toLowerCase().includes('duplicate key')) {
        return json({ error: "exists" }, 409);
      }
      throw e;
    }
  } catch (e: any) {
    return json({ error: e?.message || "save_failed" }, 500);
  }
};
