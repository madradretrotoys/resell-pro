import type { EnvWithSql } from "@/types"; // adjust to your actual Env type
import { json } from "@/lib/http";         // same helper you use in intake.ts
import { createSqlClient } from "@/lib/sql"; // your Neon client helper

export const onRequest: PagesFunction<EnvWithSql> = async (ctx) => {
  const { request, env } = ctx;
  const sql = createSqlClient(env);

  if (request.method !== "POST") {
    return json({ ok: false, error: "MethodNotAllowed" }, 405);
  }

  let body: any;
  try {
    body = await request.json();
  } catch (err) {
    console.error("[vendoo/callback] invalid_json", err);
    return json({ ok: false, error: "InvalidJSON" }, 400);
  }

  const {
    tenant_id,
    sku,
    vendoo_item_number,
    vendoo_item_url,
    error,
    error_message,
  } = body || {};

  console.log("[vendoo/callback] payload", {
    tenant_id,
    sku,
    vendoo_item_number,
    vendoo_item_url,
    error,
    error_message,
  });

  if (!tenant_id || !sku) {
    return json(
      { ok: false, error: "Missing tenant_id or sku in Vendoo callback" },
      400
    );
  }

  try {
    // Resolve Vendoo marketplace id
    const mpRows = await sql<{
      id: number;
      slug: string | null;
    }>`
      select id, slug
      from app.marketplaces_available
      where tenant_id = ${tenant_id}
        and lower(slug) = 'vendoo'
      limit 1
    `;

    if (!mpRows.length) {
      console.warn("[vendoo/callback] no_vendoo_marketplace", {
        tenant_id,
        sku,
      });
      return json(
        {
          ok: false,
          error: "Vendoo marketplace not configured for tenant",
        },
        400
      );
    }

    const vendooMarketplaceId = mpRows[0].id;

    // Find the item by SKU
    const itemRows = await sql<{
      id: number;
      sku: string;
    }>`
      select id, sku
      from app.items
      where tenant_id = ${tenant_id}
        and sku = ${sku}
      limit 1
    `;

    if (!itemRows.length) {
      console.warn("[vendoo/callback] item_not_found", {
        tenant_id,
        sku,
      });
      return json(
        {
          ok: false,
          error: "Item not found for given SKU",
        },
        404
      );
    }

    const itemId = itemRows[0].id;

    // Decide status based on success / error
    const status =
      error || !vendoo_item_number ? "error" : "listed";

    // Upsert into item_marketplace_listing for Vendoo
    const rows = await sql`
      insert into app.item_marketplace_listing (
        tenant_id,
        item_id,
        marketplace_id,
        mp_item_id,
        mp_item_url,
        status
      )
      values (
        ${tenant_id},
        ${itemId},
        ${vendooMarketplaceId},
        ${vendoo_item_number ?? null},
        ${vendoo_item_url ?? null},
        ${status}
      )
      on conflict (tenant_id, item_id, marketplace_id)
      do update set
        mp_item_id = excluded.mp_item_id,
        mp_item_url = excluded.mp_item_url,
        status = excluded.status,
        updated_at = now()
      returning id, mp_item_id, mp_item_url, status
    `;

    console.log("[vendoo/callback] upsert_ok", {
      tenant_id,
      sku,
      item_id: itemId,
      marketplace_id: vendooMarketplaceId,
      row: rows[0],
    });

    return json(
      {
        ok: true,
        tenant_id,
        sku,
        item_id: itemId,
        marketplace_id: vendooMarketplaceId,
        vendoo_item_number: vendoo_item_number ?? null,
        vendoo_item_url: vendoo_item_url ?? null,
        status,
      },
      200
    );
  } catch (err) {
    console.error("[vendoo/callback] unexpected_error", err);
    return json(
      {
        ok: false,
        error: "Unexpected error in Vendoo callback",
      },
      500
    );
  }
};

