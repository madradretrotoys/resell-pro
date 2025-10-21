// functions/api/inventory/intake.ts
import { neon } from "@neondatabase/serverless";


type Role = "owner" | "admin" | "manager" | "clerk";
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

// Minimal HS256 verify (same pattern as other API files)
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
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", key, base64urlToBytes(s), enc.encode(data));
  if (!ok) throw new Error("bad_sig");
  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(p)));
  if ((payload as any)?.exp && Date.now() / 1000 > (payload as any).exp) throw new Error("expired");
  return payload;
}

export const onRequestPost: PagesFunction = async ({ request, env }) => {
  const t0 = Date.now();
  try {
    // AuthN
    const cookieHeader = request.headers.get("cookie") || "";
    const token = readCookie(cookieHeader, "__Host-rp_session");
    if (!token) return json({ ok: false, error: "no_cookie" }, 401);
    const payload = await verifyJwt(token, String(env.JWT_SECRET));
    const actor_user_id = String((payload as any).sub || "");
    if (!actor_user_id) return json({ ok: false, error: "bad_token" }, 401);

    // Tenant
    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) return json({ ok: false, error: "missing_tenant" }, 400);

    const sql = neon(String(env.DATABASE_URL));

    // Resolve eBay marketplace id once per request
    const ebayRow = await sql<{ id: number }[]>`SELECT id FROM app.marketplaces_available WHERE slug = 'ebay' LIMIT 1`;
    const EBAY_MARKETPLACE_ID = ebayRow[0]?.id ?? null;
    console.log("[intake] ctx", {
      tenant_id,
      actor_user_id,
      EBAY_MARKETPLACE_ID,
      request_ms: Date.now() - t0
    });

    // Normalize/null-out eBay fields according to pricing_format & toggles
    const normalizeEbay = (src: any) => {
      if (!src || typeof src !== "object") return null;
      const s: any = { ...src };
      const fmt = String(s.pricing_format || "").toLowerCase();
      const isFixed = fmt === "fixed";
      const isAuction = fmt === "auction";
      // coerce numbers
      const toNum = (v: any) => (v === "" || v == null ? null : Number(v));
      s.buy_it_now_price     = toNum(s.buy_it_now_price);
      s.starting_bid         = toNum(s.starting_bid);
      s.reserve_price        = toNum(s.reserve_price);
      s.promote_percent      = toNum(s.promote_percent);
      s.auto_accept_amount   = toNum(s.auto_accept_amount);
      s.minimum_offer_amount = toNum(s.minimum_offer_amount);
      // booleans
      s.promote = !!s.promote;
      s.allow_best_offer = !!s.allow_best_offer;
      // strings
      s.shipping_policy = (s.shipping_policy ?? "").trim() || null;
      s.payment_policy  = (s.payment_policy  ?? "").trim() || null;
      s.return_policy   = (s.return_policy   ?? "").trim() || null;
      s.shipping_zip    = (s.shipping_zip    ?? "").trim() || null;
      s.pricing_format  = fmt || null;
      s.duration        = (s.duration ?? "").trim() || null;

      // visibility rules -> null
      if (isFixed) {
        s.starting_bid = null;
        s.reserve_price = null;
        s.duration = null;
        if (!s.allow_best_offer) {
          s.auto_accept_amount = null;
          s.minimum_offer_amount = null;
        }
      }
      if (!s.promote) s.promote_percent = null;

      return s;
    };


    
    // AuthZ (creation requires can_inventory_intake or elevated role)
    const actor = await sql<{ role: Role; active: boolean; can_inventory_intake: boolean | null }[]>`
      SELECT m.role, m.active, COALESCE(p.can_inventory_intake, false) AS can_inventory_intake
      FROM app.memberships m
      LEFT JOIN app.permissions p ON p.user_id = m.user_id
      WHERE m.tenant_id = ${tenant_id} AND m.user_id = ${actor_user_id}
      LIMIT 1
    `;
    if (actor.length === 0 || actor[0].active === false) return json({ ok: false, error: "forbidden" }, 403);
    const allow = ["owner", "admin", "manager"].includes(actor[0].role) || !!actor[0].can_inventory_intake;
    if (!allow) return json({ ok: false, error: "forbidden" }, 403);

    
    
    // Payload
    const body = await request.json();
    const inv = body?.inventory || {};
    const lst = body?.listing || {};
    const ebay = body?.marketplace_listing?.ebay || null;
    
    // Status: support Option A drafts; default to 'active' for existing flows
    const rawStatus = (body?.status || inv?.item_status || "active");
    const status = String(rawStatus).toLowerCase() === "draft" ? "draft" : "active";
    const isDraft = status === "draft";
    
    // Optional: if present, we update instead of insert
    const item_id_in: string | null = body?.item_id ? String(body.item_id) : null;
    
    // === DEBUG: show payload routing decisions ===
    console.log("[intake] payload", {
      status,
      isDraft,
      item_id_in,
      marketplaces_selected: body?.marketplaces_selected ?? null,
      has_ebay_block: !!ebay,
      listing_keys_present: !!lst && Object.values(lst).some(v => v !== null && v !== undefined && String(v) !== "")
    });


    // If the client requested a delete, do it now (and exit)
    if (body?.action === "delete") {
      if (!item_id_in) return json({ ok: false, error: "missing_item_id" }, 400);

      // 1) Gather all images for this item (need r2_key for deletion)
      const imgRows = await sql<{ image_id: string; r2_key: string | null }[]>`
        SELECT image_id, r2_key
        FROM app.item_images
        WHERE item_id = ${item_id_in}
      `;
    
      // 2) Best-effort delete each object from R2
      for (const r of imgRows) {
        if (!r?.r2_key) continue;
        try {
          // R2 binding name matches your upload handler (R2_IMAGES)
          // @ts-ignore
          await env.R2_IMAGES.delete(r.r2_key);
        } catch (e) {
          // log but don't fail whole operation
          console.warn("r2.delete failed", r.r2_key, e);
        }
      }
    
      // 3) Remove image rows for this item
      await sql/*sql*/`
        DELETE FROM app.item_images
        WHERE item_id = ${item_id_in}
      `;
      
      // inventory → item_listing_profile cascades ON DELETE
      await sql/*sql*/`
        WITH s AS (
          SELECT set_config('app.actor_user_id', ${actor_user_id}, true)
        )
        DELETE FROM app.inventory
        WHERE item_id = ${item_id_in};
      `;
      return json({ ok: true, deleted: true, item_id: item_id_in }, 200);
    }
    
       // If item_id was provided, UPDATE existing rows instead of INSERT
        if (item_id_in) {
          console.log("[intake] branch", { kind: isDraft ? "UPDATE_DRAFT" : "UPDATE_ACTIVE", item_id_in });
        // Load existing inventory row
        const existing = await sql<{ item_id: string; sku: string | null; item_status: string | null }[]>`
          SELECT item_id, sku, item_status
          FROM app.inventory
          WHERE item_id = ${item_id_in}
          LIMIT 1
        `;
        if (existing.length === 0) {
          return json({ ok: false, error: "not_found" }, 404);
        }

        // === DRAFT UPDATE: update any inventory fields; also upsert listing if sent ===
        if (isDraft) {
          const updInv = await sql<{ item_id: string; sku: string | null }[]>`
            WITH s AS (
              SELECT set_config('app.actor_user_id', ${actor_user_id}, true)
            )
            UPDATE app.inventory
            SET
              product_short_title = ${inv.product_short_title},
              price = ${inv.price},
              qty = ${inv.qty},
              cost_of_goods = ${inv.cost_of_goods},
              category_nm = ${inv.category_nm},
              instore_loc = ${inv.instore_loc},
              case_bin_shelf = ${inv.case_bin_shelf},
              instore_online = ${inv.instore_online},
              item_status = 'draft'
            WHERE item_id = ${item_id_in}
            RETURNING item_id, sku;
          `;
          const item_id = updInv[0].item_id;
        
          if (lst && Object.values(lst).some(v => v !== null && v !== undefined && String(v) !== "")) {
            await sql/*sql*/`
            INSERT INTO app.item_listing_profile
              ( item_id, tenant_id,
                listing_category_key, condition_key, brand_key, color_key, shipping_box_key,
                listing_category,       item_condition,  brand_name,  primary_color,  shipping_box,
                product_description, weight_lb, weight_oz, shipbx_length, shipbx_width, shipbx_height )
            VALUES
              ( ${item_id}, ${tenant_id},
                ${lst.listing_category_key}, ${lst.condition_key}, ${lst.brand_key}, ${lst.color_key}, ${lst.shipping_box_key},
                (SELECT display_name    FROM app.marketplace_categories  WHERE category_key  = ${lst.listing_category_key}),
                (SELECT condition_name  FROM app.marketplace_conditions  WHERE condition_key = ${lst.condition_key}),
                (SELECT brand_name      FROM app.marketplace_brands      WHERE brand_key     = ${lst.brand_key}),
                (SELECT color_name      FROM app.marketplace_colors      WHERE color_key     = ${lst.color_key}),
                (SELECT box_name        FROM app.shipping_boxes          WHERE box_key       = ${lst.shipping_box_key}),
                ${lst.product_description}, ${lst.weight_lb}, ${lst.weight_oz},
                ${lst.shipbx_length}, ${lst.shipbx_width}, ${lst.shipbx_height}
              )
            ON CONFLICT (item_id) DO UPDATE SET
              listing_category_key = EXCLUDED.listing_category_key,
              condition_key        = EXCLUDED.condition_key,
              brand_key            = EXCLUDED.brand_key,
              color_key            = EXCLUDED.color_key,
              shipping_box_key     = EXCLUDED.shipping_box_key,
              listing_category     = EXCLUDED.listing_category,
              item_condition       = EXCLUDED.item_condition,
              brand_name           = EXCLUDED.brand_name,
              primary_color        = EXCLUDED.primary_color,
              shipping_box         = EXCLUDED.shipping_box,
              product_description  = EXCLUDED.product_description,
              weight_lb            = EXCLUDED.weight_lb,
              weight_oz            = EXCLUDED.weight_oz,
              shipbx_length        = EXCLUDED.shipbx_length,
              shipbx_width         = EXCLUDED.shipbx_width,
              shipbx_height        = EXCLUDED.shipbx_height
          `;
          }


          // Upsert eBay marketplace listing when present (draft update)
          if (EBAY_MARKETPLACE_ID && ebay) {
            const e = normalizeEbay(ebay);
            if (e) {
              await sql/*sql*/`
                INSERT INTO app.item_marketplace_listing
                  (item_id, tenant_id, marketplace_id, status,
                   shipping_policy, payment_policy, return_policy, shipping_zip, pricing_format,
                   buy_it_now_price, allow_best_offer, auto_accept_amount, minimum_offer_amount,
                   promote, promote_percent, duration, starting_bid, reserve_price)
                VALUES
                  (${item_id}, ${tenant_id}, ${EBAY_MARKETPLACE_ID}, 'draft',
                   ${e.shipping_policy}, ${e.payment_policy}, ${e.return_policy}, ${e.shipping_zip}, ${e.pricing_format},
                   ${e.buy_it_now_price}, ${e.allow_best_offer}, ${e.auto_accept_amount}, ${e.minimum_offer_amount},
                   ${e.promote}, ${e.promote_percent}, ${e.duration}, ${e.starting_bid}, ${e.reserve_price})
                ON CONFLICT (item_id, marketplace_id)
                DO UPDATE SET
                  status = 'draft',
                  shipping_policy = EXCLUDED.shipping_policy,
                  payment_policy  = EXCLUDED.payment_policy,
                  return_policy   = EXCLUDED.return_policy,
                  shipping_zip    = EXCLUDED.shipping_zip,
                  pricing_format  = EXCLUDED.pricing_format,
                  buy_it_now_price = EXCLUDED.buy_it_now_price,
                  allow_best_offer = EXCLUDED.allow_best_offer,
                  auto_accept_amount = EXCLUDED.auto_accept_amount,
                  minimum_offer_amount = EXCLUDED.minimum_offer_amount,
                  promote = EXCLUDED.promote,
                  promote_percent = EXCLUDED.promote_percent,
                  duration = EXCLUDED.duration,
                  starting_bid = EXCLUDED.starting_bid,
                  reserve_price = EXCLUDED.reserve_price,
                  updated_at = now()
              `;
              await sql/*sql*/`
                INSERT INTO app.user_marketplace_defaults
                  (tenant_id, user_id, marketplace_id,
                   shipping_policy, payment_policy, return_policy, shipping_zip, pricing_format,
                   allow_best_offer, promote)
                VALUES
                  (${tenant_id}, ${actor_user_id}, ${EBAY_MARKETPLACE_ID},
                   ${e.shipping_policy}, ${e.payment_policy}, ${e.return_policy}, ${e.shipping_zip}, ${e.pricing_format},
                   ${e.allow_best_offer}, ${e.promote})
                ON CONFLICT (tenant_id, user_id, marketplace_id)
                DO UPDATE SET
                  shipping_policy = EXCLUDED.shipping_policy,
                  payment_policy  = EXCLUDED.payment_policy,
                  return_policy   = EXCLUDED.return_policy,
                  shipping_zip    = EXCLUDED.shipping_zip,
                  pricing_format  = EXCLUDED.pricing_format,
                  allow_best_offer = EXCLUDED.allow_best_offer,
                  promote          = EXCLUDED.promote,
                  updated_at       = now()
              `;
            }
          }
          
          return json({ ok: true, item_id, sku: updInv[0].sku, status, ms: Date.now() - t0 }, 200);
        }


        // === ACTIVE UPDATE: if promoting to active and no SKU yet, allocate ===
        // Look up category_code only when needed for SKU allocation
        const catRows = await sql<{ category_code: string }[]>`
          SELECT category_code FROM app.sku_categories WHERE category_name = ${inv.category_nm} LIMIT 1
        `;
        if (catRows.length === 0) return json({ ok: false, error: "bad_category" }, 400);
        const category_code = catRows[0].category_code;

        let sku: string | null = existing[0].sku;
        if (!sku) {
          const seqRows = await sql<{ last_number: number }[]>`
            SELECT last_number FROM app.sku_sequence
            WHERE tenant_id = ${tenant_id} AND category_code = ${category_code}
            FOR UPDATE
          `;
          let next = 0;
          if (seqRows.length === 0) {
            await sql/*sql*/`
              INSERT INTO app.sku_sequence (tenant_id, category_code, last_number)
              VALUES (${tenant_id}, ${category_code}, 0)
              ON CONFLICT (tenant_id, category_code) DO NOTHING
            `;
            next = 1;
            await sql/*sql*/`
              UPDATE app.sku_sequence
              SET last_number = ${next}
              WHERE tenant_id = ${tenant_id} AND category_code = ${category_code}
            `;
          } else {
            next = Number(seqRows[0].last_number || 0) + 1;
            await sql/*sql*/`
              UPDATE app.sku_sequence
              SET last_number = ${next}
              WHERE tenant_id = ${tenant_id} AND category_code = ${category_code}
            `;
          }
          sku = `${category_code}${String(next).padStart(4, "0")}`;
        }

        // Full inventory update for ACTIVE
        const updInv = await sql<{ item_id: string; sku: string | null }[]>`
          WITH s AS (
            SELECT set_config('app.actor_user_id', ${actor_user_id}, true)
          )
          UPDATE app.inventory
          SET
            sku = ${sku},
            product_short_title = ${inv.product_short_title},
            price = ${inv.price},
            qty = ${inv.qty},
            cost_of_goods = ${inv.cost_of_goods},
            category_nm = ${inv.category_nm},
            instore_loc = ${inv.instore_loc},
            case_bin_shelf = ${inv.case_bin_shelf},
            instore_online = ${inv.instore_online},
            item_status = 'active'
          WHERE item_id = ${item_id_in}
          RETURNING item_id, sku;
        `;

          const item_id = updInv[0].item_id;
          const retSku  = updInv[0].sku;

          // Store Only: skip marketplace-related tables entirely
          const isStoreOnly = String(inv?.instore_online || "").toLowerCase().includes("store only");

          if (!isStoreOnly) {
            // Upsert listing profile for this item_id
            await sql/*sql*/`
              INSERT INTO app.item_listing_profile
                ( item_id, tenant_id,
                  listing_category_key, condition_key, brand_key, color_key, shipping_box_key,
                  listing_category,       item_condition,  brand_name,  primary_color,  shipping_box,
                  product_description, weight_lb, weight_oz, shipbx_length, shipbx_width, shipbx_height )
              VALUES
                ( ${item_id}, ${tenant_id},
                  ${lst.listing_category_key}, ${lst.condition_key}, ${lst.brand_key}, ${lst.color_key}, ${lst.shipping_box_key},
                  (SELECT display_name    FROM app.marketplace_categories  WHERE category_key  = ${lst.listing_category_key}),
                  (SELECT condition_name  FROM app.marketplace_conditions  WHERE condition_key = ${lst.condition_key}),
                  (SELECT brand_name      FROM app.marketplace_brands      WHERE brand_key     = ${lst.brand_key}),
                  (SELECT color_name      FROM app.marketplace_colors      WHERE color_key     = ${lst.color_key}),
                  (SELECT box_name        FROM app.shipping_boxes          WHERE box_key       = ${lst.shipping_box_key}),
                  ${lst.product_description}, ${lst.weight_lb}, ${lst.weight_oz},
                  ${lst.shipbx_length}, ${lst.shipbx_width}, ${lst.shipbx_height}
                )
            
              ON CONFLICT (item_id) DO UPDATE SET
                -- keys
                listing_category_key = EXCLUDED.listing_category_key,
                condition_key        = EXCLUDED.condition_key,
                brand_key            = EXCLUDED.brand_key,
                color_key            = EXCLUDED.color_key,
                shipping_box_key     = EXCLUDED.shipping_box_key,
                listing_category = EXCLUDED.listing_category,
                item_condition   = EXCLUDED.item_condition,
                brand_name       = EXCLUDED.brand_name,
                primary_color    = EXCLUDED.primary_color,
                product_description = EXCLUDED.product_description,
                shipping_box     = EXCLUDED.shipping_box,
                weight_lb        = EXCLUDED.weight_lb,
                weight_oz        = EXCLUDED.weight_oz,
                shipbx_length    = EXCLUDED.shipbx_length,
                shipbx_width     = EXCLUDED.shipbx_width,
                shipbx_height    = EXCLUDED.shipbx_height
            `;
  
            // Upsert selected marketplaces (prototype). Only eBay has field data today.
            {
              const mpIds: number[] = Array.isArray(body?.marketplaces_selected)
                ? body.marketplaces_selected.map((n: any) => Number(n)).filter((n) => !Number.isNaN(n))
                : [];

              // Normalize the ebay payload once
              const e = ebay ? normalizeEbay(ebay) : null;

              for (const mpId of mpIds) {
                // Only write the rich field set for eBay
                if (mpId === EBAY_MARKETPLACE_ID && e) {
                  await sql/*sql*/`
                    INSERT INTO app.item_marketplace_listing
                      (item_id, tenant_id, marketplace_id, status,
                       shipping_policy, payment_policy, return_policy, shipping_zip, pricing_format,
                       buy_it_now_price, allow_best_offer, auto_accept_amount, minimum_offer_amount,
                       promote, promote_percent, duration, starting_bid, reserve_price)
                    VALUES
                      (${item_id}, ${tenant_id}, ${mpId}, 'draft',
                       ${e.shipping_policy}, ${e.payment_policy}, ${e.return_policy}, ${e.shipping_zip}, ${e.pricing_format},
                       ${e.buy_it_now_price}, ${e.allow_best_offer}, ${e.auto_accept_amount}, ${e.minimum_offer_amount},
                       ${e.promote}, ${e.promote_percent}, ${e.duration}, ${e.starting_bid}, ${e.reserve_price})
                    ON CONFLICT (item_id, marketplace_id)
                    DO UPDATE SET
                      status = 'draft',
                      shipping_policy = EXCLUDED.shipping_policy,
                      payment_policy  = EXCLUDED.payment_policy,
                      return_policy   = EXCLUDED.return_policy,
                      shipping_zip    = EXCLUDED.shipping_zip,
                      pricing_format  = EXCLUDED.pricing_format,
                      buy_it_now_price = EXCLUDED.buy_it_now_price,
                      allow_best_offer = EXCLUDED.allow_best_offer,
                      auto_accept_amount = EXCLUDED.auto_accept_amount,
                      minimum_offer_amount = EXCLUDED.minimum_offer_amount,
                      promote = EXCLUDED.promote,
                      promote_percent = EXCLUDED.promote_percent,
                      duration = EXCLUDED.duration,
                      starting_bid = EXCLUDED.starting_bid,
                      reserve_price = EXCLUDED.reserve_price,
                      updated_at = now()
                  `;
                  await sql/*sql*/`
                INSERT INTO app.user_marketplace_defaults
                  (tenant_id, user_id, marketplace_id,
                   shipping_policy, payment_policy, return_policy, shipping_zip, pricing_format,
                   allow_best_offer, promote)
                VALUES
                  (${tenant_id}, ${actor_user_id}, ${EBAY_MARKETPLACE_ID},
                   ${e.shipping_policy}, ${e.payment_policy}, ${e.return_policy}, ${e.shipping_zip}, ${e.pricing_format},
                   ${e.allow_best_offer}, ${e.promote})
                ON CONFLICT (tenant_id, user_id, marketplace_id)
                DO UPDATE SET
                  shipping_policy = EXCLUDED.shipping_policy,
                  payment_policy  = EXCLUDED.payment_policy,
                  return_policy   = EXCLUDED.return_policy,
                  shipping_zip    = EXCLUDED.shipping_zip,
                  pricing_format  = EXCLUDED.pricing_format,
                  allow_best_offer = EXCLUDED.allow_best_offer,
                  promote          = EXCLUDED.promote,
                  updated_at       = now()
              `;
                }
              }
            }
          }
          return json({ ok: true, item_id, sku: retSku, status, ms: Date.now() - t0 }, 200);
        }


    
        // Begin "transaction" (serverless best-effort: use explicit locks/constraints)
        // Resolve category_code early for ACTIVE creates (needed for SKU allocation)
        let category_code: string | null = null;
        if (!isDraft) {
          const catRows = await sql<{ category_code: string }[]>`
            SELECT category_code
            FROM app.sku_categories
            WHERE category_name = ${inv.category_nm}
            LIMIT 1
          `;
          if (catRows.length === 0) {
            return json({ ok: false, error: "bad_category" }, 400);
          }
          category_code = catRows[0].category_code;
        }
        // 1) Allocate next SKU via sku_sequence (ACTIVE only). Drafts skip SKU.
        let sku: string | null = null;
        if (!isDraft) {
          const seqRows = await sql<{ last_number: number }[]>`
            SELECT last_number FROM app.sku_sequence
            WHERE tenant_id = ${tenant_id} AND category_code = ${category_code}
            FOR UPDATE
          `;
          let next = 0;
          if (seqRows.length === 0) {
            await sql/*sql*/`
              INSERT INTO app.sku_sequence (tenant_id, category_code, last_number)
              VALUES (${tenant_id}, ${category_code}, 0)
              ON CONFLICT (tenant_id, category_code) DO NOTHING
            `;
            next = 1;
            await sql/*sql*/`
              UPDATE app.sku_sequence
              SET last_number = ${next}
              WHERE tenant_id = ${tenant_id} AND category_code = ${category_code}
            `;
          } else {
            next = Number(seqRows[0].last_number || 0) + 1;
            await sql/*sql*/`
              UPDATE app.sku_sequence
              SET last_number = ${next}
              WHERE tenant_id = ${tenant_id} AND category_code = ${category_code}
            `;
          }
          sku = `${category_code}${String(next).padStart(4, "0")}`;
        }


    // 2) Insert into inventory (drafts carry NULL sku; active allocates)
    // === CREATE DRAFT: store any provided inventory fields; also upsert listing if sent ===
    if (isDraft) {
      console.log("[intake] branch", { kind: "CREATE_DRAFT" });
      const invRows = await sql<{ item_id: string }[]>`
        WITH s AS (
          SELECT set_config('app.actor_user_id', ${actor_user_id}, true)
        )
        INSERT INTO app.inventory
          (sku, product_short_title, price, qty, cost_of_goods, category_nm, instore_loc, case_bin_shelf, instore_online, item_status)
        VALUES
          (NULL, ${inv.product_short_title}, ${inv.price}, ${inv.qty}, ${inv.cost_of_goods},
           ${inv.category_nm}, ${inv.instore_loc}, ${inv.case_bin_shelf}, ${inv.instore_online}, 'draft')
        RETURNING item_id
      `;
      const item_id = invRows[0].item_id;
    
      // If the client provided any listing fields for the draft, persist them too
      if (lst && Object.values(lst).some(v => v !== null && v !== undefined && String(v) !== "")) {
        await sql/*sql*/`
          INSERT INTO app.item_listing_profile
            ( item_id, tenant_id,
              listing_category_key, condition_key, brand_key, color_key, shipping_box_key,
              listing_category,       item_condition,  brand_name,  primary_color,  shipping_box,
              product_description, weight_lb, weight_oz, shipbx_length, shipbx_width, shipbx_height )
          VALUES
            ( ${item_id}, ${tenant_id},
              ${lst.listing_category_key}, ${lst.condition_key}, ${lst.brand_key}, ${lst.color_key}, ${lst.shipping_box_key},
              (SELECT display_name    FROM app.marketplace_categories  WHERE category_key  = ${lst.listing_category_key}),
              (SELECT condition_name  FROM app.marketplace_conditions  WHERE condition_key = ${lst.condition_key}),
              (SELECT brand_name      FROM app.marketplace_brands      WHERE brand_key     = ${lst.brand_key}),
              (SELECT color_name      FROM app.marketplace_colors      WHERE color_key     = ${lst.color_key}),
              (SELECT box_name        FROM app.shipping_boxes          WHERE box_key       = ${lst.shipping_box_key}),
              ${lst.product_description}, ${lst.weight_lb}, ${lst.weight_oz},
              ${lst.shipbx_length}, ${lst.shipbx_width}, ${lst.shipbx_height}
            )
        ON CONFLICT (item_id) DO UPDATE SET
            -- keys
            listing_category_key = EXCLUDED.listing_category_key,
            condition_key        = EXCLUDED.condition_key,
            brand_key            = EXCLUDED.brand_key,
            color_key            = EXCLUDED.color_key,
            shipping_box_key     = EXCLUDED.shipping_box_key,
            listing_category = EXCLUDED.listing_category,
            item_condition   = EXCLUDED.item_condition,
            brand_name       = EXCLUDED.brand_name,
            primary_color    = EXCLUDED.primary_color,
            product_description = EXCLUDED.product_description,
            shipping_box     = EXCLUDED.shipping_box,
            weight_lb        = EXCLUDED.weight_lb,
            weight_oz        = EXCLUDED.weight_oz,
            shipbx_length    = EXCLUDED.shipbx_length,
            shipbx_width     = EXCLUDED.shipbx_width,
            shipbx_height    = EXCLUDED.shipbx_height
        `;
      }

      // Upsert eBay marketplace listing when present (draft create)
      if (EBAY_MARKETPLACE_ID && ebay) {
        const e = normalizeEbay(ebay);
        if (e) {
          await sql/*sql*/`
            INSERT INTO app.item_marketplace_listing
              (item_id, tenant_id, marketplace_id, status,
               shipping_policy, payment_policy, return_policy, shipping_zip, pricing_format,
               buy_it_now_price, allow_best_offer, auto_accept_amount, minimum_offer_amount,
               promote, promote_percent, duration, starting_bid, reserve_price)
            VALUES
              (${item_id}, ${tenant_id}, ${EBAY_MARKETPLACE_ID}, 'draft',
               ${e.shipping_policy}, ${e.payment_policy}, ${e.return_policy}, ${e.shipping_zip}, ${e.pricing_format},
               ${e.buy_it_now_price}, ${e.allow_best_offer}, ${e.auto_accept_amount}, ${e.minimum_offer_amount},
               ${e.promote}, ${e.promote_percent}, ${e.duration}, ${e.starting_bid}, ${e.reserve_price})
            ON CONFLICT (item_id, marketplace_id)
            DO UPDATE SET
              status = 'draft',
              shipping_policy = EXCLUDED.shipping_policy,
              payment_policy  = EXCLUDED.payment_policy,
              return_policy   = EXCLUDED.return_policy,
              shipping_zip    = EXCLUDED.shipping_zip,
              pricing_format  = EXCLUDED.pricing_format,
              buy_it_now_price = EXCLUDED.buy_it_now_price,
              allow_best_offer = EXCLUDED.allow_best_offer,
              auto_accept_amount = EXCLUDED.auto_accept_amount,
              minimum_offer_amount = EXCLUDED.minimum_offer_amount,
              promote = EXCLUDED.promote,
              promote_percent = EXCLUDED.promote_percent,
              duration = EXCLUDED.duration,
              starting_bid = EXCLUDED.starting_bid,
              reserve_price = EXCLUDED.reserve_price,
              updated_at = now()
          `;

          await sql/*sql*/`
              INSERT INTO app.user_marketplace_defaults
                (tenant_id, user_id, marketplace_id,
                 shipping_policy, payment_policy, return_policy, shipping_zip, pricing_format,
                 allow_best_offer, promote)
              VALUES
                (${tenant_id}, ${actor_user_id}, ${EBAY_MARKETPLACE_ID},
                 ${e.shipping_policy}, ${e.payment_policy}, ${e.return_policy}, ${e.shipping_zip}, ${e.pricing_format},
                 ${e.allow_best_offer}, ${e.promote})
              ON CONFLICT (tenant_id, user_id, marketplace_id)
              DO UPDATE SET
                shipping_policy = EXCLUDED.shipping_policy,
                payment_policy  = EXCLUDED.payment_policy,
                return_policy   = EXCLUDED.return_policy,
                shipping_zip    = EXCLUDED.shipping_zip,
                pricing_format  = EXCLUDED.pricing_format,
                allow_best_offer = EXCLUDED.allow_best_offer,
                promote          = EXCLUDED.promote,
                updated_at       = now()
            `;
        }
      }
      
      return json({ ok: true, item_id, sku: null, status: 'draft', ms: Date.now() - t0 }, 200);
    }

   // 1) Allocate next SKU (already guarded earlier; keep as-is)
    // 2) Insert full inventory
    console.log("[intake] branch", { kind: "CREATE_ACTIVE" });
    const invRows = await sql<{ item_id: string }[]>`
      WITH s AS (
        SELECT set_config('app.actor_user_id', ${actor_user_id}, true)
      )
      INSERT INTO app.inventory
        (sku, product_short_title, price, qty, cost_of_goods, category_nm, instore_loc, case_bin_shelf, instore_online, item_status)
      VALUES
        (${sku}, ${inv.product_short_title}, ${inv.price}, ${inv.qty}, ${inv.cost_of_goods},
         ${inv.category_nm}, ${inv.instore_loc}, ${inv.case_bin_shelf}, ${inv.instore_online}, 'active')
      RETURNING item_id
    `;
    const item_id = invRows[0].item_id;
    // Store Only: skip marketplace-related tables
    const isStoreOnly = String(inv?.instore_online || "").toLowerCase().includes("store only");

    if (!isStoreOnly) {
      // 3) Insert listing profile (ACTIVE only)
      await sql/*sql*/`
      INSERT INTO app.item_listing_profile
        ( item_id, tenant_id,
          listing_category_key, condition_key, brand_key, color_key, shipping_box_key,
          listing_category,       item_condition,  brand_name,  primary_color,  shipping_box,
          product_description, weight_lb, weight_oz, shipbx_length, shipbx_width, shipbx_height )
      VALUES
        ( ${item_id}, ${tenant_id},
          ${lst.listing_category_key}, ${lst.condition_key}, ${lst.brand_key}, ${lst.color_key}, ${lst.shipping_box_key},
          (SELECT display_name    FROM app.marketplace_categories  WHERE category_key  = ${lst.listing_category_key}),
          (SELECT condition_name  FROM app.marketplace_conditions  WHERE condition_key = ${lst.condition_key}),
          (SELECT brand_name      FROM app.marketplace_brands      WHERE brand_key     = ${lst.brand_key}),
          (SELECT color_name      FROM app.marketplace_colors      WHERE color_key     = ${lst.color_key}),
          (SELECT box_name        FROM app.shipping_boxes          WHERE box_key       = ${lst.shipping_box_key}),
          ${lst.product_description}, ${lst.weight_lb}, ${lst.weight_oz},
          ${lst.shipbx_length}, ${lst.shipbx_width}, ${lst.shipbx_height}
        )
        ON CONFLICT (item_id) DO UPDATE SET
          -- keys
          listing_category_key = EXCLUDED.listing_category_key,
          condition_key        = EXCLUDED.condition_key,
          brand_key            = EXCLUDED.brand_key,
          color_key            = EXCLUDED.color_key,
          shipping_box_key     = EXCLUDED.shipping_box_key,
          -- labels / other
          listing_category     = EXCLUDED.listing_category,
          item_condition       = EXCLUDED.item_condition,
          brand_name           = EXCLUDED.brand_name,
          primary_color        = EXCLUDED.primary_color,
          product_description  = EXCLUDED.product_description,
          shipping_box         = EXCLUDED.shipping_box,
          weight_lb            = EXCLUDED.weight_lb,
          weight_oz            = EXCLUDED.weight_oz,
          shipbx_length        = EXCLUDED.shipbx_length,
          shipbx_width         = EXCLUDED.shipbx_width,
          shipbx_height        = EXCLUDED.shipbx_height
      `;
    }

    // Upsert eBay marketplace listing when present (active create)
    if (EBAY_MARKETPLACE_ID && ebay) {
      const e = normalizeEbay(ebay);
      if (e) {
        await sql/*sql*/`
          INSERT INTO app.item_marketplace_listing
            (item_id, tenant_id, marketplace_id, status,
             shipping_policy, payment_policy, return_policy, shipping_zip, pricing_format,
             buy_it_now_price, allow_best_offer, auto_accept_amount, minimum_offer_amount,
             promote, promote_percent, duration, starting_bid, reserve_price)
          VALUES
            (${item_id}, ${tenant_id}, ${EBAY_MARKETPLACE_ID}, 'draft',
             ${e.shipping_policy}, ${e.payment_policy}, ${e.return_policy}, ${e.shipping_zip}, ${e.pricing_format},
             ${e.buy_it_now_price}, ${e.allow_best_offer}, ${e.auto_accept_amount}, ${e.minimum_offer_amount},
             ${e.promote}, ${e.promote_percent}, ${e.duration}, ${e.starting_bid}, ${e.reserve_price})
          ON CONFLICT (item_id, marketplace_id)
          DO UPDATE SET
            status = 'draft',
            shipping_policy = EXCLUDED.shipping_policy,
            payment_policy  = EXCLUDED.payment_policy,
            return_policy   = EXCLUDED.return_policy,
            shipping_zip    = EXCLUDED.shipping_zip,
            pricing_format  = EXCLUDED.pricing_format,
            buy_it_now_price = EXCLUDED.buy_it_now_price,
            allow_best_offer = EXCLUDED.allow_best_offer,
            auto_accept_amount = EXCLUDED.auto_accept_amount,
            minimum_offer_amount = EXCLUDED.minimum_offer_amount,
            promote = EXCLUDED.promote,
            promote_percent = EXCLUDED.promote_percent,
            duration = EXCLUDED.duration,
            starting_bid = EXCLUDED.starting_bid,
            reserve_price = EXCLUDED.reserve_price,
            updated_at = now()
        `;
        await sql/*sql*/`
        INSERT INTO app.user_marketplace_defaults
          (tenant_id, user_id, marketplace_id,
           shipping_policy, payment_policy, return_policy, shipping_zip, pricing_format,
           allow_best_offer, promote)
        VALUES
          (${tenant_id}, ${actor_user_id}, ${EBAY_MARKETPLACE_ID},
           ${e.shipping_policy}, ${e.payment_policy}, ${e.return_policy}, ${e.shipping_zip}, ${e.pricing_format},
           ${e.allow_best_offer}, ${e.promote})
        ON CONFLICT (tenant_id, user_id, marketplace_id)
        DO UPDATE SET
          shipping_policy = EXCLUDED.shipping_policy,
          payment_policy  = EXCLUDED.payment_policy,
          return_policy   = EXCLUDED.return_policy,
          shipping_zip    = EXCLUDED.shipping_zip,
          pricing_format  = EXCLUDED.pricing_format,
          allow_best_offer = EXCLUDED.allow_best_offer,
          promote          = EXCLUDED.promote,
          updated_at       = now()
      `;
      }
    }

    
    // 4) Enqueue marketplace publish jobs (non-blocking) with detailed logs
    try {
      const rawSel = Array.isArray(body?.marketplaces_selected) ? body.marketplaces_selected : [];
      console.log("[intake] enqueue.start", { item_id, status, rawSel });
    
      // Accept slugs (strings) and numeric ids (numbers OR numeric strings)
      const slugs = rawSel
        .filter((v: any) => typeof v === "string" && isNaN(Number(v)) && v.trim() !== "")
        .map((s: string) => s.toLowerCase());
      const ids = rawSel
        .map((v: any) => (typeof v === "number" && Number.isInteger(v)) ? v
          : (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null))
        .filter((n: number | null): n is number => n !== null);
    
      console.log("[intake] enqueue.parsed", { slugs, ids });
    
      if (slugs.length === 0 && ids.length === 0) {
        console.log("[intake] enqueue.skip_no_selection");
      } else {
        // Resolve tenant-enabled marketplaces by either slug OR id
        const rows = await sql/*sql*/`
          SELECT ma.id, ma.slug
          FROM app.marketplaces_available ma
          JOIN app.tenant_marketplaces tm
            ON tm.marketplace_id = ma.id
           AND tm.tenant_id = ${tenant_id}
           AND tm.enabled = true
          WHERE (${slugs.length > 0} AND ma.slug = ANY(${slugs}))
             OR (${ids.length > 0}   AND ma.id   = ANY(${ids}))
        `;
        console.log("[intake] enqueue.match_enabled", { count: rows.length, rows });
    
        for (const r of rows) {
          console.log("[intake] enqueue.insert_job", { marketplace_id: r.id, slug: r.slug, item_id });
          await sql/*sql*/`
            INSERT INTO app.marketplace_publish_jobs
              (tenant_id, item_id, marketplace_id, op, status)
            SELECT ${tenant_id}, ${item_id}, ${r.id}, 'create', 'queued'
            WHERE NOT EXISTS (
              SELECT 1 FROM app.marketplace_publish_jobs j
              WHERE j.tenant_id = ${tenant_id}
                AND j.item_id = ${item_id}
                AND j.marketplace_id = ${r.id}
                AND j.op = 'create'
                AND j.status IN ('queued','running')
            )
          `;
    
          console.log("[intake] enqueue.flip_iml_pending", { marketplace_id: r.id, item_id });
          await sql/*sql*/`
            UPDATE app.item_marketplace_listing
               SET updated_at = now()
             WHERE tenant_id = ${tenant_id}
               AND item_id = ${item_id}
               AND marketplace_id = ${r.id}
               AND status IN ('draft')
          `;
        }
      }
    
      console.log("[intake] enqueue.done", { item_id });
    } catch (enqueueErr) {
      console.error("[intake] enqueue.error", { item_id, error: String(enqueueErr) });
      await sql/*sql*/`
        INSERT INTO app.item_marketplace_events
          (item_id, tenant_id, marketplace_id, kind, error_message)
        VALUES (${item_id}, ${tenant_id}, ${EBAY_MARKETPLACE_ID}, 'enqueue_failed', ${String(enqueueErr).slice(0,500)})
      `;
    }  
    
    // Do NOT run publish inline.
    // Look up any jobs we just queued for this item so the client can trigger them by job_id.
    const enqueued = await sql/*sql*/`
      SELECT job_id
      FROM app.marketplace_publish_jobs
      WHERE tenant_id = ${tenant_id}
        AND item_id   = ${item_id}
        AND status    = 'queued'
      ORDER BY created_at ASC
    `;

    const job_ids = Array.isArray(enqueued) ? enqueued.map((r: any) => String(r.job_id)) : [];

    return json({
      ok: true,
      item_id,
      sku,
      status,
      published: false,
      job_ids,
      ms: Date.now() - t0
    }, 200);

  } catch (e: any) {
    // Try a friendlier error
    const msg = String(e?.message || e);
    if (/unique|duplicate/i.test(msg)) return json({ ok: false, error: "duplicate_sku" }, 409);
    return json({ ok: false, error: "server_error", message: msg }, 500);
  }
};

