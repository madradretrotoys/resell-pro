
import { neon } from "@neondatabase/serverless";
import { getSession } from "../../lib/session";
import { json, error } from "../../lib/http";

export const onRequestPost: PagesFunction = async (ctx) => {
  try {
    const session = await getSession(ctx);
    if (!session?.user) {
      return error(401, "not_logged_in");
    }

    // Tenant resolution (your api() helper sends x-tenant-id)
    const tenant_id =
      ctx.request.headers.get("x-tenant-id") ||
      session.active_tenant_id ||
      session.tenant_id;

    if (!tenant_id) {
      return error(400, "missing_tenant");
    }

    const body = await ctx.request.json().catch(() => ({}));
    const period = String(body?.period || "").trim();
    const amount = Number(body?.amount || 0);
    const notes = body?.notes ? String(body.notes).trim() : null;

    if (!period) {
      return error(400, "missing_period");
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return error(400, "invalid_amount");
    }

    // Optional user_id from session if present
    const user_id = session.user?.user_id || null;

    const sql = neon(ctx.env.NEON_DATABASE_URL);

    // Insert safe count row (count_date defaults to current_date)
    // Unique constraint expected on (tenant_id, count_date, period)
    const rows = await sql`
      INSERT INTO app.safe_counts (
        tenant_id,
        user_id,
        period,
        amount,
        notes
      )
      VALUES (
        ${tenant_id},
        ${user_id},
        ${period},
        ${amount},
        ${notes}
      )
      RETURNING safe_count_id
    `;

    const safe_count_id = rows?.[0]?.safe_count_id;

    return json({ safe_count_id });

  } catch (e: any) {
    // Unique violation (already saved for today)
    const code = e?.code || e?.cause?.code;
    if (code === "23505") {
      return error(409, "already_saved_today");
    }

    console.error("cash-safe/save error", e);
    return error(500, "save_failed");
  }
};
