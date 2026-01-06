// POST /api/cash-safe/save
// Body: { period, amount, notes }
// Rules: first-write wins per tenant+date+period; 409 if already exists

import { neon } from "@neondatabase/serverless";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });

function todayKeyTZ(tz = "America/Denver") {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(d)
    .reduce((acc, p) => (acc[p.type] = p.value, acc), {} as any);
  return `${parts.year}-${parts.month}-${parts.day}`; // YYYY-MM-DD
}

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

    const period = String(body.period || "").trim().toUpperCase();
    if (!period) return json({ error: "missing_period" }, 400);

    const amount = toMoney(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return json({ error: "invalid_amount" }, 400);

    const notes = body.notes ? String(body.notes).slice(0, 2000) : null;

    // Tenant is REQUIRED — sent by api() helper as x-tenant-id
    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) return json({ error: "missing_tenant" }, 400);

    const sql = neon(env.DATABASE_URL);

    // Resolve actor (prefer full name; fallback to login/email/sub)
    let actor_name = "unknown";
    let user_id: string | null = null;

    try {
      const cookieHeader = request.headers.get("cookie") || "";
      const token = readCookie(cookieHeader, "__Host-rp_session");
      if (token && env.JWT_SECRET) {
        const payload = await verifyJwt(token, String(env.JWT_SECRET));
        user_id = String((payload as any).sub);

        const rowsActor = await sql/*sql*/`
          SELECT name, login_id, email
          FROM app.users
          WHERE user_id = ${user_id}
          LIMIT 1
        `;
        actor_name =
          rowsActor[0]?.name ||
          rowsActor[0]?.login_id ||
          rowsActor[0]?.email ||
          user_id;
      }
    } catch {
      // non-fatal: keep "unknown"
    }

    // Use store timezone for the daily lock
    const ymd = todayKeyTZ();
    const safe_count_id = `${tenant_id}#${ymd}#${period}`;

    // First-write wins: insert, else 409
    try {
      const rows = await sql/*sql*/`
        INSERT INTO app.cash_safe_counts
          (safe_count_id, tenant_id, user_id, user_name, count_ts, count_date, period, amount, notes, updated_at)
        VALUES
          (${safe_count_id}, ${tenant_id}, ${user_id}, ${actor_name}, now(), ${ymd}, ${period}, ${amount}, ${notes}, now())
        RETURNING safe_count_id, period, amount
      `;
      const row = rows[0];

      return json({
        ok: true,
        safe_count_id: row.safe_count_id,
        period: row.period,
        amount: row.amount
      });

    } catch (e: any) {
      if ((e?.message || "").toLowerCase().includes("duplicate key")) {
        return json({ error: "exists" }, 409);
      }
      throw e;
    }

  } catch (e: any) {
    return json({ error: e?.message || "save_failed" }, 500);
  }
};
