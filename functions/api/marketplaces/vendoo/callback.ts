import { neon } from "@neondatabase/serverless";

export const onRequestPost = async ({ request, env }) => {
  const sql = neon(env.DATABASE_URL);
  const body = await request.json().catch(() => ({}));

  console.log("[vendoo.callback] raw body →", body);

  const item_id = String(body?.item_id || "").trim();
  const tenant_id = String(body?.tenant_id || "").trim();
  
  if (!item_id) {
    return new Response(JSON.stringify({ ok: false, error: "missing_item_id" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }
  
  if (!tenant_id) {
    return new Response(JSON.stringify({ ok: false, error: "missing_tenant_id" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }
  
  console.log("[vendoo.callback] using item_id + tenant_id →", { item_id, tenant_id });

  const vendooRoot = body?.vendoo || {};
  const marketplaces = body?.marketplaces || {};

  // -------------------------
  // Helper: map Vendoo → DB
  // -------------------------
  const normalizeStatus = (s) => {
    if (!s) return "error";
    const t = s.toLowerCase().trim();
    if (t === "listed") return "live";
    if (t === "error") return "error";
    return "error";
  };

  // -------------------------
  // Marketplace id map
  // -------------------------
  const MP_IDS = {
    ebay: 1,
    facebook: 2,
    whatnot: 3,
    depop: 4,
    shopify: 5,
    vendoo: 13
  };

  const updates = [];

  // ------------------------------------------
  // 1) Process Vendoo (marketplace_id = 13)
  // ------------------------------------------
  updates.push({
    marketplace: "vendoo",
    marketplace_id: 13,
    mp_item_id: vendooRoot?.id ?? null,
    mp_item_url: vendooRoot?.url ?? null,
    status: normalizeStatus(vendooRoot?.raw?.status ?? "listed")
  });

  // ------------------------------------------
  // 2) Process each marketplace (ebay/shopify/whatnot)
  // ------------------------------------------
  for (const [mpName, mpData] of Object.entries(marketplaces)) {
    if (!(mpName in MP_IDS)) continue;

    updates.push({
      marketplace: mpName,
      marketplace_id: MP_IDS[mpName],
      mp_item_id: vendooRoot?.id ?? null,                // per Melissa: vendoo.id in mp_item_id
      mp_item_url: mpData?.listing_url ?? null,          // marketplace listing URL
      status: normalizeStatus(mpData?.status)            // listed → live
    });
  }

  console.log("[vendoo.callback] normalized updates →", updates);

  // ------------------------------------------
  // 3) Write to DB
  // ------------------------------------------
  let successful = 0;

  for (const row of updates) {
    try {
      console.log("[vendoo.callback] writing:", row);

      const result = await sql`
        UPDATE app.item_marketplace_listing
           SET status     = ${row.status},
               mp_item_id = ${row.mp_item_id},
               mp_item_url = ${row.mp_item_url},
               updated_at = NOW()
         WHERE item_id = ${item_id}
           AND marketplace_id = ${row.marketplace_id};
      `;

      const count =
        Array.isArray(result)
          ? result[0]?.rowCount ?? 0
          : result?.rowCount ?? 0;

      if (!count) {
        console.warn("[vendoo.callback] ❗ No stub row found:", row);
      } else {
        successful++;
      }
    } catch (err) {
      console.error("[vendoo.callback] ❌ DB error", err);
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      updated: successful,
      attempted: updates.length
    }),
    { headers: { "content-type": "application/json" } }
  );
};
