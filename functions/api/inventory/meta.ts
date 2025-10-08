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
      storeLocations,
      salesChannels,
    ] = await Promise.all([
      sql`SELECT category_name, category_code FROM sku_categories ORDER BY category_name ASC`,
      sql`
        SELECT
          display_name,
          CONCAT_WS(' | ',
            NULLIF(cat_leaf_1, ''),
            NULLIF(cat_leaf_2, ''),
            NULLIF(cat_leaf_3, ''),
            NULLIF(cat_leaf_4, ''),
            NULLIF(cat_leaf_5, ''),
            NULLIF(cat_leaf_6, ''),
            NULLIF(cat_leaf_7, '')
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

    const payloadOut = {
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

    return json(payloadOut, 200);
  } catch (e: any) {
    return json({ ok: false, error: "server_error", message: e?.message || String(e) }, 500);
  }
};
