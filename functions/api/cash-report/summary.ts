import { neon } from "@neondatabase/serverless";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function readCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/; */)) {
    const [k, ...rest] = part.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

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
  if (payload?.exp && Date.now() / 1000 > payload.exp) throw new Error("expired");
  return payload;
}

function isIsoDate(d: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(d);
}

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const cookieHeader = request.headers.get("cookie") || "";
    const token = readCookie(cookieHeader, "__Host-rp_session");
    if (!token || !env.JWT_SECRET) return json({ error: "unauthorized" }, 401);

    const payload = await verifyJwt(token, String(env.JWT_SECRET));
    const user_id = String(payload?.sub || "");
    if (!user_id) return json({ error: "unauthorized" }, 401);

    const sql = neon(env.DATABASE_URL);

    const permRows = await sql/*sql*/`
      SELECT can_cash_edit
      FROM app.permissions
      WHERE user_id = ${user_id}
      LIMIT 1
    `;
    if (!permRows?.[0]?.can_cash_edit) return json({ error: "forbidden" }, 403);

    const tenantRows = await sql/*sql*/`
      SELECT tenant_id
      FROM app.memberships
      WHERE user_id = ${user_id}
      ORDER BY created_at ASC
      LIMIT 1
    `;
    const tenant_id = tenantRows?.[0]?.tenant_id;
    if (!tenant_id) return json({ error: "no_tenant" }, 403);

    const url = new URL(request.url);
    const presetRaw = String(url.searchParams.get("preset") || "today").toLowerCase();
    const preset = presetRaw === "week" || presetRaw === "custom" ? presetRaw : "today";
    const from = String(url.searchParams.get("from") || "").trim();
    const to = String(url.searchParams.get("to") || "").trim();
    const tz = env.STORE_TZ || "America/Denver";

    if (preset === "custom") {
      if (!isIsoDate(from) || !isIsoDate(to)) {
        return json({ error: "bad_custom_range" }, 400);
      }
      if (from > to) return json({ error: "bad_custom_range" }, 400);
    }

    const [rangeRows] = await Promise.all([
      preset === "today"
        ? sql/*sql*/`
            SELECT
              (date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}) AS start_ts,
              ((date_trunc('day', now() AT TIME ZONE ${tz}) + interval '1 day') AT TIME ZONE ${tz}) AS end_ts,
              to_char((date_trunc('day', now() AT TIME ZONE ${tz}))::date, 'YYYY-MM-DD') AS start_date,
              to_char((date_trunc('day', now() AT TIME ZONE ${tz}))::date, 'YYYY-MM-DD') AS end_date
          `
        : preset === "week"
          ? sql/*sql*/`
              SELECT
                ((date_trunc('week', (now() AT TIME ZONE ${tz}) + interval '1 day') - interval '1 day') AT TIME ZONE ${tz}) AS start_ts,
                (((date_trunc('week', (now() AT TIME ZONE ${tz}) + interval '1 day') - interval '1 day') + interval '7 day') AT TIME ZONE ${tz}) AS end_ts,
                to_char((date_trunc('week', (now() AT TIME ZONE ${tz}) + interval '1 day') - interval '1 day')::date, 'YYYY-MM-DD') AS start_date,
                to_char(((date_trunc('week', (now() AT TIME ZONE ${tz}) + interval '1 day') - interval '1 day') + interval '6 day')::date, 'YYYY-MM-DD') AS end_date
            `
          : sql/*sql*/`
              SELECT
                ((${from}::date) AT TIME ZONE ${tz}) AS start_ts,
                (((${to}::date) + interval '1 day') AT TIME ZONE ${tz}) AS end_ts,
                ${from}::text AS start_date,
                ${to}::text AS end_date
            `,
    ]);

    const start_ts = rangeRows?.start_ts;
    const end_ts = rangeRows?.end_ts;

    const [drawerRows, ledgerRows, safeRows, salesRows] = await Promise.all([
      sql/*sql*/`
        SELECT count_id, count_ts, drawer, period, grand_total, notes, user_name
        FROM app.cash_drawer_counts
        WHERE tenant_id = ${tenant_id}::uuid
          AND count_ts >= ${start_ts}
          AND count_ts < ${end_ts}
        ORDER BY count_ts DESC
      `,
      sql/*sql*/`
        SELECT ledger_id, from_location, to_location, amount, notes, created_at
        FROM app.cash_ledger
        WHERE tenant_id = ${tenant_id}::uuid
          AND created_at >= ${start_ts}
          AND created_at < ${end_ts}
        ORDER BY created_at DESC
      `,
      sql/*sql*/`
        SELECT safe_count_id, count_ts, count_date, period, amount, notes, user_name
        FROM app.cash_safe_counts
        WHERE tenant_id = ${tenant_id}::uuid
          AND count_ts >= ${start_ts}
          AND count_ts < ${end_ts}
        ORDER BY count_ts DESC
      `,
      sql/*sql*/`
        SELECT sale_id, sale_ts, total, payment_method
        FROM app.sales
        WHERE tenant_id = ${tenant_id}::uuid
          AND sale_ts >= ${start_ts}
          AND sale_ts < ${end_ts}
          AND (
            lower(payment_method) = 'cash'
            OR lower(payment_method) LIKE 'cash:%'
            OR lower(payment_method) LIKE 'split:%cash:%'
            OR lower(payment_method) LIKE '%:cash:%'
          )
        ORDER BY sale_ts DESC
      `,
    ]);

    const totals = {
      drawer_open_total: 0,
      drawer_close_total: 0,
      safe_open_total: 0,
      safe_close_total: 0,
      movement_in_total: 0,
      movement_out_total: 0,
      payout_total: 0,
      cash_sales_total: 0,
    };

    const drawerSummary = new Map<string, any>();
    const ensureDrawer = (d: string) => {
      if (!drawerSummary.has(d)) {
        drawerSummary.set(d, {
          drawer: d,
          open_total: 0,
          close_total: 0,
          movement_in: 0,
          movement_out: 0,
          payout_out: 0,
          counts: 0,
        });
      }
      return drawerSummary.get(d);
    };

    for (const r of drawerRows || []) {
      const d = String(r.drawer || "");
      if (!d) continue;
      const amt = Number(r.grand_total || 0);
      const row = ensureDrawer(d);
      row.counts += 1;

      if (String(r.period || "").toUpperCase() === "OPEN") {
        row.open_total += amt;
        totals.drawer_open_total += amt;
      }
      if (String(r.period || "").toUpperCase() === "CLOSE") {
        row.close_total += amt;
        totals.drawer_close_total += amt;
      }
    }

    for (const r of safeRows || []) {
      const amt = Number(r.amount || 0);
      if (String(r.period || "").toUpperCase() === "OPEN") totals.safe_open_total += amt;
      if (String(r.period || "").toUpperCase() === "CLOSE") totals.safe_close_total += amt;
    }

    for (const r of ledgerRows || []) {
      const amt = Number(r.amount || 0);
      const fromLoc = String(r.from_location || "");
      const toLoc = String(r.to_location || "");

      const fromDrawer = fromLoc.match(/^Drawer\s+(\d+)$/i)?.[1] || null;
      const toDrawer = toLoc.match(/^Drawer\s+(\d+)$/i)?.[1] || null;

      if (toDrawer) {
        ensureDrawer(toDrawer).movement_in += amt;
        totals.movement_in_total += amt;
      }
      if (fromDrawer) {
        ensureDrawer(fromDrawer).movement_out += amt;
        totals.movement_out_total += amt;

        // Legacy "payouts" bucket is now sourced from ledger moves to Purchase.
        if (/^purchase$/i.test(toLoc)) {
          ensureDrawer(fromDrawer).payout_out += amt;
          totals.payout_total += amt;
        }
      }
    }

    for (const s of salesRows || []) {
      totals.cash_sales_total += Number(s.total || 0);
    }

    const byPathMap = new Map<string, any>();
    for (const r of ledgerRows || []) {
      const key = `${r.from_location}=>${r.to_location}`;
      const prev = byPathMap.get(key) || {
        from_location: r.from_location,
        to_location: r.to_location,
        amount_total: 0,
        moves: 0,
      };
      prev.amount_total += Number(r.amount || 0);
      prev.moves += 1;
      byPathMap.set(key, prev);
    }

    return json({
      ok: true,
      range: {
        preset,
        timezone: tz,
        start_date: rangeRows.start_date,
        end_date: rangeRows.end_date,
      },
      totals,
      drawer_summary: Array.from(drawerSummary.values()).sort((a, b) => Number(a.drawer) - Number(b.drawer)),
      movement_paths: Array.from(byPathMap.values()).sort((a, b) => b.amount_total - a.amount_total),
      activity: {
        drawer_counts: drawerRows,
        safe_counts: safeRows,
        ledger_moves: ledgerRows,
        cash_sales: salesRows,
      },
    });
  } catch (e: any) {
    return json({ error: e?.message || "cash_report_failed" }, 500);
  }
};
