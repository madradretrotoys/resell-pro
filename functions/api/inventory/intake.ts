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

    // Status: support Option A drafts; default to 'active' for existing flows
    const rawStatus = (body?.status || inv?.item_status || "active");
    const status = String(rawStatus).toLowerCase() === "draft" ? "draft" : "active";
    const isDraft = status === "draft";

    // Optional: if present, we update instead of insert
    const item_id_in: string | null = body?.item_id ? String(body.item_id) : null;

    // If the client requested a delete, do it now (and exit)
    if (body?.action === "delete") {
      if (!item_id_in) return json({ ok: false, error: "missing_item_id" }, 400);
      // inventory → item_listing_profile cascades ON DELETE
      await sql/*sql*/`
        DELETE FROM app.inventory
        WHERE item_id = ${item_id_in}
      `;
      return json({ ok: true, deleted: true, item_id: item_id_in }, 200);
    }
    
       // If item_id was provided, UPDATE existing rows instead of INSERT
        if (item_id_in) {
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

        // === DRAFT UPDATE: minimal fields only; no SKU allocation, no listing/profile upserts ===
        if (isDraft) {
          const updInv = await sql<{ item_id: string; sku: string | null }[]>`
            UPDATE app.inventory
            SET
              product_short_title = ${inv.product_short_title},
              item_status = 'draft'
            WHERE item_id = ${item_id_in}
            RETURNING item_id, sku
          `;
          const item_id = updInv[0].item_id;
          const retSku  = updInv[0].sku;
          return json({ ok: true, item_id, sku: retSku, status, ms: Date.now() - t0 }, 200);
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
          RETURNING item_id, sku
        `;

          const item_id = updInv[0].item_id;
          const retSku  = updInv[0].sku;
        
          // Upsert listing profile for this item_id
          await sql/*sql*/`
            INSERT INTO app.item_listing_profile
              (item_id, tenant_id, listing_category, item_condition, brand_name, primary_color,
               product_description, shipping_box, weight_lb, weight_oz, shipbx_length, shipbx_width, shipbx_height)
            VALUES
              (${item_id}, ${tenant_id}, ${lst.listing_category}, ${lst.item_condition}, ${lst.brand_name}, ${lst.primary_color},
               ${lst.product_description}, ${lst.shipping_box}, ${lst.weight_lb}, ${lst.weight_oz},
               ${lst.shipbx_length}, ${lst.shipbx_width}, ${lst.shipbx_height})
            ON CONFLICT (item_id) DO UPDATE SET
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

          // NEW: Upsert selected marketplaces into app.item_marketplace_listing (prototype: status 'draft')
          {
            const mpIds: number[] = Array.isArray(body?.marketplaces_selected)
              ? body.marketplaces_selected.map((n: any) => Number(n)).filter((n) => !Number.isNaN(n))
              : [];
            for (const mpId of mpIds) {
              await sql/*sql*/`
                INSERT INTO app.item_marketplace_listing (item_id, tenant_id, marketplace_id, status)
                VALUES (${item_id}, ${tenant_id}, ${mpId}, 'draft')
                ON CONFLICT (item_id, marketplace_id)
                DO UPDATE SET status = 'draft', updated_at = now()
              `;
            }
          }
          
          return json({ ok: true, item_id, sku: retSku, status, ms: Date.now() - t0 }, 200);
        }


    
        // Begin "transaction" (serverless best-effort: use explicit locks/constraints)
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
        // === CREATE DRAFT: minimal insert, no listing/profile, no marketplaces ===
    if (isDraft) {
      const invRows = await sql<{ item_id: string }[]>`
        INSERT INTO app.inventory
          (sku, product_short_title, item_status)
        VALUES
          (NULL, ${inv.product_short_title}, 'draft')
        RETURNING item_id
      `;
      const item_id = invRows[0].item_id;
      return json({ ok: true, item_id, sku: null, status: 'draft', ms: Date.now() - t0 }, 200);
    }

    // === CREATE ACTIVE: full flow (requires category for SKU allocation) ===
    // Look up category_code for active creates (now that we know it's needed)
    const catRows = await sql<{ category_code: string }[]>`
      SELECT category_code FROM app.sku_categories WHERE category_name = ${inv.category_nm} LIMIT 1
    `;
    if (catRows.length === 0) return json({ ok: false, error: "bad_category" }, 400);
    const category_code = catRows[0].category_code;

    // 1) Allocate next SKU (already guarded earlier; keep as-is)
    // 2) Insert full inventory
    const invRows = await sql<{ item_id: string }[]>`
      INSERT INTO app.inventory
        (sku, product_short_title, price, qty, cost_of_goods, category_nm, instore_loc, case_bin_shelf, instore_online, item_status)
      VALUES
        (${sku}, ${inv.product_short_title}, ${inv.price}, ${inv.qty}, ${inv.cost_of_goods},
         ${inv.category_nm}, ${inv.instore_loc}, ${inv.case_bin_shelf}, ${inv.instore_online}, 'active')
      RETURNING item_id
    `;
    const item_id = invRows[0].item_id;

    // 3) Insert listing profile (ACTIVE only)
    await sql/*sql*/`
      INSERT INTO app.item_listing_profile
        (item_id, tenant_id, listing_category, item_condition, brand_name, primary_color,
         product_description, shipping_box, weight_lb, weight_oz, shipbx_length, shipbx_width, shipbx_height)
      VALUES
        (${item_id}, ${tenant_id}, ${lst.listing_category}, ${lst.item_condition}, ${lst.brand_name}, ${lst.primary_color},
         ${lst.product_description}, ${lst.shipping_box}, ${lst.weight_lb}, ${lst.weight_oz},
         ${lst.shipbx_length}, ${lst.shipbx_width}, ${lst.shipbx_height})
    `;

    // (Marketplace upserts for ACTIVE creates can be added here later if desired)

    // 4) Return success
    return json({ ok: true, item_id, sku, status: 'active', ms: Date.now() - t0 }, 200);


  } catch (e: any) {
    // Try a friendlier error
    const msg = String(e?.message || e);
    if (/unique|duplicate/i.test(msg)) return json({ ok: false, error: "duplicate_sku" }, 409);
    return json({ ok: false, error: "server_error", message: msg }, 500);
  }
};
// end intake.ts file
