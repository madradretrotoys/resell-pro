//Begin meta.ts
// /functions/api/inventory/meta.ts
// Cloudflare Pages Functions style: onRequestGet
// Uses @neondatabase/serverless (HTTP driver).
// HOT-FIX: Keep response shape; relax strict JWT + tenant requirements so Intake can populate reliably.

import { neon } from "@neondatabase/serverless";

type Env = {
  DATABASE_URL?: string;
  NEON_DATABASE_URL?: string;
};

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "vary": "Cookie",
    },
  });

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    // 0) Minimal auth presence: require a cookie header (user is signed in), but do not verify JWT here.
    const cookieHeader = request.headers.get("cookie");
    if (!cookieHeader) return json({ ok: false, error: "no_cookie" }, 401);

    // Tenant header is OPTIONAL for this meta (tables are global / not tenant-scoped)
    // const tenantId = request.headers.get("x-tenant-id") || null;

    // 1) DB connect
    const url = env.DATABASE_URL || env.NEON_DATABASE_URL;
    if (!url) return json({ ok: false, error: "missing_db_url" }, 500);
    const sql = neon(url);

    // 2) Fetch dropdown data in parallel (unchanged queries / shape)
    const [
      categories,
      marketplaceCategories,
      brands,
      conditions,
      colors,
      shippingBoxes,
      shippingTiers,
      shippingPackagingPresets,
      storeLocations,
      salesChannels,
    ] = await Promise.all([
    
      sql`SELECT category_name, category_code FROM app.sku_categories ORDER BY category_name ASC`,
      // Narrowed to display_name only; no path/concat
      sql`SELECT display_name, category_key FROM app.marketplace_categories ORDER BY display_name ASC`,
      sql`SELECT brand_name, brand_key FROM app.marketplace_brands ORDER BY brand_name ASC`,
      sql`SELECT condition_name, condition_key FROM app.marketplace_conditions ORDER BY condition_name ASC`,
      sql`SELECT color_name, color_key FROM app.marketplace_colors ORDER BY color_name ASC`,
      sql`SELECT box_key, box_name, weight_lb, weight_oz, length, width, height FROM app.shipping_boxes ORDER BY box_name ASC`,
      // NEW: shipping tiers (for Calculated Shipping Tier dropdown + later calc rules)
      sql`SELECT
            tier_key,
            carrier,
            service,
            tier_code,
            tier_label,
            weight_oz_min,
            weight_oz_max,
            dim_divisor,
            max_length_in,
            max_girth_in,
            max_length_plus_girth_in,
            sort_order
          FROM app.shipping_tiers
          WHERE is_active = true
          ORDER BY carrier ASC, service ASC, sort_order ASC, weight_oz_max ASC`,
    
            // NEW: packaging presets (for calculated shipping logic)
        sql`SELECT
              preset_key,
              preset_code,
              preset_label,
  
              -- NEW Option B columns
              dim_profile,
              oversize_height_equals_width,
              min_box_length_in,
              min_box_width_in,
              min_box_height_in,
              min_billable_oz,
              safezone_bump_oz,
  
              -- existing "wiggle room" additive knobs
              add_weight_oz,
              add_length_in,
              add_width_in,
              add_height_in,
  
              sort_order,
              notes
            FROM app.shipping_packaging_presets
            WHERE is_active = true
            ORDER BY sort_order ASC, preset_label ASC`,

      sql`SELECT instore_locations FROM app.instore_locations_1 ORDER BY instore_locations ASC`,
      sql`SELECT sales_channel FROM app.sales_channels ORDER BY sales_channel ASC`,
    ]);

    // NEW: (optional) tenant for marketplace enablement/connection flags
    const tenantId = request.headers.get("x-tenant-id") || null;

    // NEW: available marketplaces + tenant flags
    const marketplaces = await sql/*sql*/`
      SELECT
        ma.id,
        ma.slug,
        ma.marketplace_name,
        ma.is_active,
        ma.ui_notes,
        COALESCE(tm.enabled, false) AS enabled_for_tenant,
        (mc.status = 'connected')   AS is_connected
      FROM app.marketplaces_available ma
      LEFT JOIN app.tenant_marketplaces tm
        ON tm.marketplace_id = ma.id AND tm.tenant_id = ${tenantId}
      LEFT JOIN app.marketplace_connections mc
        ON mc.marketplace_id = ma.id AND mc.tenant_id = ${tenantId}
      WHERE ma.is_active = true
      ORDER BY ma.marketplace_name ASC
    `;
 
    const payloadOut = {
      categories, // [{category_name, category_code}]
      marketplace: {
        // include keys so UI can use UUIDs immediately
        categories: marketplaceCategories.map((r: any) => ({
          display_name: r.display_name, category_key: r.category_key, path: ""
        })),
        brands:     brands.map((r: any) => ({ brand_name: r.brand_name,         brand_key: r.brand_key })),
        conditions: conditions.map((r: any) => ({ condition_name: r.condition_name, condition_key: r.condition_key })),
        colors:     colors.map((r: any) => ({ color_name: r.color_name,         color_key: r.color_key })),
      },
      marketplaces,
      // keep all shipping fields + the new box_key
      shipping_boxes: shippingBoxes, // [{box_key, box_name, weight_lb, weight_oz, length, width, height}]
      // NEW: tiers + packaging presets for calculated shipping workflow
      shipping_tiers: shippingTiers, // [{tier_key, carrier, service, tier_code, tier_label, weight_oz_min, weight_oz_max, dim_divisor, ...}]
      shipping_packaging_presets: shippingPackagingPresets, // [{preset_key, preset_code, preset_label, add_weight_oz, add_length_in, ...}]
      store_locations: storeLocations.map((r: any) => r.instore_locations),
      sales_channels:  salesChannels.map((r: any) => r.sales_channel),
    };
    
    return json(payloadOut, 200);
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
//end meta.ts
