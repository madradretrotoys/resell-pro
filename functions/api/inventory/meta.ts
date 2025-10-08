// /functions/api/inventory/meta.ts
// Cloudflare Pages Functions style: onRequestGet
// Requires env: DATABASE_URL (preferred) or NEON_DATABASE_URL, and JWT_SECRET for auth parity.
// Uses @neondatabase/serverless (HTTP driver).
// NOTE: Response shape is unchanged to avoid breaking the Intake screen.

import { neon } from "@neondatabase/serverless";

type Env = {
  DATABASE_URL?: string;
  NEON_DATABASE_URL?: string;
  JWT_SECRET?: string;
};

// Small helpers (mirrors pattern used in other inventory endpoints)
const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "vary": "Cookie",
    },
  });

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/; */)) {
    const [k, ...rest] = part.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

async function verifyJwt(token: string, secret: string): Promise<Record<string, any>> {
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
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", key, base64urlToBytes(s), enc.encode(data));
  if (!ok) throw new Error("bad_sig");
  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(p)));
  if ((payload as any)?.exp && Date.now() / 1000 > (payload as any).exp) throw new Error("expired");
  return payload;
}

export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    // 1) AuthN: session cookie required
    const cookieHeader = request.headers.get("cookie");
    const token = readCookie(cookieHeader, "__Host-rp_session");
    if (!token) return json({ ok: false, error: "no_cookie" }, 401);
    if (!env.JWT_SECRET) return json({ ok: false, error: "missing_jwt_secret" }, 500);

    const payload = await verifyJwt(token, String(env.JWT_SECRET));
    const actor_user_id = String((payload as any).sub || "");
    if (!actor_user_id) return json({ ok: false, error: "bad_token" }, 401);

    // 2) Tenant header required (client sets via assets/js/api.js after ensureSession)
    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) return json({ ok: false, error: "missing_tenant" }, 400);

    // 3) DB connect
    const url = env.DATABASE_URL || env.NEON_DATABASE_URL;
    if (!url) return json({ ok: false, error: "missing_db_url" }, 500);
    const sql = neon(url);

    // 4) Fetch dropdown data in parallel (unchanged queries / shape)
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