// Read a single item (inventory + optional listing profile) by item_id
export const onRequestGet: PagesFunction = async ({ request, env }) => {
  try {
    // AuthN
    const cookieHeader = request.headers.get("cookie") || "";
    const token = (function readCookie(header: string, name: string): string | null {
      if (!header) return null;
      for (const part of header.split(/; */)) {
        const [k, ...rest] = part.split("=");
        if (k === name) return decodeURIComponent(rest.join("="));
      }
      return null;
    })(cookieHeader, "__Host-rp_session");
    if (!token) return new Response(JSON.stringify({ ok: false, error: "no_cookie" }), { status: 401, headers: { "content-type": "application/json" } });

    // Verify JWT (reuse the inline HS256 verifier pattern)
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
      const key = await crypto.subtle.importKey("raw", enc.encode(String(env.JWT_SECRET)), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
      const ok = await crypto.subtle.verify("HMAC", key, base64urlToBytes(s), enc.encode(data));
      if (!ok) throw new Error("bad_sig");
      const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(p)));
      if ((payload as any)?.exp && Date.now() / 1000 > (payload as any).exp) throw new Error("expired");
      return payload;
    }
    await verifyJwt(token, String(env.JWT_SECRET));

    // Tenant (required for listing profile lookups)
    const tenant_id = request.headers.get("x-tenant-id");
    if (!tenant_id) {
      return new Response(JSON.stringify({ ok: false, error: "missing_tenant" }), { status: 400, headers: { "content-type": "application/json" } });
    }

    const url = new URL(request.url);
    const item_id = url.searchParams.get("item_id");
    if (!item_id) {
      return new Response(JSON.stringify({ ok: false, error: "missing_item_id" }), { status: 400, headers: { "content-type": "application/json" } });
    }

    const sql = neon(String(env.DATABASE_URL));

    // Load inventory row
    const invRows = await sql<any[]>`
      SELECT *
      FROM app.inventory
      WHERE item_id = ${item_id}
      LIMIT 1
    `;
    if (invRows.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
    }

    // Load listing profile (only for this tenant, if present)
    const lstRows = await sql<any[]>`
      SELECT *
      FROM app.item_listing_profile
      WHERE item_id = ${item_id} AND tenant_id = ${tenant_id}
      LIMIT 1
    `;

    // Load images for this item (scoped by tenant)
    const imgRows = await sql<any[]>`
      SELECT image_id, r2_key, cdn_url, is_primary, sort_order,
             content_type, bytes, width_px, height_px
      FROM app.item_images
      WHERE item_id = ${item_id} AND tenant_id = ${tenant_id}
      ORDER BY sort_order ASC, created_at ASC
    `;

    // Load the eBay marketplace listing row (if any) to hydrate edit UI
    const ebayIdRows = await sql<{ id: number }[]>`
      SELECT id FROM app.marketplaces_available WHERE slug = 'ebay' LIMIT 1
    `;
    const EBAY_ID = ebayIdRows[0]?.id ?? null;

    let ebayListing: any = null;
    if (EBAY_ID != null) {
      const rows = await sql<any[]>`
        SELECT
          status,
          shipping_policy, payment_policy, return_policy, shipping_zip, pricing_format,
          buy_it_now_price, allow_best_offer, auto_accept_amount, minimum_offer_amount,
          promote, promote_percent, duration, starting_bid, reserve_price
        FROM app.item_marketplace_listing
        WHERE item_id = ${item_id} AND tenant_id = ${tenant_id} AND marketplace_id = ${EBAY_ID}
        LIMIT 1
      `;
      if (rows.length) ebayListing = rows[0];
    }

    
    return new Response(JSON.stringify({
      ok: true,
      inventory: invRows[0],
      listing: lstRows[0] || null,
      images: imgRows,
      marketplace_listing: { ebay: ebayListing, ebay_marketplace_id: EBAY_ID }
    }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });


    
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: "server_error", message: String(e?.message || e) }), { status: 500, headers: { "content-type": "application/json" } });
  }
};

// end intake.ts file
