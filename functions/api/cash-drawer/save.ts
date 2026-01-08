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

function toMoney(n: any) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function readCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/; */)) {
    const [k, ...rest] = part.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

// Minimal HS256 verify (same as /api/auth/session)
async function verifyJwt(token: string, secret: string): Promise<any> {
  const enc = new TextEncoder();
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new Error("bad_token");
  const base64urlToBytes = (str: string) => {
    const pad = "=".repeat((4 - (str.length % 4)) % 4);
    const b64 = (str + pad).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };
  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify("HMAC", key, base64urlToBytes(s), enc.encode(data));
  if (!ok) throw new Error("bad_sig");
  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(p)));
  if ((payload as any)?.exp && Date.now() / 1000 > (payload as any).exp) throw new Error("expired");
  return payload;
}



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
    const ymd = todayKeyTZ("America/Denver");
    const count_id = `${ymd}#${drawer}#${period}`;

    const sql = neon(env.DATABASE_URL);

    // Resolve actor (prefer full name; fallback to login/email/sub)
    let actor_name = "unknown";
    try {
      const cookieHeader = request.headers.get("cookie") || "";
      const token = readCookie(cookieHeader, "__Host-rp_session");
      if (token && env.JWT_SECRET) {
        const payload = await verifyJwt(token, String(env.JWT_SECRET));
        const uid = String((payload as any).sub);
        const rowsActor = await sql/*sql*/`
          SELECT name, login_id, email FROM app.users WHERE user_id = ${uid} LIMIT 1
        `;
        actor_name =
          rowsActor[0]?.name ||
          rowsActor[0]?.login_id ||
          rowsActor[0]?.email ||
          uid;
      }
    } catch { /* non-fatal: keep "unknown" */ }
    
        // ✅ Enforce session + permissions
    const cookieHeader = request.headers.get("cookie") || "";
    const token = readCookie(cookieHeader, "__Host-rp_session");
    if (!token || !env.JWT_SECRET) return json({ error: "unauthorized" }, 401);

    const payload = await verifyJwt(token, String(env.JWT_SECRET));
    const uid = String((payload as any).sub);

    // Load permissions for this user
    const permRows = await sql/*sql*/`
      SELECT can_cash_edit
      FROM app.permissions
      WHERE user_id = ${uid}
      LIMIT 1
    `;
    const can_cash_edit = !!permRows?.[0]?.can_cash_edit;

    // Determine actor_name for audit field
    let actor_name = "unknown";
    const rowsActor = await sql/*sql*/`
      SELECT name, login_id, email FROM app.users WHERE user_id = ${uid} LIMIT 1
    `;
    actor_name =
      rowsActor[0]?.name ||
      rowsActor[0]?.login_id ||
      rowsActor[0]?.email ||
      uid;

    // ✅ If an entry already exists, allow UPDATE only if can_cash_edit=true
    const existingRows = await sql/*sql*/`
      SELECT count_id
      FROM app.cash_drawer_counts
      WHERE count_id = ${count_id}
      LIMIT 1
    `;
    const exists = !!existingRows?.[0]?.count_id;

    if (exists && !can_cash_edit) {
      return json({ error: "exists" }, 409);
    }

    if (exists && can_cash_edit) {
      const upd = await sql/*sql*/`
        UPDATE app.cash_drawer_counts
        SET
          count_ts = now(),
          user_name = ${actor_name},
          pennies = ${pennies},
          nickels = ${nickels},
          dimes = ${dimes},
          quarters = ${quarters},
          halfdollars = ${halfdollars},
          ones = ${ones},
          twos = ${twos},
          fives = ${fives},
          tens = ${tens},
          twenties = ${twenties},
          fifties = ${fifties},
          hundreds = ${hundreds},
          coin_total = ${coin_total},
          bill_total = ${bill_total},
          grand_total = ${grand_total},
          notes = ${notes},
          updated_at = now()
        WHERE count_id = ${count_id}
        RETURNING count_id, period, drawer, grand_total
      `;

      const row = upd[0];

      return json({
        ok: true,
        updated: true,
        count_id: row.count_id,
        period: row.period,
        drawer: row.drawer,
        grand_total: row.grand_total
      });
    }

    // ✅ Otherwise this is first write: INSERT
    const rows = await sql/*sql*/`
      INSERT INTO app.cash_drawer_counts
        (count_id, count_ts, period, drawer, user_name,
         pennies, nickels, dimes, quarters, halfdollars,
         ones, twos, fives, tens, twenties, fifties, hundreds,
         coin_total, bill_total, grand_total, notes, updated_at)
      VALUES
        (${count_id}, now(), ${period}, ${drawer}, ${actor_name},
         ${pennies}, ${nickels}, ${dimes}, ${quarters}, ${halfdollars},
         ${ones}, ${twos}, ${fives}, ${tens}, ${twenties}, ${fifties}, ${hundreds},
         ${coin_total}, ${bill_total}, ${grand_total}, ${notes}, now())
      RETURNING count_id, period, drawer, grand_total
    `;

    const row = rows[0];

    return json({
      ok: true,
      inserted: true,
      count_id: row.count_id,
      period: row.period,
      drawer: row.drawer,
      grand_total: row.grand_total
    });

  } catch (e: any) {
    return json({ error: e?.message || "save_failed" }, 500);
  }
};
