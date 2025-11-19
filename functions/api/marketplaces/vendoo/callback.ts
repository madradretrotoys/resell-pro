import { neon } from "@neondatabase/serverless";

// Vendoo callback: updates the existing stub row in app.item_marketplace_listing
// using the Vendoo item id + URL that Tampermonkey sends back.
// Pattern is intentionally parallel to facebook/callback.ts.
export const onRequestPost = async ({ request, env }) => {
  const sql = neon(env.DATABASE_URL);
  const body = await request.json().catch(() => ({}));

  console.log("[vendoo.callback] raw body →", body);

  const item_id = String(body?.item_id || "").trim();
  const status  = String(body?.status || "").trim().toLowerCase();
  const message = String(body?.message || "").trim() || null;

  // Vendoo-specific fields coming from the app / Tampermonkey
  const vendoo_item_number =
    body?.vendoo_item_number ? String(body.vendoo_item_number).trim() : null;
  const vendoo_item_url =
    body?.vendoo_item_url ? String(body.vendoo_item_url).trim() : null;

  console.log("[vendoo.callback] parsed →", {
    item_id,
    status,
    message,
    vendoo_item_number,
    vendoo_item_url,
  });

  // Require a valid item_id and a normalized status we understand
  if (!item_id || !["live", "error"].includes(status)) {
    console.warn("[vendoo.callback] bad payload — skipping DB write");
    return new Response(
      JSON.stringify({ ok: false, error: "bad_payload" }),
      {
        status: 400,
        headers: { "content-type": "application/json" },
      }
    );
  }

  // Vendoo marketplace id (keep this in sync with your seed data)
  const marketplace_id = 13; // Vendoo

  try {
    console.log("[vendoo.callback] updating DB →", {
      item_id,
      marketplace_id,
      status,
      vendoo_item_number,
      vendoo_item_url,
    });

    // 1) Update the existing stub row created earlier (status: 'publishing')
    //    We only UPDATE, same as the Facebook temp flow.
    const result = await sql`
      UPDATE app.item_marketplace_listing
         SET status     = ${status},
             last_error = ${message},
             mp_item_id = COALESCE(${vendoo_item_number}, app.item_marketplace_listing.mp_item_id),
             mp_item_url = COALESCE(${vendoo_item_url}, app.item_marketplace_listing.mp_item_url),
             updated_at = NOW()
       WHERE item_id = ${item_id}
         AND marketplace_id = ${marketplace_id};
    `;

    // 2) If nothing was updated, report clearly (we won't INSERT in this flow)
    const updated =
      Array.isArray(result) ? result[0]?.rowCount ?? 0 : result?.rowCount ?? 0;

    if (!updated) {
      console.warn(
        "[vendoo.callback] no row updated — missing stub? item_id:",
        item_id,
        "mp:",
        marketplace_id
      );
      return new Response(
        JSON.stringify({ ok: false, error: "missing_stub_row" }),
        {
          status: 409,
          headers: { "content-type": "application/json" },
        }
      );
    }

    console.log("[vendoo.callback] DB write complete ✅");

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const msg = (err && (err.message || err.toString())) || "unknown";
    console.error("[vendoo.callback] DB error ❌", msg);
    return new Response(
      JSON.stringify({ ok: false, error: "db_error", detail: msg }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      }
    );
  }
};
