// functions/api/inventory/intake.ts
import { neon } from "@neondatabase/serverless";


type Role = "owner" | "admin" | "manager" | "clerk";

type MarketplaceAction = "upsert" | "delete" | "ignore";
type IntakeIntent = {
  source?: string; // e.g., "intake"
  mode?: "draft" | "active";
  inventory?: "create" | "update";
  marketplaces?: Record<string, MarketplaceAction>;
};

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

     // ===== Long Description Composer (hard-coded v1) =====
    const BASE_SENTENCE =
      "The photos are part of the description. Be sure to look them over for condition and details. This is sold as is, and it's ready for a new home.";

    // We no longer emit visible markers. Keep regex to strip old marker blocks during save.
    const LEGACY_BLOCK_RE = /\n*\[⟦AUTO-FOOTER⟧][\s\S]*?\[⟦\/AUTO-FOOTER⟧]\s*$/m;
    // Also strip any previous plain footer line at the end (SKU … • Location … • Case/Bin/Shelf …)
    const PLAIN_FOOTER_RE = /\n*\s*SKU:\s*[^\n]*?•\s*Location:\s*[^\n]*?•\s*Case\/Bin\/Shelf:\s*[^\n]*\s*$/m;

    function ensureBaseOnce(text: string): string {
      const t = String(text || "").trim();
      if (!t) return BASE_SENTENCE;
      if (t.includes(BASE_SENTENCE)) return t;
      return `${BASE_SENTENCE}${t ? "\n\n" + t : ""}`;
    }

    function stripAnyFooter(text: string): string {
      let out = text.replace(LEGACY_BLOCK_RE, "");
      out = out.replace(PLAIN_FOOTER_RE, "");
      return out;
    }

    function upsertFooter(text: string, sku: string | null, instore_loc?: string | null, case_bin_shelf?: string | null): string {
      // Always ensure base sentence first
      let safe = ensureBaseOnce(text);

      // Remove any prior footer (legacy block or existing plain line)
      safe = stripAnyFooter(safe);

      if (!sku) return safe; // Only append footer when a SKU exists

      const footerLine =
        `SKU: ${sku} • Location: ${instore_loc?.trim() || "—"} • Case/Bin/Shelf: ${case_bin_shelf?.trim() || "—"}`;

      // Append a clean plain-text footer (no markers)
      return `${safe}\n\n${footerLine}`;
    }

    
    /**
     * Compose final product_description.
     * - Always inject BASE_SENTENCE once.
     * - Prepend Item Name / Description (product_short_title) above the base sentence when present.
     * - For drafts: no footer (no SKU yet).
     * - For active: insert/replace a plain footer with current SKU/location/bin data.
     */
    function composeLongDescription(opts: {
      existing: string | null | undefined,
      status: "draft" | "active",
      sku?: string | null,
      instore_loc?: string | null,
      case_bin_shelf?: string | null,
      product_short_title?: string | null
    }): string {
      const {
        existing,
        status,
        sku = null,
        instore_loc = null,
        case_bin_shelf = null,
        product_short_title = null
      } = opts || {};

      // Ensure the base sentence, then prepend the title if not already at top
      let body = ensureBaseOnce(existing || "");
      const title = (product_short_title || "").trim();
      if (title && !body.startsWith(title)) {
        body = `${title}\n\n${body}`;
      }

      if (status === "draft") {
        return body; // no footer for drafts
      }

      // Active: append fresh footer (upsertFooter will strip any existing footer)
      return upsertFooter(body, sku, instore_loc, case_bin_shelf);
    }


        // Vendoo mapping helpers (category + condition)
    // These are intentionally generic and just return raw rows so the caller can
    // shape the payload as needed without over-coupling to schema details.
    async function loadVendooCategoryMap(
      sql: any,
      tenantId: string | null | undefined,
      listingCategory: string | null | undefined
    ) {
      if (!tenantId || !listingCategory) {
        console.log("vendoo:category-map:skip", {
          reason: "missing-tenant-or-category",
          tenantId,
          listingCategory,
        });
        return [];
      }

      console.log("vendoo:category-map:load:start", {
        tenantId,
        listingCategory,
      });

      try {
        const rows = await sql`
          select *
          from app.marketplace_category_vendoo_map
          where tenant_id = ${tenantId}
            and category_key_uuid = ${listingCategory}
        `;

        console.log("vendoo:category-map:load:success", {
          tenantId,
          listingCategory,
          rowCount: Array.isArray(rows) ? rows.length : null,
          sampleRow: Array.isArray(rows) && rows.length > 0 ? rows[0] : null,
        });

        return rows;
      } catch (err) {
        console.error("vendoo:category-map:load:error", {
          tenantId,
          listingCategory,
          error: String(err),
        });
        return [];
      }
    }
  
    async function loadMarketplaceConditions(
      sql: any,
      tenantId: string | null | undefined,
      conditionName: string | null | undefined
    ) {
      if (!tenantId || !conditionName) {
        console.log("vendoo:conditions:skip", {
          reason: "missing-tenant-or-condition",
          tenantId,
          conditionName,
        });
        return [];
      }

      console.log("vendoo:conditions:load:start", {
        tenantId,
        conditionName,
      });

      try {
        const rows = await sql`
          select *
          from app.marketplace_conditions
          where tenant_id = ${tenantId}
            and condition_name = ${conditionName}
        `;

        console.log("vendoo:conditions:load:success", {
          tenantId,
          conditionName,
          rowCount: Array.isArray(rows) ? rows.length : null,
          sampleRow: Array.isArray(rows) && rows.length > 0 ? rows[0] : null,
        });

        return rows;
      } catch (err) {
        console.error("vendoo:conditions:load:error", {
          tenantId,
          conditionName,
          error: String(err),
        });
        return [];
      }
    }
  
    async function loadVendooEbayConditionMap(
      sql: any,
      tenantId: string | null | undefined,
      conditionName: string | null | undefined,
      conditionOption: string | null | undefined
    ) {
      if (!tenantId || !conditionName || !conditionOption) {
        console.log("vendoo:ebay-condition-map:skip", {
          reason: "missing-tenant-or-condition-or-option",
          tenantId,
          conditionName,
          conditionOption,
        });
        return [];
      }

      console.log("vendoo:ebay-condition-map:load:start", {
        tenantId,
        conditionName,
        conditionOption,
      });

      try {
        const rows = await sql`
          select *
          from app.marketplace_condition_vendoo_ebay_map
          where tenant_id = ${tenantId}
            and condition_name = ${conditionName}
            and condition_options = ${conditionOption}
        `;

        console.log("vendoo:ebay-condition-map:load:success", {
          tenantId,
          conditionName,
          conditionOption,
          rowCount: Array.isArray(rows) ? rows.length : null,
          sampleRow: Array.isArray(rows) && rows.length > 0 ? rows[0] : null,
        });

        return rows;
      } catch (err) {
        console.error("vendoo:ebay-condition-map:load:error", {
          tenantId,
          conditionName,
          conditionOption,
          error: String(err),
        });
        return [];
      }
    }

    
     
    // === Helper: enqueue marketplace publish jobs (create vs update + no-change short-circuit) ===
    async function enqueuePublishJobs(
      tenant_id: string,
      item_id: string,
      body: any,
      status: "draft" | "active"
    ): Promise<void> {
      try {
        console.log("[intake.enqueuePublishJobs] enter", {
          tenant_id,
          item_id,
          status,
          rawBodyMarketplacesSelected: body?.marketplaces_selected ?? null,
        });
    
        const rawSel = Array.isArray(body?.marketplaces_selected) ? body.marketplaces_selected : [];
        console.log("[intake.enqueuePublishJobs] rawSel.normalized", {
          type: Array.isArray(rawSel) ? "array" : typeof rawSel,
          length: Array.isArray(rawSel) ? rawSel.length : null,
          rawSel,
        });
    
        // Accept slugs (strings) and numeric ids (numbers OR numeric strings)
        let slugs = rawSel
          .filter((v: any) => typeof v === "string" && isNaN(Number(v)) && v.trim() !== "")
          .map((s: string) => s.toLowerCase());
        const ids = rawSel
          .map((v: any) =>
            typeof v === "number" && Number.isInteger(v)
              ? v
              : typeof v === "string" && /^\d+$/.test(v)
              ? Number(v)
              : null
          )
          .filter((n: number | null): n is number => n !== null);
    
        console.log("[intake.enqueuePublishJobs] selection.parsed", {
          slugs,
          ids,
        });
    
        // Derive a canonical per-marketplace action map (slug -> upsert|delete|ignore)
        const actionsBySlug: Record<string, MarketplaceAction> = {};
        if (Array.isArray(intentMarketplaces) && intentMarketplaces.length > 0) {
          console.log("[intake.enqueuePublishJobs] intentMarketplaces.raw", {
            count: intentMarketplaces.length,
            intentMarketplaces,
          });
          for (const m of intentMarketplaces as any[]) {
            if (!m) continue;
            const slug = String(m.slug || "").toLowerCase();
            if (!slug) continue;
            const opRaw = String(m.operation || "").toLowerCase();
            let action: MarketplaceAction = "upsert";
            if (opRaw === "delete") action = "delete";
            else if (opRaw === "ignore") action = "ignore";
            actionsBySlug[slug] = action;
          }
        } else {
          console.log("[intake.enqueuePublishJobs] intentMarketplaces.empty_or_missing", {
            intentMarketplacesType: Array.isArray(intentMarketplaces) ? "array" : typeof intentMarketplaces,
          });
        }
    
        console.log("[intake.enqueuePublishJobs] actionsBySlug.derived", {
          actionsBySlug,
        });
    
        // Merge in marketplaces from intent (any non-"ignore" actions)
        const intentSlugs = Object.entries(actionsBySlug)
          .filter(([, action]) => action && action !== "ignore")
          .map(([slug]) => slug.toLowerCase());
    
        console.log("[intake.enqueuePublishJobs] intentSlugs.filtered", {
          intentSlugs,
        });
    
        if (intentSlugs.length > 0) {
          const merged = new Set<string>([...slugs, ...intentSlugs]);
          slugs = Array.from(merged);
          console.log("[intake.enqueuePublishJobs] slugs.merged_with_intent", {
            slugs,
          });
        }
    
        console.log("[intake] enqueue.start", {
          item_id,
          status,
          rawSel,
          slugs,
          ids,
          intentMarketplaces,
          actionsBySlug,
        });
    
        if (slugs.length === 0 && ids.length === 0) {
          console.log("[intake] enqueue.skip_no_selection", {
            reason: "no slugs and no ids after normalization",
          });
          return;
        }
    
        console.log("[intake.enqueuePublishJobs] querying_enabled_marketplaces", {
          tenant_id,
          slugs,
          ids,
        });
    
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
        console.log("[intake] enqueue.match_enabled", {
          count: Array.isArray(rows) ? rows.length : null,
          rows,
        });
    
        console.log("[intake.enqueuePublishJobs] loading_canonical_fields", {
          item_id,
          tenant_id,
        });
    
        // Load canonical fields we map to marketplaces (schema-backed)
        const inv = await sql/*sql*/`
          SELECT product_short_title
          FROM app.inventory
          WHERE item_id = ${item_id}
          LIMIT 1
        `;
        const lst = await sql/*sql*/`
          SELECT
            listing_category_key, condition_key, brand_key, color_key, shipping_box_key,
            listing_category, item_condition, brand_name, primary_color, shipping_box,
            product_description, weight_lb, weight_oz, shipbx_length, shipbx_width, shipbx_height
          FROM app.item_listing_profile
          WHERE item_id = ${item_id} AND tenant_id = ${tenant_id}
          LIMIT 1
        `;
        // For each marketplace, we may also include its listing row (eBay has the richest set today)
        const imlRows = await sql/*sql*/`
          SELECT marketplace_id, status, mp_offer_id,
                 shipping_policy, payment_policy, return_policy, shipping_zip, pricing_format,
                 buy_it_now_price, allow_best_offer, auto_accept_amount, minimum_offer_amount,
                 promote, promote_percent, duration, starting_bid, reserve_price
          FROM app.item_marketplace_listing
          WHERE item_id = ${item_id} AND tenant_id = ${tenant_id}
        `;
    
        console.log("[intake.enqueuePublishJobs] canonical_fields.loaded", {
          hasInventory: Array.isArray(inv) && inv.length > 0,
          hasListingProfile: Array.isArray(lst) && lst.length > 0,
          marketplaceListingCount: Array.isArray(imlRows) ? imlRows.length : null,
          invSample: Array.isArray(inv) && inv.length > 0 ? inv[0] : null,
          lstSample: Array.isArray(lst) && lst.length > 0 ? lst[0] : null,
        });
    
        // Stable JSON stringify (keys sorted) for hashing
        const stableStringify = (obj: any) => {
          const seen = new WeakSet();
          const sorter = (v: any) => {
            if (v && typeof v === "object" && !Array.isArray(v)) {
              if (seen.has(v)) return v;
              seen.add(v);
              return Object.keys(v).sort().reduce((acc, k) => { acc[k] = sorter(v[k]); return acc; }, {} as any);
            }
            if (Array.isArray(v)) return v.map(sorter);
            return v;
          };
          return JSON.stringify(sorter(obj));
        };
        const sha256Hex = async (s: string) => {
          const data = new TextEncoder().encode(s);
          const hash = await crypto.subtle.digest("SHA-256", data);
          return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,"0")).join("");
        };
    
        console.log("[intake.enqueuePublishJobs] prepared_hash_helpers", {
          rowsCount: Array.isArray(rows) ? rows.length : null,
        });
    
        for (const r of rows) {
          const slug = String(r.slug || "").toLowerCase();
    
          // Desired action from unified intent (default: "upsert")
          const desiredAction: MarketplaceAction =
            (actionsBySlug[slug] as MarketplaceAction) || "upsert";
    
          console.log("[intake.enqueuePublishJobs] loop.marketplace.start", {
            item_id,
            marketplace_id: r.id,
            slug,
            desiredAction,
          });
    
          // If the client explicitly said "ignore", skip this marketplace entirely.
          if (desiredAction === "ignore") {
            console.log("[intake] enqueue.skip_intent_ignore", {
              item_id,
              marketplace_id: r.id,
              slug,
            });
            continue;
          }
    
          // If the client requested a delete, the delete path above handles it.
          // Do NOT enqueue create/update jobs here.
          if (desiredAction === "delete") {
            console.log("[intake] enqueue.skip_intent_delete", {
              item_id,
              marketplace_id: r.id,
              slug,
            });
            continue;
          }
    
          // Pull the marketplace row (if present) to know current identifiers/status
          const iml = Array.isArray(imlRows) ? imlRows.find((x: any) => x.marketplace_id === r.id) : null;
          console.log("[intake.enqueuePublishJobs] loop.marketplace.iml", {
            item_id,
            marketplace_id: r.id,
            slug,
            hasIml: !!iml,
            imlStatus: iml?.status ?? null,
            imlMpOfferId: iml?.mp_offer_id ?? null,
          });
    
          if (slug === "vendoo") {
            console.log("[intake] vendoo.skip_enqueue_tampermonkey", {
              item_id,
              marketplace_id: r.id,
              slug,
              desiredAction,
            });
    
            // Ensure stub exists so UI can reflect progress while Tampermonkey/Vendoo runs
            await sql/*sql*/`
              INSERT INTO app.item_marketplace_listing
                (item_id, tenant_id, marketplace_id, status)
              VALUES
                (${item_id}, ${tenant_id}, ${r.id}, 'publishing')
              ON CONFLICT (item_id, marketplace_id)
              DO UPDATE SET
                status = 'publishing',
                updated_at = now()
            `;
    
            await sql/*sql*/`
              INSERT INTO app.item_marketplace_events
                (item_id, tenant_id, marketplace_id, kind, payload)
              VALUES
                (${item_id}, ${tenant_id}, ${r.id}, 'publish_started', jsonb_build_object('source','vendoo_enqueue'))
            `;
    
            console.log("[intake.enqueuePublishJobs] vendoo.stub_upserted_and_event_logged", {
              item_id,
              marketplace_id: r.id,
              slug,
            });
    
            // No server-runner job for Vendoo; browser/Tampermonkey flow will complete it.
            continue;
          }
    
          
          if (slug === "facebook") {
            const statusNorm = String(iml?.status || "").toLowerCase();
            const isLiveLike = statusNorm === "active" || statusNorm === "live";
    
            console.log("[intake.enqueuePublishJobs] facebook.status_check", {
              item_id,
              marketplace_id: r.id,
              current_status: statusNorm,
              desiredAction,
              isLiveLike,
            });
    
            // If Facebook is already live/active and we're not explicitly deleting,
            // don't keep flipping it back to "publishing" or emitting new publish_started events.
            if (isLiveLike && desiredAction !== "delete") {
              console.log("[intake] fb.skip_already_live", {
                item_id,
                marketplace_id: r.id,
                current_status: statusNorm,
                desiredAction,
              });
              continue;
            }
    
            // Ensure stub exists so UI reflects progress for first-time or non-live publishes
            await sql/*sql*/`
              INSERT INTO app.item_marketplace_listing
                (item_id, tenant_id, marketplace_id, status)
              VALUES
                (${item_id}, ${tenant_id}, ${r.id}, 'publishing')
              ON CONFLICT (item_id, marketplace_id)
              DO UPDATE SET
                status = 'publishing',
                updated_at = now()
            `;
    
            // Emit a progress event (no server-runner for FB; browser/Tampermonkey will finish)
            await sql/*sql*/`
              INSERT INTO app.item_marketplace_events
                (item_id, tenant_id, marketplace_id, kind, payload)
              VALUES
                (${item_id}, ${tenant_id}, ${r.id}, 'publish_started', jsonb_build_object('source','enqueue'))
            `;
    
            console.log("[intake.enqueuePublishJobs] facebook.stub_upserted_and_event_logged", {
              item_id,
              marketplace_id: r.id,
              slug,
            });
    
            continue;
          }
    
          console.log("[intake.enqueuePublishJobs] snapshot.building", {
            item_id,
            marketplace_id: r.id,
            slug,
          });
    
          // Build canonical snapshot for this marketplace
          const snapshot = {
            item_id,
            tenant_id,
            marketplace_id: r.id,
            product_short_title: inv?.[0]?.product_short_title ?? null,
            listing_profile: lst?.[0] ?? null,
            marketplace_listing: iml ?? null
          };
          const snapshotStr = stableStringify(snapshot);
          const hash = await sha256Hex(snapshotStr);
          const payload_snapshot = { ...snapshot, _hash: hash };
    
          console.log("[intake.enqueuePublishJobs] snapshot.built", {
            item_id,
            marketplace_id: r.id,
            slug: r.slug,
            hash,
            snapshotPreview: {
              product_short_title: snapshot.product_short_title,
              listing_profile: snapshot.listing_profile ? { listing_category: snapshot.listing_profile.listing_category } : null,
            },
          });
    
                     // Determine desired op 
          // Option A: treat 'live' the same as 'active' so edits enqueue 'update' after first publish.
          // IMPORTANT:
          // - If the listing row exists but is NOT live/active (error, draft, ended, etc.),
          //   always treat it as a fresh CREATE so we don't get stuck in a non-live state.
          const statusNorm = String(iml?.status || "").toLowerCase();
          const isLiveLike = statusNorm === "active" || statusNorm === "live";
          const hasMpOffer = !!(iml?.mp_offer_id);
    
          console.log("[intake.enqueuePublishJobs] decide-op: pre", {
            tenant_id,
            item_id,
            marketplace_id: r.id,
            slug: r.slug,
            iml_status: iml?.status ?? null,
            statusNorm,
            isLiveLike,
            hasMpOffer,
            mp_offer_id: iml?.mp_offer_id ?? null,
            payload_marketplace_listing_status: (body as any)?.marketplace_listing?.status ?? null
          });
    
          let op: "create" | "update";
          if (isLiveLike && hasMpOffer) {
            // Live/active offer on the marketplace → update the existing listing.
            op = "update";
          } else {
            // No live offer (or no row / no offer id) → create a new listing.
            // This covers the case where a row exists but status is NOT live.
            op = "create";
          }
    
          console.log("[intake.enqueuePublishJobs] decide-op: selected", {
            tenant_id,
            item_id,
            marketplace_id: r.id,
            slug: r.slug,
            op
          });
    
          console.log("[intake.enqueuePublishJobs] last-job.query", {
            tenant_id,
            item_id,
            marketplace_id: r.id,
            slug: r.slug,
            op,
          });
    
          // Compare vs most recent *succeeded* snapshot to short-circuit no-ops
          const last = await sql/*sql*/`
            SELECT status, payload_snapshot
            FROM app.marketplace_publish_jobs
            WHERE tenant_id = ${tenant_id}
              AND item_id = ${item_id}
              AND marketplace_id = ${r.id}
            ORDER BY created_at DESC
            LIMIT 1
          `;
    
          const lastRow = Array.isArray(last) && last.length ? last[0] : null;
          console.log("[intake.enqueuePublishJobs] last-job", {
            tenant_id,
            item_id,
            marketplace_id: r.id,
            slug: r.slug,
            op,
            last_status: lastRow ? lastRow.status : null,
            has_last: !!lastRow
          });
    
          const lastStatus = String(lastRow?.status || "");
          const lastHash = String(lastRow?.payload_snapshot?._hash || "");
          const isLastSucceeded = lastStatus === "succeeded";
    
          console.log("[intake.enqueuePublishJobs] no-change-check", {
            item_id,
            marketplace_id: r.id,
            slug: r.slug,
            isLiveLike,
            hasMpOffer,
            isLastSucceeded,
            lastHash,
            currentHash: hash,
            willSkip:
              isLiveLike && hasMpOffer && isLastSucceeded && lastHash && lastHash === hash,
          });
    
          // Only skip when:
          //  - this listing already has a live/active offer, AND
          //  - the most recent job for this marketplace actually succeeded, AND
          //  - the payload hash is unchanged.
          if (isLiveLike && hasMpOffer && isLastSucceeded && lastHash && lastHash === hash) {
            await sql/*sql*/`
              INSERT INTO app.item_marketplace_events
                (item_id, tenant_id, marketplace_id, kind)
              VALUES (${item_id}, ${tenant_id}, ${r.id}, 'skipped_no_change')
            `;
            console.log("[intake] enqueue.skip_no_change", {
              item_id,
              marketplace_id: r.id,
              lastStatus,
            });
            continue;
          }
    
          console.log("[intake] enqueue.insert_job", {
            marketplace_id: r.id,
            slug: r.slug,
            item_id,
            op,
          });
    
          await sql/*sql*/`
            INSERT INTO app.marketplace_publish_jobs
              (tenant_id, item_id, marketplace_id, op, status, payload_snapshot)
            SELECT ${tenant_id}, ${item_id}, ${r.id}, ${op}, 'queued', ${payload_snapshot}
            WHERE NOT EXISTS (
              SELECT 1 FROM app.marketplace_publish_jobs j
              WHERE j.tenant_id = ${tenant_id}
                AND j.item_id = ${item_id}
                AND j.marketplace_id = ${r.id}
                AND j.op = ${op}
                AND j.status IN ('queued','running')
            )
          `;
    
          console.log("[intake.enqueuePublishJobs] insert_job.completed", {
            tenant_id,
            item_id,
            marketplace_id: r.id,
            slug: r.slug,
            op,
          });
    
          // Touch listing row (useful for dashboards; do not flip status here)
          // NOTE: status normalization happens in enqueue decision (active|live => update)
          await sql/*sql*/`
            UPDATE app.item_marketplace_listing
               SET updated_at = now()
             WHERE tenant_id = ${tenant_id}
               AND item_id = ${item_id}
               AND marketplace_id = ${r.id}
          `;
    
          console.log("[intake.enqueuePublishJobs] listing_row.touched", {
            tenant_id,
            item_id,
            marketplace_id: r.id,
            slug: r.slug,
          });
        }
    
        console.log("[intake] enqueue.done", { item_id });
        console.log("[intake.enqueuePublishJobs] exit.success", {
          item_id,
          tenant_id,
          status,
        });
      } catch (enqueueErr) {
        const err: any = enqueueErr;
        console.error("[intake] enqueue.error", {
          item_id,
          error: String(err),
          stack: err?.stack || null,
        });
        // Best-effort event log
        await sql/*sql*/`
          INSERT INTO app.item_marketplace_events
            (item_id, tenant_id, marketplace_id, kind, error_message)
          VALUES (${item_id}, ${tenant_id}, ${EBAY_MARKETPLACE_ID}, 'enqueue_failed', ${String(enqueueErr).slice(0,500)})
        `;
      }
    }

    
    // AuthZ (creation requires can_inventory_intake or elevated role)
    const actor = await sql<{ role: Role; active: boolean; can_inventory_intake: boolean | null }[]>`
      SELECT m.role, m.active, COALESCE(p.can_inventory_intake, false) AS can_inventory_intake
      FROM app.memberships m
      LEFT JOIN app.permissions p ON p.user_id = m.user_id
      WHERE m.tenant_id = ${tenant_id} AND m.user_id = ${actor_user_id}
      LIMIT 1
    `;

    console.log("[intake] auth.actor", {
      tenant_id,
      actor_user_id,
      rows: actor
    });
    
    if (actor.length === 0 || actor[0].active === false) return json({ ok: false, error: "forbidden" }, 403);
    const allow = ["owner", "admin", "manager"].includes(actor[0].role) || !!actor[0].can_inventory_intake;
    if (!allow) return json({ ok: false, error: "forbidden" }, 403);

    
    
    // Payload
    const body = await request.json();
    console.log("[intake] body.raw_keys", {
      has_inventory: !!body?.inventory,
      has_listing: !!body?.listing,
      has_marketplace_listing: !!body?.marketplace_listing,
      status: body?.status,
      item_status: body?.inventory?.item_status,
      intent: body?.intent
    });
    const inv = body?.inventory || {};
    const lst = body?.listing || {};
    const ebay = body?.marketplace_listing?.ebay || null;
    
    // Status: support Option A drafts; default to 'active' for existing flows
    const rawStatus = (body?.status || inv?.item_status || "active");
    const status = String(rawStatus).toLowerCase() === "draft" ? "draft" : "active";
    const isDraft = status === "draft";

    console.log("[intake] status.normalized", {
      rawStatus,
      status,
      isDraft
    });
    
    // Optional: if present, we update instead of insert
    const item_id_in: string | null = body?.item_id ? String(body.item_id) : null;

    // Normalize intent.marketplaces (if provided by the client)
    const rawIntent = body?.intent || null;
    const intentMarketplaces: any[] = Array.isArray(rawIntent?.marketplaces)
      ? rawIntent.marketplaces
          .map((m: any) => {
            if (!m) return null;
            const slug = String(m.slug || "").toLowerCase() || null;
            const idRaw = (m as any).marketplace_id;
            const id =
              idRaw == null
                ? null
                : typeof idRaw === "number"
                ? idRaw
                : /^\d+$/.test(String(idRaw))
                ? Number(idRaw)
                : null;
            return {
              marketplace_id: id,
              slug,
              selected: !!m.selected,
              operation: m.operation || null,
            };
            console.log("[intake] intent.map_entry", {
              raw: m,
              mapped
            });
          })
          .filter((m: any) => m && (m.marketplace_id != null || m.slug))
      : [];

    // Canonicalize marketplaces_selected from intent when present so all downstream
    // logic (including enqueuePublishJobs) sees the same selection/ops.
    if (intentMarketplaces.length > 0) {
      const selectedForJobs: Array<number | string> = intentMarketplaces
        .filter((m: any) => m.selected && m.operation !== "delete")
        .map((m: any) => {
          if (m.marketplace_id != null) return m.marketplace_id;
          return m.slug;
        })
        .filter((v: any) => v !== null && v !== undefined);
        console.log("[intake] marketplaces_selected.from_intent", {
          before: body.marketplaces_selected,
          selectedForJobs
        });
      body.marketplaces_selected = selectedForJobs;
      console.log("[intake] intent.marketplaces.empty", {
        marketplaces_selected: body.marketplaces_selected
      });
    }
    
    // === DEBUG: show payload routing decisions ===
    console.log("[intake] payload", {
      status,
      isDraft,
      item_id_in,
      marketplaces_selected: body?.marketplaces_selected ?? null,
      has_ebay_block: !!ebay,
      listing_keys_present: !!lst && Object.values(lst).some(v => v !== null && v !== undefined && String(v) !== ""),
      intent_marketplaces: intentMarketplaces
    });


    // If the client requested a delete, do it now (and exit)
    if (body?.action === "delete") {
      if (!item_id_in) return json({ ok: false, error: "missing_item_id" }, 400);
    
        // A) Queue marketplace delete jobs FIRST (one per marketplace with a remote id)
        const iml = await sql/*sql*/`
          SELECT marketplace_id, mp_offer_id, mp_item_id
            FROM app.item_marketplace_listing
           WHERE item_id    = ${item_id_in}
             AND tenant_id  = ${tenant_id}
             AND (mp_offer_id IS NOT NULL OR mp_item_id IS NOT NULL)
        `;
        const job_ids: string[] = [];
        for (const r of iml as any[]) {
          // Try to insert a 'delete' job only if no in-flight job exists
          const inserted = await sql/*sql*/`
            WITH ins AS (
              INSERT INTO app.marketplace_publish_jobs
                (tenant_id, item_id, marketplace_id, op, status, payload_snapshot)
              SELECT
                ${tenant_id}, ${item_id_in}, ${r.marketplace_id}, 'delete', 'queued',
                ${{
                  item_id: item_id_in,
                  tenant_id,
                  marketplace_id: r.marketplace_id,
                  marketplace_listing: { mp_offer_id: r.mp_offer_id, mp_item_id: r.mp_item_id }
                }}
              WHERE NOT EXISTS (
                SELECT 1
                  FROM app.marketplace_publish_jobs j
                 WHERE j.tenant_id      = ${tenant_id}
                   AND j.item_id        = ${item_id_in}
                   AND j.marketplace_id = ${r.marketplace_id}
                   AND j.op             = 'delete'
                   AND j.status IN ('queued','running')
              )
              RETURNING job_id
            )
            SELECT job_id FROM ins
            UNION ALL
            -- If nothing inserted (duplicate in-flight), return the existing in-flight job_id
            SELECT j.job_id
              FROM app.marketplace_publish_jobs j
             WHERE j.tenant_id      = ${tenant_id}
               AND j.item_id        = ${item_id_in}
               AND j.marketplace_id = ${r.marketplace_id}
               AND j.op             = 'delete'
               AND j.status IN ('queued','running')
             LIMIT 1
          `;
          const got = Array.isArray(inserted) && inserted[0]?.job_id ? String(inserted[0].job_id) : null;
          if (got) job_ids.push(got);
  
          // Reflect pending state on the listing row (status now exists in enum)
          await sql/*sql*/`
            UPDATE app.item_marketplace_listing
               SET status='delete_pending', updated_at=now()
             WHERE item_id=${item_id_in} AND tenant_id=${tenant_id} AND marketplace_id=${r.marketplace_id}
          `;
        }

      
        // B) R2 image deletion — TEMPORARILY DISABLED (safety hotfix)
        //    We currently allow multiple items to share the same R2 object
        //    (for example, items created via Duplicate that reuse the same r2_key).
        //    Deleting the R2 object here can break other items that still reference
        //    that key and leaves active listings with missing photos.
        //    SHORT TERM: only delete DB rows; leave the R2 object in place.
        //    LONG TERM OPTIONS:
        //      1) Implement reference-counted deletes (only delete R2 when a key
        //         is no longer referenced in app.item_images).
        //      2) Change duplicate handling to clone images into new R2 keys per
        //         item, so deletes are safe again.
        const imgRows = await sql<{ image_id: string; r2_key: string | null }[]>`
          SELECT image_id, r2_key
            FROM app.item_images
           WHERE item_id = ${item_id_in}
        `;
        // NOTE: Intentionally skipping env.R2_IMAGES.delete(r.r2_key) for now.
        // for (const r of imgRows) {
        //   if (!r?.r2_key) continue;
        //   try { /* @ts-ignore */ await env.R2_IMAGES.delete(r.r2_key); } catch (e) {
        //     console.warn("r2.delete failed", r.r2_key, e);
        //   }
        // }
        await sql/*sql*/`DELETE FROM app.item_images WHERE item_id = ${item_id_in}`;
    
      // C) Explicitly remove the item's listing profile (don’t rely on cascade)
      await sql/*sql*/`
        DELETE FROM app.item_listing_profile
         WHERE item_id = ${item_id_in} AND tenant_id = ${tenant_id}
      `;
    
      // D) Remove inventory row last
      await sql/*sql*/`
        WITH s AS (SELECT set_config('app.actor_user_id', ${actor_user_id}, true))
        DELETE FROM app.inventory
         WHERE item_id = ${item_id_in}
      `;
    
      // E) Return job_ids so the client can trigger/poll the runner
      return json({ ok: true, deleted: true, item_id: item_id_in, job_ids }, 200);
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

        // Phase 0: disallow Active → Draft (server-side guard to match UI)
        if (isDraft && String(existing[0].item_status || "").toLowerCase() === "active") {
          return json({ ok: false, error: "cannot_downgrade_active_to_draft" }, 400);
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
            const descDraft = composeLongDescription({
              existing: lst.product_description,
              status: "draft",
              product_short_title: inv?.product_short_title ?? null
            });
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
                ${descDraft}, ${lst.weight_lb}, ${lst.weight_oz},
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
          
          return json({
            ok: true,
            item_id,
            sku: updInv[0].sku,
            status,
            intent: { marketplaces: intentMarketplaces },
            ms: Date.now() - t0
          }, 200);
        }


          
        // === ACTIVE UPDATE: if promoting to active and no SKU yet, allocate ===
        console.log("[intake.ACTIVE] begin", {
          tenant_id,
          actor_user_id,
          item_id_in,
          inv_status: inv?.item_status ?? null,
          instore_online: inv?.instore_online ?? null,
          marketplaces_selected: body?.marketplaces_selected ?? null,
          intentMarketplaces
        });
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
            const descActive = composeLongDescription({
              existing: lst.product_description,
              status: "active",
              sku: retSku,
              instore_loc: inv?.instore_loc ?? null,
              case_bin_shelf: inv?.case_bin_shelf ?? null,
              product_short_title: inv?.product_short_title ?? null
            });
            
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
                  ${descActive}, ${lst.weight_lb}, ${lst.weight_oz},
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

              console.log("[intake.ACTIVE] listing_profile_upserted", {
                tenant_id,
                item_id,
                listing_category_key: lst.listing_category_key,
                condition_key: lst.condition_key
              });

              // ⭐ FIX: Hydrate listing profile BEFORE doing Vendoo mappings
              const hydratedLstRows = await sql/*sql*/`
                SELECT
                  listing_category_key, condition_key, brand_key, color_key, shipping_box_key,
                  listing_category, item_condition, brand_name, primary_color, shipping_box,
                  weight_lb, weight_oz, shipbx_length, shipbx_width, shipbx_height
                  
                FROM app.item_listing_profile
                WHERE item_id = ${item_id} AND tenant_id = ${tenant_id}
                LIMIT 1
              `;
              
              const hydrated = hydratedLstRows[0] || {};
              console.log("[intake.CREATE_ACTIVE] hydrated listing for Vendoo mapping", hydrated);
              
              // ⭐ Use hydrated.item_condition and hydrated.listing_category_key
              const vendooCategoryRows = await loadVendooCategoryMap(
                sql,
                tenant_id,
                lst.listing_category_key
              );
              
              const vendooConditionRows = await loadMarketplaceConditions(
                sql,
                tenant_id,
                hydrated.item_condition || null
              );
              
              const vendooEbayConditionRows = await loadVendooEbayConditionMap(
                sql,
                tenant_id,
                hydrated.item_condition || null,
                hydrated.condition_options || null
              );

              // Derive per-marketplace categories from rows
              let vendoo_category_vendoo: string | null = null;
              let vendoo_category_ebay: string | null = null;
              let vendoo_category_facebook: string | null = null;
              let vendoo_category_depop: string | null = null;
              
              // ⭐ NEW: Shape Vendoo mapping (Option A)
              const vendoo_mapping = {
              vendoo_category_key:
                vendooCategoryRows?.[0]?.category_key_uuid || null,
              vendoo_category_vendoo,
              vendoo_category_ebay,
              vendoo_category_facebook,
              vendoo_category_depop,
              
                vendoo_condition_main:
                  vendooConditionRows?.[0]?.vendoo_map || null,
                vendoo_condition_fb:
                  vendooConditionRows?.[0]?.fb_map || null,
                vendoo_condition_depop:
                  vendooConditionRows?.[0]?.depop_map || null,
              
                vendoo_condition_ebay:
                  vendooEbayConditionRows?.[0]?.ebay_conditions || null,
                vendoo_condition_ebay_option:
                  vendooEbayConditionRows?.[0]?.condition_options || null
              };
              
              console.log("[intake.ACTIVE] vendoo_mapping (POST)", vendoo_mapping);
            
              // Handle per-marketplace DELETE intent (e.g., deselecting the eBay tile on update)
             if (EBAY_MARKETPLACE_ID && intentMarketplaces.length) {
               const ebayIntent = intentMarketplaces.find((m: any) => {
                 const slug = String(m.slug || "").toLowerCase();
                 const id = m.marketplace_id != null ? Number(m.marketplace_id) : null;
                 return slug === "ebay" || id === EBAY_MARKETPLACE_ID;
               });
               console.log("[intake.ACTIVE] ebay_intent_check", {
                tenant_id,
                item_id,
                EBAY_MARKETPLACE_ID,
                ebayIntent
              });
               if (ebayIntent?.operation === "delete") {
                 console.log("[intake] intent.ebay_delete", { item_id, EBAY_MARKETPLACE_ID });
                 const iml = await sql/*sql*/`
                   SELECT marketplace_id, mp_offer_id, mp_item_id
                   FROM app.item_marketplace_listing
                   WHERE item_id = ${item_id}
                     AND tenant_id = ${tenant_id}
                     AND marketplace_id = ${EBAY_MARKETPLACE_ID}
                     AND (mp_offer_id IS NOT NULL OR mp_item_id IS NOT NULL)
                 `;
                 console.log("[intake] intent.ebay_delete_iml", {
                  tenant_id,
                  item_id,
                  rows: iml.length
                });
                 if (iml.length) {
                   const r: any = iml[0];
                   const inserted = await sql/*sql*/`
                     WITH ins AS (
                       INSERT INTO app.marketplace_publish_jobs
                         (tenant_id, item_id, marketplace_id, op, status, payload_snapshot)
                       SELECT
                         ${tenant_id}, ${item_id}, ${EBAY_MARKETPLACE_ID}, 'delete', 'queued',
                         ${{
                           item_id,
                           tenant_id,
                           marketplace_id: EBAY_MARKETPLACE_ID,
                           marketplace_listing: { mp_offer_id: r.mp_offer_id, mp_item_id: r.mp_item_id }
                         }}
                       WHERE NOT EXISTS (
                         SELECT 1
                           FROM app.marketplace_publish_jobs j
                          WHERE j.tenant_id      = ${tenant_id}
                            AND j.item_id        = ${item_id}
                            AND j.marketplace_id = ${EBAY_MARKETPLACE_ID}
                            AND j.op             = 'delete'
                            AND j.status IN ('queued','running')
                       )
                       RETURNING job_id
                     )
                     SELECT job_id FROM ins
                     UNION ALL
                     SELECT j.job_id
                       FROM app.marketplace_publish_jobs j
                      WHERE j.tenant_id      = ${tenant_id}
                        AND j.item_id        = ${item_id}
                        AND j.marketplace_id = ${EBAY_MARKETPLACE_ID}
                        AND j.op             = 'delete'
                        AND j.status IN ('queued','running')
                      LIMIT 1
                   `;
                   const jobId = Array.isArray(inserted) && inserted[0]?.job_id ? String(inserted[0].job_id) : null;
                   console.log("[intake] intent.ebay_delete_job", { item_id, jobId });
                   await sql/*sql*/`
                     UPDATE app.item_marketplace_listing
                        SET status='delete_pending', updated_at=now()
                      WHERE item_id=${item_id} AND tenant_id=${tenant_id} AND marketplace_id=${EBAY_MARKETPLACE_ID}
                   `;
                 } else {
                   // No remote id; safe to drop the row entirely
                   await sql/*sql*/`
                     DELETE FROM app.item_marketplace_listing
                      WHERE item_id = ${item_id}
                        AND tenant_id = ${tenant_id}
                        AND marketplace_id = ${EBAY_MARKETPLACE_ID}
                   `;
                 }
               }
             }
            // Upsert selected marketplaces (prototype).
            // eBay gets the rich field set; all other selected marketplaces (e.g., Facebook) get a stub row.
            {
              const mpIds: number[] = [];
              if (Array.isArray(body?.marketplaces_selected)) {
                for (const v of body.marketplaces_selected as any[]) {
                  if (typeof v === "number" && !Number.isNaN(v)) {
                    mpIds.push(v);
                  } else if (typeof v === "string") {
                    // Numeric string → id
                    if (/^\d+$/.test(v)) {
                      const n = Number(v);
                      if (!Number.isNaN(n)) mpIds.push(n);
                    } else if (EBAY_MARKETPLACE_ID && v.toLowerCase() === "ebay") {
                      // Allow the UI to send "ebay" as a slug and still hit the rich eBay upsert
                      mpIds.push(EBAY_MARKETPLACE_ID);
                    }
                  }
                }
              }
              console.log("[intake.ACTIVE] marketplaces_selected_normalized", {
                tenant_id,
                item_id,
                raw: body?.marketplaces_selected ?? null,
                mpIds
              });
              // Normalize the ebay payload once
              const e = ebay ? normalizeEbay(ebay) : null;
                console.log("[intake.ACTIVE] ebay_payload_normalized", {
                hasEbay: !!ebay,
                hasNormalized: !!e
              });
              for (const mpId of mpIds) {
                if (mpId === EBAY_MARKETPLACE_ID && e) {
                  // eBay: full field upsert (existing behavior)
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
                  console.log("[intake.ACTIVE] ebay_listing_upserted", {
                    tenant_id,
                    item_id,
                    marketplace_id: mpId
                  });
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
                  console.log("[intake.ACTIVE] ebay_defaults_upserted", {
                    tenant_id,
                    user_id: actor_user_id,
                    marketplace_id: EBAY_MARKETPLACE_ID
                  });
                } else {
                  // Non-eBay (e.g., Facebook): ensure a stub listing row exists with 'publishing'
                  await sql/*sql*/`
                    INSERT INTO app.item_marketplace_listing
                      (item_id, tenant_id, marketplace_id, status)
                    VALUES
                      (${item_id}, ${tenant_id}, ${mpId}, 'publishing')
                    ON CONFLICT (item_id, marketplace_id)
                    DO UPDATE SET
                      status = 'publishing',
                      updated_at = now()
                  `;
                  console.log("[intake.ACTIVE] non_ebay_listing_stub_upserted", {
                    tenant_id,
                    item_id,
                    marketplace_id: mpId
                  });
                }
              }
            }
          }

          // If the intake intent explicitly requests eBay delete (tile deselected),
          // enqueue a delete job and mark the listing as delete_pending.
          if (intentMarketplaces?.ebay === "delete" && EBAY_MARKETPLACE_ID) {
            const iml = await sql/*sql*/`
              SELECT marketplace_id, mp_offer_id, mp_item_id
                FROM app.item_marketplace_listing
               WHERE item_id    = ${item_id}
                 AND tenant_id  = ${tenant_id}
                 AND marketplace_id = ${EBAY_MARKETPLACE_ID}
                 AND (mp_offer_id IS NOT NULL OR mp_item_id IS NOT NULL)
            `;
            console.log("[intake.ACTIVE] explicit_ebay_delete_intent", {
              tenant_id,
              item_id,
              rows: iml.length
            });
            for (const r of iml as any[]) {
              const inserted = await sql/*sql*/`
                WITH ins AS (
                  INSERT INTO app.marketplace_publish_jobs
                    (tenant_id, item_id, marketplace_id, op, status, payload_snapshot)
                  SELECT
                    ${tenant_id}, ${item_id}, ${r.marketplace_id}, 'delete', 'queued',
                    ${{
                      item_id,
                      tenant_id,
                      marketplace_id: r.marketplace_id,
                      marketplace_listing: {
                        mp_offer_id: r.mp_offer_id,
                        mp_item_id: r.mp_item_id
                      }
                    }}
                  WHERE NOT EXISTS (
                    SELECT 1
                      FROM app.marketplace_publish_jobs j
                     WHERE j.tenant_id      = ${tenant_id}
                       AND j.item_id        = ${item_id}
                       AND j.marketplace_id = ${r.marketplace_id}
                       AND j.op             = 'delete'
                       AND j.status IN ('queued','running')
                  )
                  RETURNING job_id
                )
                SELECT job_id FROM ins
                UNION ALL
                SELECT j.job_id
                  FROM app.marketplace_publish_jobs j
                 WHERE j.tenant_id      = ${tenant_id}
                   AND j.item_id        = ${item_id}
                   AND j.marketplace_id = ${r.marketplace_id}
                   AND j.op             = 'delete'
                   AND j.status IN ('queued','running')
                 LIMIT 1
              `;

              // Reflect pending delete on the listing row
              await sql/*sql*/`
                UPDATE app.item_marketplace_listing
                   SET status='delete_pending', updated_at=now()
                 WHERE item_id       = ${item_id}
                   AND tenant_id     = ${tenant_id}
                   AND marketplace_id = ${r.marketplace_id}
              `;
            }
          }
          
          // Enqueue marketplace publish jobs (same behavior as Create Active)
          console.log("[intake.ACTIVE] enqueuePublishJobs.start", {
            tenant_id,
            item_id,
            status,
            intentMarketplaces
          });
          await enqueuePublishJobs(tenant_id, item_id, body, status);
          console.log("[intake.ACTIVE] enqueuePublishJobs.done", {
            tenant_id,
            item_id
          });
          // Return any queued jobs so the client can trigger them by job_id
          const enqueuedUpd = await sql/*sql*/`
            SELECT job_id
            FROM app.marketplace_publish_jobs
            WHERE tenant_id = ${tenant_id}
              AND item_id   = ${item_id}
              AND status    = 'queued'
            ORDER BY created_at ASC
          `;
          
          const job_ids_upd = Array.isArray(enqueuedUpd) ? enqueuedUpd.map((r: any) => String(r.job_id)) : [];
          console.log("[intake.ACTIVE] queued_jobs", {
            tenant_id,
            item_id,
            job_ids_upd
          });
          return json({
            ok: true,
            item_id,
            sku: retSku,
            status,
            published: false,
            job_ids: job_ids_upd,
            intent: { marketplaces: intentMarketplaces },
            vendoo_mapping,

            ms: Date.now() - t0

          }, 200);
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
          (tenant_id, sku, product_short_title, price, qty, cost_of_goods, category_nm, instore_loc, case_bin_shelf, instore_online, item_status)
        VALUES
          (${tenant_id}, NULL, ${inv.product_short_title}, ${inv.price}, ${inv.qty}, ${inv.cost_of_goods},
           ${inv.category_nm}, ${inv.instore_loc}, ${inv.case_bin_shelf}, ${inv.instore_online}, 'draft')
        RETURNING item_id
      `;
      const item_id = invRows[0].item_id;

      // === DUPLICATE IMAGES (if provided by client) ===
      if (Array.isArray(body?.duplicate_images) && body.duplicate_images.length > 0) {
        for (const img of body.duplicate_images) {
          await sql/*sql*/`
            INSERT INTO app.item_images
              (tenant_id, item_id, r2_key, cdn_url, bytes, content_type, width_px, height_px, sha256_hex, is_primary, sort_order)
            VALUES
              (${tenant_id}, ${item_id}, ${img.r2_key}, ${img.cdn_url},
               ${img.bytes}, ${img.content_type}, ${img.width}, ${img.height},
               ${img.sha256}, ${img.is_primary}, ${img.sort_order})
          `;
        }
      }
    
      // If the client provided any listing fields for the draft, persist them too
      if (lst && Object.values(lst).some(v => v !== null && v !== undefined && String(v) !== "")) {
        const descDraft = composeLongDescription({
              existing: lst.product_description,
              status: "draft",
              product_short_title: inv?.product_short_title ?? null
            });
        
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
              ${descDraft}, ${lst.weight_lb}, ${lst.weight_oz},
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
      
      return json({
        ok: true,
        item_id,
        sku: null,
        status: "draft",
        intent: { marketplaces: intentMarketplaces },
        ms: Date.now() - t0
      }, 200);
    }


    
  //Save as Active Code
   // 1) Allocate next SKU (already guarded earlier; keep as-is)
    // 2) Insert full inventory
    console.log("[intake] branch", { kind: "CREATE_ACTIVE" });
    const invRows = await sql<{ item_id: string }[]>`
      WITH s AS (
        SELECT set_config('app.actor_user_id', ${actor_user_id}, true)
      )
      INSERT INTO app.inventory
        (tenant_id, sku, product_short_title, price, qty, cost_of_goods, category_nm, instore_loc, case_bin_shelf, instore_online, item_status)
      VALUES
        (${tenant_id}, ${sku}, ${inv.product_short_title}, ${inv.price}, ${inv.qty}, ${inv.cost_of_goods},
         ${inv.category_nm}, ${inv.instore_loc}, ${inv.case_bin_shelf}, ${inv.instore_online}, 'active')
      RETURNING item_id
    `;
    const item_id = invRows[0].item_id;

    // === DUPLICATE IMAGES (if provided by client) ===
    if (Array.isArray(body?.duplicate_images) && body.duplicate_images.length > 0) {
      for (const img of body.duplicate_images) {
        await sql/*sql*/`
          INSERT INTO app.item_images
            (tenant_id, item_id, r2_key, cdn_url, bytes, content_type, width_px, height_px, sha256_hex, is_primary, sort_order)
          VALUES
            (${tenant_id}, ${item_id}, ${img.r2_key}, ${img.cdn_url},
             ${img.bytes}, ${img.content_type}, ${img.width}, ${img.height},
             ${img.sha256}, ${img.is_primary}, ${img.sort_order})
        `;
      }
    }
    // Store Only: skip marketplace-related tables
    const isStoreOnly = String(inv?.instore_online || "").toLowerCase().includes("store only");

    if (!isStoreOnly) {
      // 3) Insert listing profile (ACTIVE — ALWAYS)
      const descActive = composeLongDescription({
        existing: lst.product_description,
        status: "active",
        sku: sku, // fix: use the allocated sku variable (lowercase)
        instore_loc: inv?.instore_loc ?? null,
        case_bin_shelf: inv?.case_bin_shelf ?? null,
        product_short_title: inv?.product_short_title ?? null
      });
      
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
          ${descActive}, ${lst.weight_lb}, ${lst.weight_oz},
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

    // NEW: For any other selected marketplaces (e.g., Facebook), create a stub row now
    {
      const selIds: number[] = Array.isArray(body?.marketplaces_selected)
        ? body.marketplaces_selected.map((n: any) => Number(n)).filter((n) => !Number.isNaN(n))
        : [];
      const otherIds = selIds.filter((id) => id !== EBAY_MARKETPLACE_ID);
      for (const mpId of otherIds) {
        await sql/*sql*/`
          INSERT INTO app.item_marketplace_listing
            (item_id, tenant_id, marketplace_id, status)
          VALUES
            (${item_id}, ${tenant_id}, ${mpId}, 'publishing')
          ON CONFLICT (item_id, marketplace_id)
          DO UPDATE SET
            status = 'publishing',
            updated_at = now()
        `;
      }
    }
    
   //calling the enqueue process to prepare for the marketplace publish 
   await enqueuePublishJobs(tenant_id, item_id, body, status);
    
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

    // ⭐ FIX: hydrate listing profile before computing Vendoo mappings (CREATE_ACTIVE)
    const hydratedLstRows = await sql/*sql*/`
      SELECT
        listing_category_key, condition_key, brand_key, color_key, shipping_box_key,
        listing_category, item_condition, brand_name, primary_color, shipping_box,
        weight_lb, weight_oz, shipbx_length, shipbx_width, shipbx_height
        
      FROM app.item_listing_profile
      WHERE item_id = ${item_id} AND tenant_id = ${tenant_id}
      LIMIT 1
    `;
    const hydrated = hydratedLstRows[0] || {};
    console.log("[intake.CREATE_ACTIVE] hydrated listing for Vendoo mapping", hydrated);
    
    // ⭐ NEW — build Vendoo mapping for POST responses

    // Prefer the UUID key; we key mappings by this
    const listingCategoryKey =
      lst.listing_category_key || null;
    
    // Load category mapping (expects category_key_uuid)
    const vendooCatRows = await loadVendooCategoryMap(
      sql,
      tenant_id,
      listingCategoryKey
    );
    
    // Derive per-marketplace categories from rows
    let category_vendoo: string | null = null;
    let category_ebay: string | null = null;
    let category_facebook: string | null = null;
    let category_depop: string | null = null;
    let conditionOptions: string | null = null; // for eBay condition mapping

    if (Array.isArray(vendooCatRows)) {
      for (const r of vendooCatRows) {
        const mp = Number(r.marketplace_id);
        if (mp === 13) {
          category_vendoo = r.vendoo_category_path || null;
        }
        if (mp === 1) {
          category_ebay = r.vendoo_category_path || null;
          // eBay row also carries condition_options we use below
          conditionOptions = conditionOptions || r.condition_options || null;
        }
        if (mp === 2) {
          category_facebook = r.vendoo_category_path || null;
        }
        if (mp === 4) {
          category_depop = r.vendoo_category_path || null;
        }
      }
    }
    
    
    // Load base condition mapping
    const vendooCondRows = await loadMarketplaceConditions(
      sql,
      tenant_id,
      hydrated.item_condition || null
    );

    // Load Vendoo–eBay condition mapping, using condition_options from the category row
    let vendooEbayRows: any[] = [];
    //let conditionOptions: string | null = null;

    if (Array.isArray(vendooCatRows) && vendooCatRows.length > 0) {
      const ebayRow = vendooCatRows.find(
        (r: any) => Number(r.marketplace_id) === 1
      );
      conditionOptions = ebayRow?.condition_options || null;
    }

    if (hydrated.item_condition && conditionOptions) {
      vendooEbayRows = await loadVendooEbayConditionMap(
        sql,
        tenant_id,
        hydrated.item_condition,
        conditionOptions
      );
    }

   // Shape mapping in the SAME format as GET /api/inventory/intake
    const vendoo_mapping = {
      // Category mapping
      category_key: listingCategoryKey || null,
      category_vendoo,
      category_ebay,
      category_facebook,
      category_depop,
      // Base condition mapping
      condition_main: vendooCondRows?.[0]?.vendoo_map || null,
      condition_fb: vendooCondRows?.[0]?.fb_map || null,
      condition_depop: vendooCondRows?.[0]?.depop_map || null,

      // Vendoo–eBay condition mapping
      condition_ebay: vendooEbayRows?.[0]?.ebay_conditions || null,
      condition_ebay_option: vendooEbayRows?.[0]?.condition_options || null,
    };

    console.log("[intake.ACTIVE] vendoo_mapping (POST)", {
      tenant_id,
      item_id,
      listingCategoryKey,
      item_condition: hydrated.item_condition,
      vendoo_mapping,
    });
    const job_ids = Array.isArray(enqueued) ? enqueued.map((r: any) => String(r.job_id)) : [];

    return json({
      ok: true,
      item_id,
      sku,
      status,
      published: false,
      job_ids,
      intent: { marketplaces: intentMarketplaces },
      vendoo_mapping,
      ms: Date.now() - t0
    }, 200);

  } catch (err: any) {
    // —— High-signal server-side logging to surface the true root cause ——
    // Neon/Postgres errors often include:
    //   code, detail, hint, schema, table, column, constraint, routine, severity, position
    try {
      console.error("[intake] fatal", {
        took_ms: Date.now() - t0,
        message: String(err?.message || err),
        name: err?.name || null,
        code: err?.code || null,
        detail: err?.detail || null,
        hint: err?.hint || null,
        schema: err?.schema || null,
        table: err?.table || null,
        column: err?.column || null,
        constraint: err?.constraint || null,
        severity: err?.severity || null,
        routine: err?.routine || null,
      });
    } catch {}

    // Preserve current API contract
    const msg = String(err?.message || err);
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

    // Load the Facebook marketplace listing row (if any) to hydrate the UI
    // Neon uses marketplace_id = 2 for Facebook; also try slug for portability.
    const facebookIdRows = await sql<{ id: number }[]>`
      SELECT id FROM app.marketplaces_available WHERE slug = 'facebook' LIMIT 1
    `;
    const FACEBOOK_ID = facebookIdRows[0]?.id ?? 2;

    let facebookListing: any = null;
    if (FACEBOOK_ID != null) {
      const rows = await sql<any[]>`
        SELECT
          status,
          mp_item_url
        FROM app.item_marketplace_listing
        WHERE item_id = ${item_id} AND tenant_id = ${tenant_id} AND marketplace_id = ${FACEBOOK_ID}
        LIMIT 1
      `;
      if (rows.length) facebookListing = rows[0];
    }

    // ---- Long Description default (GET fallback so UI shows something helpful) ----
    const BASE_SENTENCE_GET =
      "The photos are part of the description. Be sure to look them over for condition and details. This is sold as is, and it's ready for a new home.";
    let listingOut: any = lstRows[0] || null;
    if (!listingOut || !String(listingOut.product_description || "").trim()) {
      listingOut = { ...(listingOut || {}), product_description: BASE_SENTENCE_GET };
    }

       // ---------------------------------------------------------------------
    // VENDOO CATEGORY + CONDITION MAPPING
    // ---------------------------------------------------------------------

    let vendoo_mapping: any = {};
    try {
      // IMPORTANT INPUTS FOR MAPPING
      const listingCategoryKey = listingOut?.listing_category_key || null; 
      const conditionName =
        listingOut?.item_condition || null;

      console.log("GET /api/inventory/intake: vendoo mapping inputs", {
        tenant_id,
        item_id,
        listingCategoryKey,
        conditionName,
        listingOut_raw: listingOut,
      });

      // 1) CATEGORY MAPPING (vendoo, ebay, facebook, depop)
      console.log("GET /api/inventory/intake: loading category map", {
        tenant_id: tenant_id,
        listingCategoryKey,
      });

      const catRows = await loadVendooCategoryMap(
        sql,
        tenant_id,
        listingCategoryKey
      );

      console.log("GET /api/inventory/intake: category map rows", {
        count: Array.isArray(catRows) ? catRows.length : null,
        rows: catRows,
      });

      let category_vendoo: string | null = null;
      let category_ebay: string | null = null;
      let category_facebook: string | null = null;
      let category_depop: string | null = null;
      let condition_options: string | null = null; // used later for the vendoo–ebay condition mapping

      if (Array.isArray(catRows)) {
        for (const r of catRows) {
          const mp = Number(r.marketplace_id);
          console.log("GET /api/inventory/intake: category map row", {
            marketplace_id: mp,
            row: r,
          });

          if (mp === 13) category_vendoo = r.vendoo_category_path || null;
          if (mp === 1) {
            category_ebay = r.vendoo_category_path || null;
            condition_options = r.condition_options || null;
          }
          if (mp === 2) category_facebook = r.vendoo_category_path || null;
          if (mp === 4) category_depop = r.vendoo_category_path || null;
        }
      }

      console.log("GET /api/inventory/intake: category mapping result", {
        listingCategoryKey,
        category_vendoo,
        category_ebay,
        category_facebook,
        category_depop,
        condition_options_from_category: condition_options,
      });

      // 2) BASE CONDITION MAPPING (vendoo, facebook, depop)
      let condition_main: string | null = null;
      let condition_fb: string | null = null;
      let condition_depop: string | null = null;

      console.log("GET /api/inventory/intake: loading base condition map", {
        tenant_id: tenant_id,
        conditionName,
      });

      const condRows = await loadMarketplaceConditions(
        sql,
        tenant_id,
        conditionName
      );

      console.log("GET /api/inventory/intake: base condition rows", {
        count: Array.isArray(condRows) ? condRows.length : null,
        rows: condRows,
      });

      if (Array.isArray(condRows) && condRows.length > 0) {
        const r = condRows[0];
        condition_main = r.vendoo_map || null;
        condition_fb = r.fb_map || null;
        condition_depop = r.depop_map || null;

        console.log("GET /api/inventory/intake: base condition mapping result", {
          conditionName,
          condition_main,
          condition_fb,
          condition_depop,
        });
      } else {
        console.log("GET /api/inventory/intake: no base condition mapping found", {
          conditionName,
        });
      }

      // 3) SPECIAL VENDOO–EBAY CONDITION MAPPING
      let condition_ebay: string | null = null;
      let condition_ebay_option: string | null = null;

      if (conditionName && condition_options) {
        console.log("GET /api/inventory/intake: loading vendoo-ebay condition map", {
          tenant_id: tenant_id,
          conditionName,
          condition_options,
        });

        const ebayCondRows = await loadVendooEbayConditionMap(
          sql,
          tenant_id,
          conditionName,
          condition_options
        );

        console.log("GET /api/inventory/intake: vendoo-ebay condition rows", {
          count: Array.isArray(ebayCondRows) ? ebayCondRows.length : null,
          rows: ebayCondRows,
        });

        if (Array.isArray(ebayCondRows) && ebayCondRows.length > 0) {
          const r = ebayCondRows[0];
          condition_ebay = r.ebay_conditions || null;
          condition_ebay_option = r.condition_options || null;

          console.log("GET /api/inventory/intake: vendoo-ebay condition mapping result", {
            conditionName,
            condition_options,
            condition_ebay,
            condition_ebay_option,
          });
        } else {
          console.log("GET /api/inventory/intake: no vendoo-ebay condition mapping found", {
            conditionName,
            condition_options,
          });
        }
      } else {
        console.log("GET /api/inventory/intake: skipping vendoo-ebay condition map", {
          conditionName,
          condition_options,
        });
      }

      vendoo_mapping = {
        category_key: listingCategoryKey || null,
        category_vendoo,
        category_ebay,
        category_facebook,
        category_depop,

        condition_main,
        condition_fb,
        condition_depop,
        condition_ebay,
        condition_ebay_option,
      };

      console.log("GET /api/inventory/intake: FINAL vendoo_mapping", {
        tenant_id,
        item_id,
        vendoo_mapping,
      });
    } catch (err) {
      console.error("vendoo_mapping_build_error", {
        tenant_id,
        item_id,
        error: String(err),
        stack: (err as any)?.stack || null,
      });
      vendoo_mapping = {};
    }

    // ---------------------------------------------------------------------
    // FINAL RESPONSE (unchanged except vendoo_mapping injected)
    // ---------------------------------------------------------------------
    console.log("GET /api/inventory/intake: response summary with vendoo_mapping", {
      tenant_id,
      item_id,
      inventory_present: !!invRows[0],
      listing_present: !!listingOut,
      images_count: imgRows?.length ?? 0,
      ebayListing_present: !!ebayListing,
      facebookListing_present: !!facebookListing,
      vendoo_mapping,
    });

    return new Response(JSON.stringify({
      ok: true,

      // inventory info
      inventory: invRows[0],
      inventory_meta: invRows[0],

      // listing profile (marketplace listing details)
      listing: listingOut,
      listing_profile: listingOut,

      // images
      images: imgRows,

      // structured marketplace listings
      marketplace_listing: {
        ebay: ebayListing,
        ebay_marketplace_id: EBAY_ID,
        facebook: facebookListing,
        facebook_marketplace_id: FACEBOOK_ID
      },

      // flat ebay listing for convenience
      marketplace_listing_flat: ebayListing,

      // snapshot for eBay-style payload
      ebay_payload_snapshot: {
        listing_profile: listingOut,
        marketplace_listing: ebayListing
      },

      // NEW: Fully-hydrated Vendoo mapping block
      vendoo_mapping
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store"
      }
    });


    
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: "server_error", message: String(e?.message || e) }), { status: 500, headers: { "content-type": "application/json" } });
  }
};

// end intake.ts file
