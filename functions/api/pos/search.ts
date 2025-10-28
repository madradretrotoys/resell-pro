// /api/pos/search  — POS inventory search with primary image
// - Query: ?q=string
// - Auth: session cookie + x-tenant-id header (added by your api() helper)
// - Returns: { items: [{ item_id, sku, product_short_title, price, qty, instore_loc, case_bin_shelf, image_url }] }

import type { Env } from "@/types"; // adjust if you have a shared Env type
// If your project already has a Neon helper, import it here instead:
import { neon } from "@neondatabase/serverless";

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return json({ items: [] });

    const tenantId = request.headers.get("x-tenant-id");
    if (!tenantId) return json({ error: "missing tenant" }, 401);

    const sql = neon(env.NEON_DATABASE_URL); // set in your CF env vars

    // Build a safe ILIKE pattern (split tokens for flexibility)
    const tokens = q.split(/\s+/).filter(Boolean);
    const likeAll = tokens.map(t => `%${t}%`); // ["%mon%", "%doll%"]

    // Primary image per item via DISTINCT ON
    const rows = await sql/*sql*/`
      WITH primary_img AS (
        SELECT DISTINCT ON (ii.item_id)
               ii.item_id, ii.cdn_url AS image_url
        FROM app.item_images ii
        WHERE ii.tenant_id = ${tenantId}
        ORDER BY ii.item_id, (CASE WHEN ii.is_primary THEN 0 ELSE 1 END), ii.created_at DESC
      )
      SELECT
        i.item_id,
        i.sku,
        i.product_short_title,
        i.price,
        i.qty,
        i.instore_loc,
        i.case_bin_shelf,
        p.image_url
      FROM app.inventory i
      LEFT JOIN primary_img p ON p.item_id = i.item_id
      WHERE i.tenant_id = ${tenantId}
        AND (
          i.sku ILIKE ${"%" + q + "%"} OR
          i.category_nm ILIKE ${"%" + q + "%"} OR
          i.product_short_title ILIKE ${"%" + q + "%"}
        )
      ORDER BY
        (CASE WHEN i.sku ILIKE ${q + "%"} THEN 0 ELSE 1 END),  -- sku prefix boost
        i.updated_at DESC NULLS LAST
      LIMIT 50;
    `;

    return json({ items: rows });
  } catch (err: any) {
    return json({ error: err?.message || String(err) }, 500);
  }
};

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
