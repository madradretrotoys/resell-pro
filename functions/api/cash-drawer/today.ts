import { neon } from "@neondatabase/serverless";
import { getSessionFromRequest } from "../../lib/auth";

export const onRequestGet: PagesFunction = async (context) => {
  try {
    const session = await getSessionFromRequest(context.request);
    if (!session) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    const tenantId = session.active_tenant_id;
    if (!tenantId) {
      return new Response(JSON.stringify({ ok: false, error: "missing tenant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const url = new URL(context.request.url);
    const drawer = Number(url.searchParams.get("drawer") || "1");

    const sql = neon(context.env.DATABASE_URL);

    // 1) Get latest drawer count record for this drawer (Open or Close)
    const lastCountRows = await sql`
      SELECT *
      FROM app.cash_drawer_counts
      WHERE drawer = ${drawer}
      ORDER BY COALESCE(count_ts, updated_at) DESC
      LIMIT 1
    `;

    const lastCount = lastCountRows?.[0] || null;

    // If no counts exist yet, expected opening is just 0 + ledger since "beginning of time"
    const baselineTotal = lastCount?.grand_total ? Number(lastCount.grand_total) : 0;

    const baselineTs =
      lastCount?.count_ts ||
      lastCount?.updated_at ||
      null;

    // 2) Sum ledger moves affecting THIS drawer since baseline timestamp
    // Drawer movements are represented by from_location / to_location text values like "Drawer 1"
    const drawerLabel = `Drawer ${drawer}`;

    // Net effect:
    // - If cash moves INTO Drawer X: +amount
    // - If cash moves OUT of Drawer X: -amount
    //
    // We compute this as:
    //   sum(amount where to_location = Drawer X)
    // - sum(amount where from_location = Drawer X)

    const ledgerRows = baselineTs
      ? await sql`
          SELECT
            COALESCE(SUM(CASE WHEN to_location = ${drawerLabel} THEN amount ELSE 0 END), 0) AS in_total,
            COALESCE(SUM(CASE WHEN from_location = ${drawerLabel} THEN amount ELSE 0 END), 0) AS out_total
          FROM app.cash_ledger
          WHERE tenant_id = ${tenantId}
            AND created_at > ${baselineTs}
        `
      : await sql`
          SELECT
            COALESCE(SUM(CASE WHEN to_location = ${drawerLabel} THEN amount ELSE 0 END), 0) AS in_total,
            COALESCE(SUM(CASE WHEN from_location = ${drawerLabel} THEN amount ELSE 0 END), 0) AS out_total
          FROM app.cash_ledger
          WHERE tenant_id = ${tenantId}
        `;

    const inTotal = ledgerRows?.[0]?.in_total ? Number(ledgerRows[0].in_total) : 0;
    const outTotal = ledgerRows?.[0]?.out_total ? Number(ledgerRows[0].out_total) : 0;

    const netMoves = inTotal - outTotal;

    // Expected = baseline count total + net moves since then
    const expectedTotal = baselineTotal + netMoves;

    return new Response(
      JSON.stringify({
        ok: true,
        drawer,
        last_count: lastCount
          ? {
              count_id: lastCount.count_id,
              count_ts: lastCount.count_ts,
              updated_at: lastCount.updated_at,
              period: lastCount.period,
              drawer: lastCount.drawer,
              coin_total: lastCount.coin_total,
              bill_total: lastCount.bill_total,
              grand_total: lastCount.grand_total,
              notes: lastCount.notes,
            }
          : null,
        baseline_total: baselineTotal,
        baseline_ts: baselineTs,
        ledger: {
          in_total: inTotal,
          out_total: outTotal,
          net_moves: netMoves,
        },
        expected_total: expectedTotal,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "server_error",
        message: err?.message || String(err),
      }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      }
    );
  }
};
