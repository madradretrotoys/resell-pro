// /functions/api/inventory/meta.ts
// Cloudflare Pages Functions style: onRequestGet
// Requires an environment variable: DATABASE_URL (preferred) or NEON_DATABASE_URL
// Uses @neondatabase/serverless (HTTP driver)

// If your repo already has a DB helper or auth wrapper, you can replace the inline connection
// with your shared utilities. This endpoint is read-only and returns normalized dropdowns.

import { neon } from "@neondatabase/serverless";

type Env = {
  DATABASE_URL?: string;
  NEON_DATABASE_URL?: string;
};

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = ctx.env.DATABASE_URL || ctx.env.NEON_DATABASE_URL;
  if (!url) {
    return new Response(
      JSON.stringify({ error: "Missing DATABASE_URL/NEON_DATABASE_URL" }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  const sql = neon(url);

  // You can optionally enforce auth/permissions here by checking cookies/headers.
  // For Phase 1 this is intentionally minimal; the screen still calls ensureSession() client-side.

  // Fetch in parallel
  const [
    categories,
    marketplaceCategories,
    brands,
    conditions,
    colors,
    shippingBoxes,
    storeLocations,
    salesChannels,
  ] = await Promise.all([
    sql`SELECT category_name, category_code FROM sku_categories ORDER BY category_name ASC`,
    // Build a human-friendly "path" from leaf columns; ignore nulls.
    sql`
      SELECT
        display_name,
        CONCAT_WS(' | ', NULLIF(cat_leaf_1, ''), NULLIF(cat_leaf_2, ''), NULLIF(cat_leaf_3, ''),
                           NULLIF(cat_leaf_4, ''), NULLIF(cat_leaf_5, ''), NULLIF(cat_leaf_6, ''), NULLIF(cat_leaf_7, '')
        ) AS path
      FROM marketplace_categories
      ORDER BY display_name ASC
    `,
    sql`SELECT brand_name FROM marketplace_brands ORDER BY brand_name ASC`,
    sql`SELECT condition_name FROM marketplace_conditions ORDER BY condition_name ASC`,
    sql`SELECT color_name FROM marketplace_colors ORDER BY color_name ASC`,
    sql`SELECT box_name, weight_lb, weight_oz, length, width, height FROM shipping_boxes ORDER BY box_name ASC`,
    sql`SELECT instore_locations FROM instore_locations_1 ORDER BY instore_locations ASC`,
    sql`SELECT sales_channel FROM sales_channels ORDER BY sales_channel ASC`,
  ]);

  const payload = {
    categories: categories, // [{category_name, category_code}]
    marketplace: {
      categories: marketplaceCategories, // [{display_name, path}]
      brands: brands.map((r: any) => r.brand_name),
      conditions: conditions.map((r: any) => r.condition_name),
      colors: colors.map((r: any) => r.color_name),
    },
    shipping_boxes: shippingBoxes, // [{box_name, weight_lb, weight_oz, length, width, height}]
    store_locations: storeLocations.map((r: any) => r.instore_locations),
    sales_channels: salesChannels.map((r: any) => r.sales_channel),
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
};
