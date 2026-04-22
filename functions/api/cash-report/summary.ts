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

function toMoney(n: any): number {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function methodLooksCash(raw: any): boolean {
  const s = String(raw || "").trim().toLowerCase();
  return /^cash(?:$|[:\s_-])/.test(s) || /^sales[\s:_-]*cash(?:$|[:\s_-])/.test(s);
}

function parseCashFromPaymentMethod(paymentMethod: any, saleTotal: number): number {
  const pm = String(paymentMethod || "").trim();
  if (!pm) return 0;
  const lower = pm.toLowerCase();

  // split:cash:10.00,card:40.00 or split:sales cash:10.00,wallet:40.00
  if (lower.startsWith("split:")) {
    const payload = pm.slice(6);
    let sum = 0;
    for (const tokenRaw of payload.split(",")) {
      const token = tokenRaw.trim();
      if (!token) continue;
      const m = token.match(/^([^:]+(?:\s+[^:]+)*)\s*:\s*(-?\d+(?:\.\d{1,2})?)$/);
      if (!m) continue;
      const method = m[1];
      const amt = toMoney(m[2]);
      if (methodLooksCash(method)) sum += amt;
    }
    return toMoney(sum);
  }

  // cash:50.00;received=60.00;change=10.00
  if (/^(cash|sales[\s:_-]*cash)\s*:/i.test(pm)) {
    const m = pm.match(/^(?:cash|sales[\s:_-]*cash)\s*:\s*(-?\d+(?:\.\d{1,2})?)/i);
    if (m) return toMoney(m[1]);
  }

  // plain "cash" or "sales cash" style: treat as full total cash
  if (methodLooksCash(pm)) return toMoney(saleTotal);

  return 0;
}

function parseCashFromParts(parts: any): number {
  if (!Array.isArray(parts)) return 0;
  let sum = 0;
  for (const p of parts) {
    const method = String(p?.method || "");
    if (!methodLooksCash(method)) continue;
    sum += toMoney(p?.amount);
  }
  return toMoney(sum);
}

function ymdInTz(ts: any, tz: string): string | null {
  if (!ts) return null;
  try {
    const d = ts instanceof Date ? ts : new Date(ts);
    if (!Number.isFinite(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d).reduce((acc: any, p: any) => ((acc[p.type] = p.value), acc), {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    return null;
  }
}

function enumerateDateKeys(startYmd: string, endYmd: string): string[] {
  if (!startYmd || !endYmd || startYmd > endYmd) return [];
  const out: string[] = [];
  const cur = new Date(`${startYmd}T00:00:00Z`);
  const end = new Date(`${endYmd}T00:00:00Z`);
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    const reqUrl = new URL(request.url);
    const reqId = crypto.randomUUID().slice(0, 8);
    console.log("[cash-report/summary] start", {
      reqId,
      path: reqUrl.pathname,
      search: reqUrl.search,
      hasCookie: !!request.headers.get("cookie"),
      hasTenantHeader: !!request.headers.get("x-tenant-id"),
    });

    const cookieHeader = request.headers.get("cookie") || "";
    const token = readCookie(cookieHeader, "__Host-rp_session");
    if (!token || !env.JWT_SECRET) return json({ error: "unauthorized" }, 401);

    const payload = await verifyJwt(token, String(env.JWT_SECRET));
    const user_id = String(payload?.sub || "");
    if (!user_id) return json({ error: "unauthorized" }, 401);

    const sql = neon(env.DATABASE_URL);

    const permRows = await sql/*sql*/`
      SELECT
        COALESCE(can_cash_edit, false) AS can_cash_edit,
        COALESCE(can_cash_drawer, false) AS can_cash_drawer,
        COALESCE(can_cash_payouts, false) AS can_cash_payouts
      FROM app.permissions
      WHERE user_id = ${user_id}
      LIMIT 1
    `;
    const canCashAccess =
      !!permRows?.[0]?.can_cash_edit ||
      !!permRows?.[0]?.can_cash_drawer ||
      !!permRows?.[0]?.can_cash_payouts;
    if (!canCashAccess) return json({ error: "forbidden" }, 403);

    const tenantRows = await sql/*sql*/`
      SELECT tenant_id
      FROM app.memberships
      WHERE user_id = ${user_id}
      ORDER BY created_at ASC
      LIMIT 50
    `;
    const requestedTenantId = String(request.headers.get("x-tenant-id") || "").trim();
    const tenantList = Array.isArray(tenantRows) ? tenantRows.map((r: any) => String(r.tenant_id || "")) : [];
    const tenant_id = requestedTenantId || (tenantRows?.[0]?.tenant_id || null);
    if (!tenant_id) return json({ error: "no_tenant" }, 403);
    console.log("[cash-report/summary] tenant resolved", {
      reqId,
      user_id,
      requestedTenantId: requestedTenantId || null,
      tenant_id,
      tenantCount: tenantList.length,
      requestedTenantInMemberships: requestedTenantId ? tenantList.includes(requestedTenantId) : null,
    });

    const url = reqUrl;
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

    const [rangeRowsRaw] = await Promise.all([
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
                LEAST(
                  (((date_trunc('week', (now() AT TIME ZONE ${tz}) + interval '1 day') - interval '1 day') + interval '7 day') AT TIME ZONE ${tz}),
                  ((date_trunc('day', now() AT TIME ZONE ${tz}) + interval '1 day') AT TIME ZONE ${tz})
                ) AS end_ts,
                to_char((date_trunc('week', (now() AT TIME ZONE ${tz}) + interval '1 day') - interval '1 day')::date, 'YYYY-MM-DD') AS start_date,
                to_char(LEAST(
                  ((date_trunc('week', (now() AT TIME ZONE ${tz}) + interval '1 day') - interval '1 day') + interval '6 day')::date,
                  (now() AT TIME ZONE ${tz})::date
                ), 'YYYY-MM-DD') AS end_date
            `
          : sql/*sql*/`
              SELECT
                ((${from}::date) AT TIME ZONE ${tz}) AS start_ts,
                (((${to}::date) + interval '1 day') AT TIME ZONE ${tz}) AS end_ts,
                ${from}::text AS start_date,
                ${to}::text AS end_date
            `,
    ]);
    const rangeRows = Array.isArray(rangeRowsRaw) ? (rangeRowsRaw[0] || {}) : (rangeRowsRaw || {});

    const start_ts = rangeRows?.start_ts;
    const end_ts = rangeRows?.end_ts;
    console.log("[cash-report/summary] range resolved", {
      reqId,
      preset,
      from: from || null,
      to: to || null,
      tz,
      start_ts,
      end_ts,
      start_date: rangeRows?.start_date || null,
      end_date: rangeRows?.end_date || null,
    });

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
        SELECT sale_id, sale_ts, total, payment_method, items_json
        FROM app.sales
        WHERE tenant_id = ${tenant_id}::uuid
          AND sale_ts >= ${start_ts}
          AND sale_ts < ${end_ts}
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
          sales_in: 0,
          expected_close: 0,
          variance: 0,
          status: "balanced",
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
        if (/^purchase$/i.test(toLoc)) {
          ensureDrawer(fromDrawer).payout_out += amt;
          totals.payout_total += amt;
        } else {
          ensureDrawer(fromDrawer).movement_out += amt;
          totals.movement_out_total += amt;
        }
      }
    }

    const drawerOne = ensureDrawer("1");
    for (const s of salesRows || []) {
      const saleTotal = toMoney(s.total);
      let cashAmt = 0;

      const partsFromJson = (typeof s.items_json === "object" && s.items_json)
        ? (s.items_json as any)?.payment_parts
        : null;
      cashAmt = parseCashFromParts(partsFromJson);

      if (!(cashAmt > 0)) {
        cashAmt = parseCashFromPaymentMethod(s.payment_method, saleTotal);
      }

      if (cashAmt > 0) {
        totals.cash_sales_total += cashAmt;
        // Sales cash is only expected to hit Drawer 1 / Mad Rad.
        drawerOne.sales_in += cashAmt;
      }
    }
    totals.cash_sales_total = toMoney(totals.cash_sales_total);

    for (const d of drawerSummary.values()) {
      d.open_total = toMoney(d.open_total);
      d.close_total = toMoney(d.close_total);
      d.movement_in = toMoney(d.movement_in);
      d.movement_out = toMoney(d.movement_out);
      d.payout_out = toMoney(d.payout_out);
      d.sales_in = toMoney(d.sales_in);
      d.expected_close = toMoney(d.open_total + d.sales_in + d.movement_in - d.movement_out - d.payout_out);
      d.variance = toMoney(d.close_total - d.expected_close);
      d.status = Math.abs(d.variance) <= 0.009 ? "balanced" : "needs_review";
    }

    const allDateKeys = enumerateDateKeys(String(rangeRows?.start_date || ""), String(rangeRows?.end_date || ""));
    const drawerIds = new Set<string>(Array.from(drawerSummary.keys()));
    if (!drawerIds.size) {
      drawerIds.add("1");
      drawerIds.add("2");
    }

    const dailyMap = new Map<string, any>();
    const ensureDaily = (drawer: string, date: string) => {
      const key = `${drawer}::${date}`;
      if (!dailyMap.has(key)) {
        dailyMap.set(key, {
          drawer,
          date,
          open_total: 0,
          close_total: 0,
          sales_in: 0,
          movement_in: 0,
          movement_out: 0,
          payout_out: 0,
          expected_close: 0,
          variance: 0,
        });
      }
      return dailyMap.get(key);
    };

    for (const date of allDateKeys) for (const d of drawerIds) ensureDaily(d, date);

    for (const r of drawerRows || []) {
      const d = String(r.drawer || "");
      const date = ymdInTz(r.count_ts, tz);
      if (!d || !date) continue;
      const row = ensureDaily(d, date);
      const amt = toMoney(r.grand_total);
      if (String(r.period || "").toUpperCase() === "OPEN") row.open_total += amt;
      if (String(r.period || "").toUpperCase() === "CLOSE") row.close_total += amt;
    }

    for (const r of ledgerRows || []) {
      const date = ymdInTz(r.created_at, tz);
      if (!date) continue;
      const amt = toMoney(r.amount);
      const fromDrawer = String(r.from_location || "").match(/^Drawer\s+(\d+)$/i)?.[1] || null;
      const toDrawer = String(r.to_location || "").match(/^Drawer\s+(\d+)$/i)?.[1] || null;
      if (toDrawer) ensureDaily(toDrawer, date).movement_in += amt;
      if (fromDrawer) {
        if (/^purchase$/i.test(String(r.to_location || ""))) ensureDaily(fromDrawer, date).payout_out += amt;
        else ensureDaily(fromDrawer, date).movement_out += amt;
      }
    }

    for (const s of salesRows || []) {
      const date = ymdInTz(s.sale_ts, tz);
      if (!date) continue;
      const saleTotal = toMoney(s.total);
      let cashAmt = parseCashFromParts((typeof s.items_json === "object" && s.items_json) ? (s.items_json as any)?.payment_parts : null);
      if (!(cashAmt > 0)) cashAmt = parseCashFromPaymentMethod(s.payment_method, saleTotal);
      if (cashAmt > 0) ensureDaily("1", date).sales_in += cashAmt;
    }

    const daily_by_drawer = Array.from(drawerIds)
      .sort((a, b) => Number(a) - Number(b))
      .map((drawer) => {
        const days = allDateKeys
          .map((date) => ensureDaily(drawer, date))
          .map((r) => {
            r.open_total = toMoney(r.open_total);
            r.close_total = toMoney(r.close_total);
            r.sales_in = toMoney(r.sales_in);
            r.movement_in = toMoney(r.movement_in);
            r.movement_out = toMoney(r.movement_out);
            r.payout_out = toMoney(r.payout_out);
            r.expected_close = toMoney(r.open_total + r.sales_in + r.movement_in - r.movement_out - r.payout_out);
            r.variance = toMoney(r.close_total - r.expected_close);
            return r;
          })
          .sort((a, b) => b.date.localeCompare(a.date)); // Today at top, Sunday bottom.

        const totalsRow = days.reduce((acc, r) => ({
          open_total: toMoney(acc.open_total + r.open_total),
          close_total: toMoney(acc.close_total + r.close_total),
          sales_in: toMoney(acc.sales_in + r.sales_in),
          movement_in: toMoney(acc.movement_in + r.movement_in),
          movement_out: toMoney(acc.movement_out + r.movement_out),
          payout_out: toMoney(acc.payout_out + r.payout_out),
          expected_close: toMoney(acc.expected_close + r.expected_close),
          variance: toMoney(acc.variance + r.variance),
        }), {
          open_total: 0, close_total: 0, sales_in: 0, movement_in: 0, movement_out: 0, payout_out: 0, expected_close: 0, variance: 0,
        });

        return { drawer, days, totals: totalsRow };
      });

    console.log("[cash-report/summary] query counts", {
      reqId,
      drawerRows: drawerRows?.length || 0,
      ledgerRows: ledgerRows?.length || 0,
      safeRows: safeRows?.length || 0,
      salesRows: salesRows?.length || 0,
      drawerSummaryRows: drawerSummary.size,
      totals,
    });

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
      _debug: {
        tenant_id,
        requested_tenant_id: requestedTenantId || null,
      },
      totals,
      drawer_summary: Array.from(drawerSummary.values()).sort((a, b) => Number(a.drawer) - Number(b.drawer)),
      daily_by_drawer,
      movement_paths: Array.from(byPathMap.values()).sort((a, b) => b.amount_total - a.amount_total),
      activity: {
        drawer_counts: drawerRows,
        safe_counts: safeRows,
        ledger_moves: ledgerRows,
        cash_sales: salesRows,
      },
    });
  } catch (e: any) {
    console.error("[cash-report/summary] failed", {
      message: e?.message || "cash_report_failed",
      stack: e?.stack || null,
    });
    return json({ error: e?.message || "cash_report_failed" }, 500);
  }
};
