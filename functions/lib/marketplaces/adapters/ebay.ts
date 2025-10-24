// begin ebay.ts file
import type { MarketplaceAdapter, CreateParams, CreateResult } from '../types';
import { getSql } from '../../../_shared/db';

type EbayEnv = 'production' | 'sandbox';

function ebayBase(env: EbayEnv) {
  return env === 'production' ? 'https://api.ebay.com' : 'https://api.sandbox.ebay.com';
}

function pickPrimary(images: Array<{ cdn_url: string; is_primary: boolean; sort_order: number }>) {
  if (!images?.length) return { primary: null as string | null, gallery: [] as string[] };
  const sorted = [...images].sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0) || a.sort_order - b.sort_order);
  const primary = sorted[0]?.cdn_url || null;
  const gallery = sorted.slice(1).map(i => i.cdn_url).filter(Boolean);
  return { primary, gallery };
}

// --- Local decrypt helper (AES-GCM), compatible with your persistTokens/protect() format { v: "token" } ---
function b64d(s: string) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
async function decryptJson(base64Key: string, blob: string): Promise<any> {
  if (!blob) return null;
  const [ivB64, ctB64] = blob.split(".");
  const iv = b64d(ivB64);
  const ct = b64d(ctB64);
  if (!base64Key) return JSON.parse(new TextDecoder().decode(ct));
  const key = await crypto.subtle.importKey("raw", b64d(base64Key), { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

function msUntil(iso: string | null | undefined) {
  if (!iso) return -1;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return -1;
  return t - Date.now();
}

async function create(params: CreateParams): Promise<CreateResult> {
  const { env, tenant_id, item, profile, mpListing, images } = params;
  const sql = getSql(env);

  // 1) Basic presence checks
  const warnings: string[] = [];
  if (!item?.sku) warnings.push('Missing SKU');
  if (!item?.product_short_title) warnings.push('Missing title');
  if (!images?.length) warnings.push('No images attached');
  
    // Declare holders for resolved category + mapped specifics
  let ebayCategoryId: string | null = null;
  let mappedSpecifics: { type: string | null; model: string | null; franchise: string | null; sport: string | null } = {
    type: null, model: null, franchise: null, sport: null
  };

  // Resolve eBay category id (UUID -> label -> ebay id) AND pull mapped item-specific values
  try {
    const rows = await sql/*sql*/`
      SELECT
        mcem.ebay_category_id,
        mcem.type_value,
        mcem.model_value,
        mcem.franchise_value,
        mcem.sport_value
      FROM app.marketplace_category_ebay_map AS mcem
      JOIN app.marketplace_categories      AS mc
        ON mc.category_key = mcem.category_key_uuid
      JOIN app.marketplaces_available      AS ma
        ON ma.id = mcem.marketplace_id
      WHERE ma.slug = 'ebay'
        AND mc.category_key = ${profile.listing_category_key}::uuid
      ORDER BY mcem.updated_at DESC NULLS LAST
      LIMIT 1
    `;
    const row = rows?.[0] || null;
    ebayCategoryId  = row?.ebay_category_id != null ? String(row.ebay_category_id) : null;
    mappedSpecifics = {
      type:       row?.type_value       ?? null,
      model:      row?.model_value      ?? null,
      franchise:  row?.franchise_value  ?? null,
      sport:      row?.sport_value      ?? null,
    };

    console.log('[ebay:category.resolve]', {
      listing_category_key: profile?.listing_category_key,
      resolved: ebayCategoryId,
      mappedSpecifics
    });
  } catch (err) {
    console.error('[ebay:category.resolve:error]', err);
  }
 

  if (!ebayCategoryId) {
    throw new Error(
      `No eBay category mapped for listing_category_key=${profile?.listing_category_key}.` +
      ` Ensure a row exists in app.marketplace_category_ebay_map joined via app.marketplace_categories.`
    );
  }
  
  // 3) Load tenant connection (including token_expires_at) and DECRYPT the stored access_token
  const conn = await sql/*sql*/`
    SELECT mc.connection_id, mc.access_token, mc.token_expires_at, mc.environment, mc.secrets_blob
    FROM app.marketplace_connections mc
    JOIN app.marketplaces_available ma ON ma.id = mc.marketplace_id
    WHERE mc.tenant_id = ${tenant_id}
      AND ma.slug = 'ebay'
      AND mc.status = 'connected'
    ORDER BY mc.updated_at DESC
    LIMIT 1
  `;
  if (!conn?.length) throw new Error('Tenant not connected to eBay');

  const encKey = env.RP_ENCRYPTION_KEY || "";
  const encAccess = String(conn[0].access_token || "");
  if (!encAccess) throw new Error('No access_token stored');

  let accessObj = await decryptJson(encKey, encAccess);
  let accessToken = String(accessObj?.v || "").trim();
  if (!accessToken) throw new Error('Decrypted access_token is empty');

  // Resolve environment: prefer explicit column, fall back to secrets_blob.environment
  let envStr = String(conn[0].environment || "").trim().toLowerCase() as EbayEnv | "";
  if (!envStr) {
    try {
      const secrets = await decryptJson(encKey, String(conn[0].secrets_blob || ""));
      const e = String(secrets?.environment || "").trim().toLowerCase();
      if (e === "production" || e === "sandbox") envStr = e as EbayEnv;
    } catch {}
  }
  if (envStr !== "production" && envStr !== "sandbox") envStr = "sandbox";

  // 3b) Auto-refresh if expiring in ≤ 120s using your existing refresh route
  const expiresInMs = msUntil(String(conn[0].token_expires_at || ""));
  if (expiresInMs >= 0 && expiresInMs <= 120_000) {
    // Determine the app origin to call the internal refresh route
    const origin =
      (env as any).APP_BASE_URL ||
      (env as any).PUBLIC_APP_URL ||
      (env as any).ORIGIN ||
      '';
    const refreshUrl = origin
      ? `${origin.replace(/\/+$/, '')}/api/settings/marketplaces/ebay/refresh`
      : '/api/settings/marketplaces/ebay/refresh';

    const r = await fetch(refreshUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': String(tenant_id)
      },
      body: JSON.stringify({ marketplace_id: 'ebay' })
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`refresh_failed: ${r.status} ${txt}`.slice(0, 500));
    }

    // Re-select and decrypt the fresh token
    const conn2 = await sql/*sql*/`
      SELECT mc.access_token
      FROM app.marketplace_connections mc
      JOIN app.marketplaces_available ma ON ma.id = mc.marketplace_id
      WHERE mc.tenant_id = ${tenant_id}
        AND ma.slug = 'ebay'
        AND mc.status = 'connected'
      ORDER BY mc.updated_at DESC
      LIMIT 1
    `;
    const encAccess2 = String(conn2?.[0]?.access_token || "");
    if (!encAccess2) throw new Error('refresh_ok_but_no_access_token');
    accessObj = await decryptJson(encKey, encAccess2);
    accessToken = String(accessObj?.v || "").trim();
    if (!accessToken) throw new Error('refresh_ok_but_access_token_empty');
  }

  // 4) Build payload from our rows (Rows 1–27, 29, 30; skip 33–38)
  const { primary, gallery } = pickPrimary(images || []);
  const pricingFormat = String(mpListing?.pricing_format || 'fixed'); // 'fixed' | 'auction'
  const isFixed = pricingFormat === 'fixed';

  const payload = {
    title: item?.product_short_title || '',
    sku: item?.sku || '',                              // Row 29 → eBay Custom Label
    description: profile?.product_description || '',
    categoryId: ebayCategoryId || undefined,           // Row 30 resolved via map
    aspects: {
      condition_key: profile?.condition_key || null,
      brand_key: profile?.brand_key || null,
      color_key: profile?.color_key || null
    },
    pricing: isFixed
      ? {
          format: 'fixed',
          buyItNowPrice: mpListing?.buy_it_now_price ?? item?.price ?? null,
          allowBestOffer: !!mpListing?.allow_best_offer,
          autoAcceptAmount: mpListing?.auto_accept_amount ?? null,
          minimumOfferAmount: mpListing?.minimum_offer_amount ?? null
        }
      : {
          format: 'auction',
          startingBid: mpListing?.starting_bid ?? null,
          reservePrice: mpListing?.reserve_price ?? null,
          duration: mpListing?.duration ?? null,
          allowBestOffer: !!mpListing?.allow_best_offer
        },
    fulfillment: {
      shippingZip: mpListing?.shipping_zip || null,
      shippingPolicy: mpListing?.shipping_policy || null,
      paymentPolicy: mpListing?.payment_policy || null,
      returnPolicy: mpListing?.return_policy || null,
      package: {
        weightLb: profile?.weight_lb ?? 0,
        weightOz: profile?.weight_oz ?? 0,
        length: profile?.shipbx_length ?? 0,
        width:  profile?.shipbx_width  ?? 0,
        height: profile?.shipbx_height ?? 0
      }
    },
    images: {
      primary,
      gallery
    },
    promotions: {
      promote: !!mpListing?.promote,
      promotePercent: mpListing?.promote_percent ?? null
    }
  };

  // 5) Call eBay using the Sell Inventory flow:
  //    (1) PUT inventory_item {sku}
  //    (2) POST offer
  //    (3) POST publish

  const base = ebayBase(envStr as EbayEnv);
  // One-time helper to make sure our Merchant Inventory Location exists.
  // If it doesn't, create a minimal US location using the item's ZIP.
    // One-time helper to ensure a Merchant Inventory Location exists.
  // Deterministic: if initial GET is not 200, PUT to create, then GET to verify.
  
  async function ensureLocation(key: string, zip: string) {
    // 0) One-time: list all existing merchant locations for visibility (env + count + keys + raw)
    try {
      const listed = await ebayFetch(`/sell/inventory/v1/location?limit=200`, { method: 'GET' });
      const arr = Array.isArray((listed as any)?.locations) ? (listed as any).locations : [];
      const keys = arr.map((l: any) => l?.merchantLocationKey).filter(Boolean);
      console.log('[ebay:locations.list]', {
        base,                             // shows production vs sandbox host
        count: arr.length,
        keys,
        raw: listed                       // full payload for debugging
      });
    } catch { /* listing is best-effort */ }

    // 1) Try to read the location
    let exists = false;
    try {
      
      await ebayFetch(`/sell/inventory/v1/location/${encodeURIComponent(key)}`, { method: 'GET' });
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) return;

    // 2) Create location (WAREHOUSE) with a valid US address; POST per eBay spec
    const payload = {
      name: 'Primary Warehouse',
      merchantLocationStatus: 'ENABLED',
      locationTypes: ['WAREHOUSE'],
      location: {
        address: {
          addressLine1: '5030 Kipling Street',
          city: 'Wheat Ridge',
          stateOrProvince: 'CO',
          postalCode: (String(zip || '').trim() || '80033'),
          country: 'US'
        }
      }
    };
    await ebayFetch(`/sell/inventory/v1/location/${encodeURIComponent(key)}`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    // 3) Verify creation
    await ebayFetch(`/sell/inventory/v1/location/${encodeURIComponent(key)}`, { method: 'GET' });
  }

  // simple helper to normalize error text
    // simple on/off switch via env if you want (default true for now)
    const DEBUG_EBAY = true;
    // Temporary enforcement toggles
    const ENFORCE_BEST_OFFER_ON = true;
    const ENFORCE_PROMOTE_ON_PROD = false; // blocks publish in production if Promote was requested (until Marketing API is wired)
  
    function safeStringify(obj: any) {
      try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
    }
  
    async function ebayFetch(path: string, init: RequestInit) {
      const url = `${base}${path}`;
      const headers = {
        ...(init.headers || {}),
        'authorization': `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'content-language': 'en-US'
      };
  
      if (DEBUG_EBAY) {
        // Never log the token
        const { authorization, ...rest } = headers as any;
        console.log('[ebay:request]', { url, method: init.method || 'GET', headers: rest });
        if (init.body) {
          console.log('[ebay:request.body]', typeof init.body === 'string' ? init.body : safeStringify(init.body));
        }
      }
  
      const r = await fetch(url, { ...init, headers });
  
      const txt = await r.text().catch(() => '');
      if (DEBUG_EBAY) {
        console.log('[ebay:response.status]', r.status, r.statusText, 'for', path);
        // Log a truncated body to avoid massive dumps
        console.log('[ebay:response.body]', txt.slice(0, 4000));
      }
  
      if (!r.ok) {
        throw new Error(`${r.status} ${r.statusText} :: ${txt}`.slice(0, 1000));
      }
  
      try {
        return txt && (r.headers.get('content-type') || '').includes('application/json')
          ? JSON.parse(txt)
          : txt;
      } catch {
        return txt;
      }
    }

    // ── Marketing: Promoted Listings Standard (CPS, fixed ad rate) ───────────────
    async function promoteIfRequested(params: {
      envStr: EbayEnv,
      listingId: string | null,
      promote: boolean,
      promotePercent: number | null | undefined,
      sku?: string | null
    }) {
      const { envStr, listingId, promote, promotePercent, sku } = params;
      // 0) Basic guards
      const pct = promotePercent != null ? Number(promotePercent) : NaN;
      if (!promote || !Number.isFinite(pct) || pct <= 0) {
        console.log('[ebay:marketing.promote]', {
          skipped: true, reason: 'not_requested_or_missing_inputs', listingId, sku, promote, promotePercent
        });
        return { promoted: false, reason: 'not_requested_or_missing_inputs' };
      }
    
      // 1) Prepare a deterministic campaign name (per tenant/environment)
      const campaignName = `ResellPro – ${envStr.toUpperCase()} – Default CPS`;
    
      // Small helpers to call Marketing API (re-use ebayFetch)
      const qs = (o: Record<string, string>) =>
        '?' + Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    
      async function findCampaignByName(name: string) {
        const filteredPath = `/sell/marketing/v1/ad_campaign${qs({ campaign_name: name, funding_strategy: 'COST_PER_SALE', limit: '20' })}`;
      
        // Attempt 1 — filtered GET
        try {
          const resp = await ebayFetch(filteredPath, { method: 'GET' });
          const arr = Array.isArray((resp as any)?.campaigns) ? (resp as any).campaigns : [];
          const hit = arr.find((c: any) => c?.campaignName === name) || null;
          if (hit) return hit;
        } catch (e: any) {
          const msg = String(e?.message || e || '');
          console.warn('[ebay:marketing.findCampaign.fail#1]', msg);
          // single short backoff on transient 500s
          if (msg.includes(' 500 ') || msg.includes('"httpStatusCode":500')) {
            await new Promise(r => setTimeout(r, 600));
            try {
              const resp2 = await ebayFetch(filteredPath, { method: 'GET' });
              const arr2 = Array.isArray((resp2 as any)?.campaigns) ? (resp2 as any).campaigns : [];
              const hit2 = arr2.find((c: any) => c?.campaignName === name) || null;
              if (hit2) return hit2;
            } catch (e2: any) {
              console.warn('[ebay:marketing.findCampaign.fail#retry]', String(e2?.message || e2 || ''));
            }
          }
        }
      
        // Fallback — unfiltered list + local filter (funding model CPS + name)
        try {
          const resp3 = await ebayFetch(`/sell/marketing/v1/ad_campaign${qs({ limit: '200' })}`, { method: 'GET' });
          const list = Array.isArray((resp3 as any)?.campaigns) ? (resp3 as any).campaigns : [];
          const hit3 = list.find((c: any) =>
            c?.campaignName === name && String(c?.fundingStrategy?.fundingModel || '').toUpperCase() === 'COST_PER_SALE'
          ) || null;
          if (hit3) return hit3;
        } catch (e3: any) {
          console.warn('[ebay:marketing.findCampaign.unfiltered.fail]', String(e3?.message || e3 || ''));
        }
      
        return null; // let caller decide to create
      }
    
      async function createCampaign(name: string, defaultBidPct: number) {
        const body = {
          campaignName: name,
          startDate: new Date().toISOString(),
          marketplaceId: 'EBAY_US',
          fundingStrategy: {
            fundingModel: 'COST_PER_SALE',
            adRateStrategy: 'FIXED',
            bidPercentage: String(defaultBidPct)
          }
        };
        console.log('[ebay:marketing.createCampaign.body]', body);
      
        await ebayFetch(`/sell/marketing/v1/ad_campaign`, {
          method: 'POST',
          body: JSON.stringify(body)
        });
      
        // Always re-find using the resilient finder
        return await findCampaignByName(name);
      }
    
      async function addListingToCampaign(campaignId: string, listingId: string, bidPct: number) {
        const adBody = {
          listingId: String(listingId),
          bidPercentage: String(bidPct)
        };
        const path = `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad`;
        console.log('[ebay:marketing.createAd.body]', { campaignId, ...adBody });
      
        const backoffSeconds = [5, 10, 20, 30];
        for (let attempt = 0; attempt <= backoffSeconds.length; attempt++) {
          try {
            await ebayFetch(path, { method: 'POST', body: JSON.stringify(adBody) });
            if (attempt > 0) console.log('[ebay:marketing.createAd.retry.success]', { attempt });
            return;
          } catch (e: any) {
            const msg = String(e?.message || e || '');
      
            if (msg.includes(' 409 ') || msg.includes('"httpStatusCode":409') || msg.toLowerCase().includes('already exists')) {
              console.warn('[ebay:marketing.createAd.alreadyExists]', { campaignId, listingId });
              return;
            }
      
            const is404 = msg.includes(' 404 ') || msg.includes('"httpStatusCode":404');
            const is35048 = msg.includes('"errorId":35048') || /invalid or has ended/i.test(msg);
            if ((is404 || is35048) && attempt < backoffSeconds.length) {
              const waitSec = backoffSeconds[attempt];
              console.warn('[ebay:marketing.createAd.retry]', {
                attempt: attempt + 1,
                waitSec,
                reason: '35048/listing_not_yet_visible',
                campaignId,
                listingId
              });
              await new Promise(r => setTimeout(r, waitSec * 1000));
              continue;
            }
      
            if (is404 || is35048) {
              console.error('[ebay:marketing.createAd.retry.exhausted]', { attempts: attempt + 1, campaignId, listingId });
            }
            throw e;
          }
        }
      }
      
      // NEW: Create ad by Inventory Reference (SKU) — avoids fresh-listing visibility lag
      async function addInventoryRefToCampaign(campaignId: string, sku: string, bidPct: number) {
        const adBody = {
          inventoryReferenceId: String(sku),
          inventoryReferenceType: 'INVENTORY_ITEM',
          bidPercentage: String(bidPct)
        };
        const path = `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/create_ads_by_inventory_reference`;
        console.log('[ebay:marketing.createAdByInventoryRef.body]', { campaignId, ...adBody });
      
        try {
          await ebayFetch(path, { method: 'POST', body: JSON.stringify(adBody) });
        } catch (e: any) {
          const msg = String(e?.message || e || '');
          // If an ad already exists for this inventory ref in the campaign, treat as success
          if (msg.includes(' 409 ') || msg.includes('"httpStatusCode":409') || msg.toLowerCase().includes('already exists')) {
            console.warn('[ebay:marketing.createAdByInventoryRef.alreadyExists]', { campaignId, sku });
            return;
          }
          throw e;
        }
      }

    
      try {
        // 2) Ensure campaign exists (find or create)
        let campaign = await findCampaignByName(campaignName);
        if (!campaign) {
          console.log('[ebay:marketing.promote]', { creatingCampaign: campaignName, defaultBidPercentage: pct });
          campaign = await createCampaign(campaignName, pct);
        }
    
        const campaignId = String(campaign?.campaignId || '');
        if (!campaignId) throw new Error(`campaign_not_found_or_create_failed: ${campaignName}`);
    
        // 3) Prefer Inventory Reference (SKU) first to avoid fresh-listing propagation lag
        let adOk = false;
        if (sku) {
          try {
            await addInventoryRefToCampaign(campaignId, String(sku), pct);
            adOk = true;
            console.log('[ebay:marketing.promote.success]', {
              path: 'inventoryReference',
              sku,
              campaignName,
              campaignId,
              bidPercentage: pct
            });
          } catch (e:any) {
            console.warn('[ebay:marketing.createAdByInventoryRef.fail]', String(e?.message || e));
          }
        }
        
        // Fallback to listingId path if needed
        if (!adOk && listingId) {
          await addListingToCampaign(campaignId, String(listingId), pct);
          adOk = true;
          console.log('[ebay:marketing.promote.success]', {
            path: 'listingId',
            listingId,
            campaignName,
            campaignId,
            bidPercentage: pct
          });
        }
        
        if (!adOk) throw new Error('create_ad_failed: both inventoryReference and listingId paths failed');

    
        // TODO (optional): persist campaign_id, ad_rate_applied, promoted_at in DB
        return { promoted: true, campaignId, bidPercentage: pct };
        } catch (err: any) {
          const msg = String(err?.message || err || '');
          console.warn('[ebay:marketing.promote.fail]', msg);
        
          // Hint if we likely exhausted 35048 retries
          const exhausted = msg.includes('retry.exhausted') || msg.includes('"errorId":35048') || /invalid or has ended/i.test(msg);
          return {
            promoted: false,
            reason: exhausted ? 'api_error' : 'api_error',
            error: exhausted
              ? 'Promotion could not be applied yet (eBay not ready for the new listing). Will need a retry shortly.'
              : msg
          };
        }
    }
    
  // (1) PUT inventory item
  const sku = String(item?.sku || '').trim();
  if (!sku) throw new Error('Missing SKU');

  const imageUrls: string[] = [];
  if (primary) imageUrls.push(primary);
  if (Array.isArray(gallery) && gallery.length) imageUrls.push(...gallery);

  // Map our richer UI labels to eBay's 2-value enum: NEW or USED
  const rawCond = String(profile?.item_condition || '').trim().toLowerCase();
  
  // helpers
  const isNew =
    rawCond.startsWith('new') ||               // "New With Imperfections", "New Without Tags/Box", etc.
    rawCond === '' ;                           // default to NEW if empty
  
  const conditionEnum = isNew ? 'NEW' : 'USED';
  
  // include a short note only for USED items
  const conditionDescription =
    !isNew && profile?.product_description
      ? String(profile.product_description).slice(0, 1000)
      : undefined;

  // map our fields into eBay inventory item structure
  const computedQty = Math.max(1, Number((item && item.qty) != null ? item.qty : 1));
  const inventoryItemBody: any = {
    condition: conditionEnum,  
    ...(conditionDescription ? { conditionDescription } : {}),
    product: {
      title: item?.product_short_title || '',
      description: profile?.product_description || '',
      aspects: {
        // eBay expects string[] values for aspects. Omit when not present.
        brand: profile?.brand_name ? [String(profile.brand_name)] : undefined,
        color: profile?.primary_color ? [String(profile.primary_color)] : undefined,

        // ── Mapped specifics from marketplace_category_ebay_map (only when present) ──
        ...(mappedSpecifics?.type      ? { Type:      [String(mappedSpecifics.type)] }       : {}),
        ...(mappedSpecifics?.model     ? { Model:     [String(mappedSpecifics.model)] }      : {}),
        ...(mappedSpecifics?.franchise ? { Franchise: [String(mappedSpecifics.franchise)] }  : {}),
        ...(mappedSpecifics?.sport     ? { Sport:     [String(mappedSpecifics.sport)] }      : {}),
      },
      // omit imageUrls for this test so we can isolate the 25001 cause
      ...(imageUrls.length ? { imageUrls } : {})
    },
    // ✅ eBay expects BOTH weight & size inside packageWeightAndSize
    packageWeightAndSize: {
      // packageType is optional; keep or remove as needed
      // packageType: 'PACKAGE_THICK_ENVELOPE',
      weight: {
        unit: 'KILOGRAM',
        value: (() => {
          const lb = Number(profile?.weight_lb ?? 0);
          const oz = Number(profile?.weight_oz ?? 0);
          const pounds = lb + (oz / 16);
          const kg = pounds * 0.45359237;
          const twoDp = Math.round(kg * 100) / 100;
          const safe = Math.max(0.01, twoDp);
          return Number(safe.toFixed(2));
        })()
      },
      dimensions: {
        height: Number(profile?.shipbx_height || 0),
        length: Number(profile?.shipbx_length || 0),
        width:  Number(profile?.shipbx_width  || 0),
        unit: 'INCH'
      }
    },
  
    availability: {
      shipToLocationAvailability: {
        // eBay validates publish against the Inventory Item’s availability.
        quantity: computedQty
      }
    }
  };
  console.log('[ebay:inventory_item.put.body]', safeStringify(inventoryItemBody));
  await ebayFetch(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    method: 'PUT',
    body: JSON.stringify(inventoryItemBody)
  });

  // ── Post-PUT verify (single read; removes publish-time ambiguity) ──
  try {
    const persisted = await ebayFetch(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
      method: 'GET'
    });
    const pws =
      (persisted && (persisted as any).packageWeightAndSize) ||
      (persisted && (persisted as any).product && (persisted as any).product.packageWeightAndSize) ||
      null;
    console.log('[ebay:postput.verify]', { packageWeightAndSize: pws });
  } catch (e) {
    console.warn('[ebay:postput.verify:error]', e);
    // Continue — offer/publish will still run; this is just visibility.
  }

  // (2) POST offer
  const marketplaceId = 'EBAY_US'; // TODO: make dynamic if you will support other sites
  // reuse isFixed from earlier payload build
  const priceValue =
    (mpListing?.buy_it_now_price ?? item?.price ?? null) != null
      ? Number(mpListing?.buy_it_now_price ?? item?.price)
      : null;

  const merchantLocationKey = 'store_001';
  const shippingZip = String(mpListing?.shipping_zip || '').trim();
  if (!shippingZip) throw new Error('Missing shipping ZIP for eBay offer (shipping_zip).');

  // Ensure the eBay Inventory Location exists (create if needed & verify)
  await ensureLocation(merchantLocationKey, shippingZip);
  // (No extra GET needed here; ensureLocation already verified.)
   // Build itemSpecifics from mapping table values (omit when null/empty)
    const itemSpecifics: Array<{ name: string; values: string[] }> = [];
    const pushIf = (name: string, val: unknown) => {
      const s = String(val ?? '').trim();
      if (s) itemSpecifics.push({ name, values: [s] });
    };
    pushIf('Type',      mappedSpecifics.type);
    pushIf('Model',     mappedSpecifics.model);
    pushIf('Franchise', mappedSpecifics.franchise);
    pushIf('Sport',     mappedSpecifics.sport);
    
   const offerBody: any = {
    sku,
    marketplaceId,
    format: isFixed ? 'FIXED_PRICE' : 'AUCTION',
    availableQuantity: Number(item?.qty || 1),
    listingDescription: profile?.product_description || '',
    categoryId: ebayCategoryId || undefined,
    merchantLocationKey, // ← this satisfies Item.Country via the Inventory Location
    listingPolicies: {
      // NEW: Best Offer must live inside listingPolicies.bestOfferTerms
      ...(isFixed && mpListing?.allow_best_offer ? {
        bestOfferTerms: {
          bestOfferEnabled: true,
          ...(mpListing?.auto_accept_amount != null && mpListing.auto_accept_amount !== ''
            ? { autoAcceptPrice:  { currency: 'USD', value: Number(mpListing.auto_accept_amount) } }
            : {}),
          // eBay expects autoDeclinePrice (not "minimumPrice")
          ...(mpListing?.minimum_offer_amount != null && mpListing.minimum_offer_amount !== ''
            ? { autoDeclinePrice: { currency: 'USD', value: Number(mpListing.minimum_offer_amount) } }
            : {})
        }
      } : {}),
      fulfillmentPolicyId: (mpListing?.shipping_policy_override ?? mpListing?.shipping_policy) || null,
      paymentPolicyId:     mpListing?.payment_policy  || null,
      returnPolicyId:      mpListing?.return_policy   || null,
    },
    ...(itemSpecifics.length ? { itemSpecifics } : {}),
    pricingSummary: isFixed
      ? { price: { currency: 'USD', value: priceValue || 0 } }
      : {
          auctionReservePrice: mpListing?.reserve_price != null ? { currency: 'USD', value: Number(mpListing.reserve_price) } : undefined,
          auctionStartPrice:   mpListing?.starting_bid  != null ? { currency: 'USD', value: Number(mpListing.starting_bid) }  : undefined
        }
  };

  // NEW: Log what the user requested and what we’re about to send in listingPolicies.bestOfferTerms
  console.log('[ebay:bestOffer.requested]', {
    allow_best_offer: !!mpListing?.allow_best_offer,
    auto_accept_amount: mpListing?.auto_accept_amount ?? null,
    minimum_offer_amount: mpListing?.minimum_offer_amount ?? null,
    isFixed
  });

  // clean nulls so eBay doesn’t choke
  function stripNulls(obj: any) {
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        if (obj[k] && typeof obj[k] === 'object') stripNulls(obj[k]);
        if (obj[k] == null) delete obj[k];
      }
    }
    return obj;
  }
  stripNulls(offerBody);
  console.log('[ebay:offer.post.body]', safeStringify(offerBody));
  const offerRes = await ebayFetch(`/sell/inventory/v1/offer`, {
    method: 'POST',
    body: JSON.stringify(offerBody)
  });

   const offerId = offerRes?.offerId || offerRes?.id;
  if (!offerId) throw new Error(`Offer creation succeeded but no offerId returned: ${JSON.stringify(offerRes).slice(0,200)}`);

  // Verify Best Offer persisted and enforce if selected
  try {
    const offerEcho = await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, { method: 'GET' });
    // In the real response, Best Offer lives under listingPolicies.bestOfferTerms
    const lp  = (offerEcho as any)?.listingPolicies ?? null;
    const bot = lp?.bestOfferTerms ?? null;
    console.log('[ebay:offer.verify.bestOffer]', { listingPolicies: !!lp, bestOfferTerms: bot || null });

    const requestedBO = !!mpListing?.allow_best_offer;
    const gotBO = !!(bot && bot.bestOfferEnabled === true);

    if (requestedBO && !gotBO) {
      console.error('[ebay:enforce.bestOffer]', {
        requested: requestedBO,
        got: gotBO,
        reason: 'bestOfferTerms missing or disabled on offer'
      });
      throw new Error('ENFORCE_STOP: Best Offer was requested but not present on the created offer—publish aborted.');
    }
  } catch (e) {
    // If we can’t verify, stop as well to avoid silent regressions
    throw new Error(`ENFORCE_STOP: Failed to verify Best Offer on offer ${offerId}. ${(e as Error)?.message || e}`);
  }

  // Temporary pre-publish checks/enforcement
  console.log('[ebay:promote.requested]', {
    promote: !!mpListing?.promote,
    promote_percent: mpListing?.promote_percent ?? null,
    environment: envStr
  });

  if (ENFORCE_PROMOTE_ON_PROD && envStr === 'production' && mpListing?.promote) {
    // We haven’t yet attached the listing to a campaign at a fixed rate.
    // To avoid going live without promotion (which the user explicitly requested), stop here.
    throw new Error('ENFORCE_STOP: Promote was requested in Production but Marketing API isn’t wired yet. Aborting publish to avoid a non-promoted live listing.');
  }
  
  // (3) POST publish
  // (3) POST publish (with targeted fallback for 25101 Invalid <ShippingPackage>)
  let pubRes: any;
  try {
    pubRes = await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, {
      method: 'POST',
      body: JSON.stringify({})
    });
  } catch (err: any) {
    const msg = String(err?.message || err || '');
    console.warn('[ebay:publish.error]', msg);

    // If eBay says ShippingPackage invalid (25101), retry without packageType
    if (msg.includes('"errorId":25101') || msg.includes('Invalid <ShippingPackage>')) {
      console.warn('[ebay:publish.retry] Retrying without packageType');

      // Rebuild Inventory Item body omitting packageType (keep weight & size)
      const inventoryItemBodyNoType: any = {
        ...inventoryItemBody,
        packageWeightAndSize: {
          // omit packageType entirely
          weight:     { ...inventoryItemBody.packageWeightAndSize.weight },
          dimensions: { ...inventoryItemBody.packageWeightAndSize.dimensions }
        }
      };

      // PUT again without packageType
      console.log('[ebay:inventory_item.put.body#noType]', safeStringify(inventoryItemBodyNoType));
      await ebayFetch(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
        method: 'PUT',
        body: JSON.stringify(inventoryItemBodyNoType)
      });

      // Quick GET verify of what eBay persisted
      try {
        const persisted2 = await ebayFetch(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, { method: 'GET' });
        const pws2 =
          (persisted2 && (persisted2 as any).packageWeightAndSize) ||
          (persisted2 && (persisted2 as any).product && (persisted2 as any).product.packageWeightAndSize) ||
          null;
        console.log('[ebay:postput.verify#noType]', { packageWeightAndSize: pws2 });
      } catch {}

      // Create a fresh offer after updating the item (avoid stale-draft edge cases)
      const offerRes2 = await ebayFetch(`/sell/inventory/v1/offer`, {
        method: 'POST',
        body: JSON.stringify(offerBody)
      });
      const newOfferId = (offerRes2 as any)?.offerId || (offerRes2 as any)?.id;
      if (!newOfferId) {
        throw new Error(`Offer creation failed during 25101 retry: ${JSON.stringify(offerRes2).slice(0,200)}`);
      }

      // Publish again
      pubRes = await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(newOfferId)}/publish`, {
        method: 'POST',
        body: JSON.stringify({})
      });
    } else {
      throw err; // Different error — bubble up unchanged
    }
  }

  const remoteId  = pubRes?.listingId || pubRes?.itemId || null;
  const remoteUrl = pubRes?.listing?.itemWebUrl || pubRes?.itemWebUrl || null;

  // ── Promotion (resilient) ────────────────────────────────────────────────────
  let promoteResult: any = null;
  try {
    promoteResult = await promoteIfRequested({
      envStr,
      listingId: remoteId,
      promote: !!mpListing?.promote,
      promotePercent: mpListing?.promote_percent,
      sku // pass the SKU so we can create the ad by Inventory Reference first
    });
  } catch (e) {
    console.warn('[ebay:marketing.promote:error]', String(e || ''));
  }
  
  // Surface a concise warning if promotion didn’t complete
  if (promoteResult && promoteResult.promoted === false) {
    const r = String(promoteResult.reason || '');
    if (r === 'api_error') {
      warnings.push('Promotion attempt failed due to an eBay API error. Listing is live; promotion will need a retry.');
    } else if (r === 'access_denied') {
      warnings.push('Promotion failed: eBay Marketing permission missing or seller not opted-in.');
    } else if (r === 'not_requested_or_missing_inputs') {
      // no-op
    } else {
      warnings.push('Promotion did not complete; see logs for details.');
    }
  }
  
  const offerIdOut = offerId || null;
  const categoryIdOut = ebayCategoryId || null;
  const connectionIdOut = String(conn?.[0]?.connection_id || '') || null;
  const environmentOut = envStr || null;

  if (mpListing?.promote && envStr !== 'production') {
    warnings.push('Promotion requested but skipped in Sandbox');
  }  
  
  // capture applied campaign id if promotion succeeded
  const campaignIdApplied =
    promoteResult && promoteResult.promoted === true && promoteResult.campaignId
      ? String(promoteResult.campaignId)
      : null;

  return {
    remoteId,
    remoteUrl,
    offerId: offerIdOut,
    categoryId: categoryIdOut,
    connectionId: connectionIdOut,
    environment: environmentOut,
    campaignId: campaignIdApplied, // <-- NEW: pass campaign id up
    rawOffer: offerRes ?? null,
    rawPublish: pubRes ?? null,
    warnings
  };
} // <-

// ───────────────────────────────────────────────────────────────────────────────
// UPDATE / REVISE existing eBay listing via mp_offer_id (price/qty + inventory data)
// ───────────────────────────────────────────────────────────────────────────────
async function update(params: CreateParams): Promise<CreateResult> {
  const { env, tenant_id, item, profile, mpListing, images } = params;
  const sql = getSql(env);
  const warnings: string[] = [];

  // 0) Guard: require an existing offer id on the listing row
  const offerId = String(mpListing?.mp_offer_id || '').trim();
  if (!offerId) {
    throw new Error('update_requires_offer_id: mp_offer_id was not found on item_marketplace_listing');
  }

   // 1) Load + decrypt access token and resolve environment (mirror create, but prefer the same connection used to create this offer)
  const desiredConnId = String((mpListing as any)?.connection_id || '').trim();

  // First try: exact connection used by this listing (prevents env/account drift → 404s)
  let conn = desiredConnId
    ? await sql/*sql*/`
        SELECT mc.connection_id, mc.access_token, mc.token_expires_at, mc.environment, mc.secrets_blob
        FROM app.marketplace_connections mc
        JOIN app.marketplaces_available ma ON ma.id = mc.marketplace_id
        WHERE mc.tenant_id = ${tenant_id}
          AND ma.slug = 'ebay'
          AND mc.status = 'connected'
          AND mc.connection_id = ${desiredConnId}
        LIMIT 1
      `
    : [];

  // Fallback: latest connected (only if listing had no connection_id persisted)
  if (!conn?.length) {
    conn = await sql/*sql*/`
      SELECT mc.connection_id, mc.access_token, mc.token_expires_at, mc.environment, mc.secrets_blob
      FROM app.marketplace_connections mc
      JOIN app.marketplaces_available ma ON ma.id = mc.marketplace_id
      WHERE mc.tenant_id = ${tenant_id}
        AND ma.slug = 'ebay'
        AND mc.status = 'connected'
      ORDER BY mc.updated_at DESC
      LIMIT 1
    `;
  }

  if (!conn?.length) throw new Error('Tenant not connected to eBay (no matching connection)');
  
  const encKey = env.RP_ENCRYPTION_KEY || "";
  const encAccess = String(conn[0].access_token || "");
  if (!encAccess) throw new Error('No access_token stored');

  const accessObj = await decryptJson(encKey, encAccess);
  const accessToken = String(accessObj?.v || "").trim();
  if (!accessToken) throw new Error('Decrypted access_token is empty');

  // Environment (derive strictly from the selected connection; avoid silent sandbox fallback when a connection exists)
  let envStr = String(conn[0].environment || "").trim().toLowerCase() as EbayEnv | "";
  if (envStr !== "production" && envStr !== "sandbox") {
    try {
      const secrets = await decryptJson(encKey, String(conn[0].secrets_blob || ""));
      const e = String(secrets?.environment || "").trim().toLowerCase();
      if (e === "production" || e === "sandbox") envStr = e as EbayEnv;
    } catch {}
  }

  // If we still can't resolve, fail loudly in update (prevents cross-env 404 on offerId)
  if (envStr !== "production" && envStr !== "sandbox") {
    throw new Error('update_env_unresolved: could not resolve ebay environment from selected connection');
  }

  const base = ebayBase(envStr);

  // 🔎 Single debug log to make env/base visible in logs before touching the offer
  console.log('[ebay:update.env]', {
    connection_id: String(conn?.[0]?.connection_id || ''),
    environment: envStr,
    base
  });

  // Small helpers local to update
  function safeStringify(obj: any) { try { return JSON.stringify(obj, null, 2); } catch { return String(obj); } }
  async function ebayFetch(path: string, init: RequestInit) {
    const headers = {
      ...(init.headers || {}),
      'authorization': `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'content-language': 'en-US'
    };
    const url = `${base}${path}`;
    const r = await fetch(url, { ...init, headers });
    const txt = await r.text().catch(() => '');
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} :: ${txt}`.slice(0, 1000));
    try {
      return txt && (r.headers.get('content-type') || '').includes('application/json') ? JSON.parse(txt) : txt;
    } catch { return txt; }
  }

  // 2) Rebuild inventory item with the same mapping used in create (title, desc, aspects, weight/size, qty)
  const { cdnUrls } = (() => {
    const urls: string[] = [];
    const sorted = Array.isArray(images) ? [...images].sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0) || a.sort_order - b.sort_order) : [];
    for (const i of sorted) if (i?.cdn_url) urls.push(i.cdn_url);
    return { cdnUrls: urls };
  })();

  const rawCond = String(profile?.item_condition || '').trim().toLowerCase();
  const isNew = rawCond.startsWith('new') || rawCond === '';
  const conditionEnum = isNew ? 'NEW' : 'USED';
  const conditionDescription = !isNew && profile?.product_description
    ? String(profile.product_description).slice(0, 1000)
    : undefined;

  const computedQty = Math.max(1, Number((item && item.qty) != null ? item.qty : 1));
  const sku = String(item?.sku || '').trim();
  if (!sku) throw new Error('Missing SKU');

    // ── Resolve mapped specifics (same as create): category + Type/Model/Franchise/Sport ──
    let mappedSpecifics: { type: string | null; model: string | null; franchise: string | null; sport: string | null } = {
      type: null, model: null, franchise: null, sport: null
    };
    try {
      const rows = await sql/*sql*/`
        SELECT
          mcem.type_value,
          mcem.model_value,
          mcem.franchise_value,
          mcem.sport_value
        FROM app.marketplace_category_ebay_map AS mcem
        JOIN app.marketplace_categories      AS mc
          ON mc.category_key = mcem.category_key_uuid
        JOIN app.marketplaces_available      AS ma
          ON ma.id = mcem.marketplace_id
        WHERE ma.slug = 'ebay'
          AND mc.category_key = ${profile.listing_category_key}::uuid
        ORDER BY mcem.updated_at DESC NULLS LAST
        LIMIT 1
      `;
      const row = rows?.[0] || null;
      mappedSpecifics = {
        type:       row?.type_value       ?? null,
        model:      row?.model_value      ?? null,
        franchise:  row?.franchise_value  ?? null,
        sport:      row?.sport_value      ?? null
      };
    } catch (err) {
      console.warn('[ebay:update.category.map:warn]', String((err as Error)?.message || err || ''));
    }
  
    const inventoryItemBody: any = {
      condition: conditionEnum,
      ...(conditionDescription ? { conditionDescription } : {}),
      product: {
        title:       item?.product_short_title || '',
        description: profile?.product_description || '',
        aspects: {
          brand: profile?.brand_name ? [String(profile.brand_name)] : undefined,
          color: profile?.primary_color ? [String(profile.primary_color)] : undefined,
  
          // ── Inject mapped specifics when present (align with create()) ──
          ...(mappedSpecifics?.type      ? { Type:      [String(mappedSpecifics.type)] }       : {}),
          ...(mappedSpecifics?.model     ? { Model:     [String(mappedSpecifics.model)] }      : {}),
          ...(mappedSpecifics?.franchise ? { Franchise: [String(mappedSpecifics.franchise)] }  : {}),
          ...(mappedSpecifics?.sport     ? { Sport:     [String(mappedSpecifics.sport)] }      : {})
        },
        ...(cdnUrls.length ? { imageUrls: cdnUrls } : {})
      },
  
    packageWeightAndSize: {
      weight: {
        unit: 'KILOGRAM',
        value: (() => {
          const lb = Number(profile?.weight_lb ?? 0);
          const oz = Number(profile?.weight_oz ?? 0);
          const pounds = lb + (oz / 16);
          const kg = pounds * 0.45359237;
          const twoDp = Math.round(kg * 100) / 100;
          const safe = Math.max(0.01, twoDp);
          return Number(safe.toFixed(2));
        })()
      },
      dimensions: {
        height: Number(profile?.shipbx_height || 0),
        length: Number(profile?.shipbx_length || 0),
        width:  Number(profile?.shipbx_width  || 0),
        unit: 'INCH'
      }
    },
    availability: {
      shipToLocationAvailability: { quantity: computedQty }
    }
  };

  // PUT inventory item with latest title/description/aspects/weight/size/qty
  await ebayFetch(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    method: 'PUT',
    body: JSON.stringify(inventoryItemBody)
  });


  // 3) Ensure the live offer contains required itemSpecifics (e.g., Type) before price/qty update
  let offerEcho0: any = null;
  try {
    offerEcho0 = await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, { method: 'GET' });
  } catch (e) {
    console.warn('[ebay:update.offer.get.warn]', String((e as Error)?.message || e || ''));
  }

  function hasTypeSpecific(offer: any): boolean {
    try {
      const arr = Array.isArray(offer?.itemSpecifics) ? offer.itemSpecifics : [];
      return !!arr.find((sp: any) =>
        String(sp?.name || '').toLowerCase() === 'type' &&
        Array.isArray(sp?.values) &&
        String(sp.values[0] || '').trim() !== ''
      );
    } catch { return false; }
  }

  function statusOf(offer: any): string {
    // eBay returns various shapes; normalize to PUBLISHED/DRAFT if possible
    const s = String(
      offer?.status ??
      offer?.listing?.status ??
      offer?.offerStatus ??
      ''
    ).toUpperCase();
    return s || '';
  }

  // If Type is missing:
  // - For DRAFT offers: revise via PUT /offer/{id} (preserve your prior logic)
  // - For PUBLISHED offers: withdraw → recreate → publish, then proceed
  if (offerEcho0 && !hasTypeSpecific(offerEcho0)) {
    const st = statusOf(offerEcho0);

    // Build itemSpecifics from mappedSpecifics (same mapping used above & in create())
    const itemSpecifics: Array<{ name: string; values: string[] }> = [];
    const pushIf = (name: string, val: unknown) => {
      const s = String(val ?? '').trim();
      if (s) itemSpecifics.push({ name, values: [s] });
    };
    pushIf('Type',      mappedSpecifics.type);
    pushIf('Model',     mappedSpecifics.model);
    pushIf('Franchise', mappedSpecifics.franchise);
    pushIf('Sport',     mappedSpecifics.sport);

    if (st === 'DRAFT') {
      // Keep your existing PUT revise path for DRAFT offers
      if (itemSpecifics.length) {
        const reviseBody: any = {
          sku:                 String(item?.sku || offerEcho0?.sku || ''),
          marketplaceId:       String(offerEcho0?.marketplaceId || 'EBAY_US'),
          format:              String(offerEcho0?.format || 'FIXED_PRICE'),
          availableQuantity:   Number(item?.qty ?? offerEcho0?.availableQuantity ?? 1),
          listingDescription:  String(profile?.product_description ?? offerEcho0?.listingDescription ?? ''),
          categoryId:          offerEcho0?.categoryId || undefined,
          merchantLocationKey: offerEcho0?.merchantLocationKey || undefined,
          listingPolicies:     offerEcho0?.listingPolicies || undefined,
          pricingSummary:      offerEcho0?.pricingSummary || undefined,
          itemSpecifics
        };
        (function stripNulls(obj: any){ if(obj && typeof obj==='object'){ for(const k of Object.keys(obj)){ if(obj[k]&&typeof obj[k]==='object') stripNulls(obj[k]); if(obj[k]==null) delete obj[k]; } } return obj; })(reviseBody);

        console.log('[ebay:update.offer.put.body]', safeStringify(reviseBody));
        await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, {
          method: 'PUT',
          body: JSON.stringify(reviseBody)
        });
      } else {
        warnings.push('Offer missing required "Type" but mapping table returned no value; draft revise skipped.');
      }
    } else {
      // PUBLISHED (or any non-DRAFT): withdraw → recreate → publish
      console.log('[ebay:update.offer.withdraw]', { offerId });
      await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`, { method: 'POST', body: '{}' });

      // Build a fresh offer body (reuse your create() structure as closely as possible)
      const qty = Math.max(1, Number((item && item.qty) != null ? item.qty : 1));
      const priceValue =
        (mpListing?.buy_it_now_price ?? item?.price ?? null) != null
          ? Number(mpListing?.buy_it_now_price ?? item?.price)
          : null;

      // Carry forward location/policies from the existing offer when present
      const marketplaceId = String(offerEcho0?.marketplaceId || 'EBAY_US');
      const merchantLocationKey = offerEcho0?.merchantLocationKey || undefined;
      const listingPolicies = offerEcho0?.listingPolicies || {
        paymentPolicyId: mpListing?.payment_policy || undefined,
        returnPolicyId:  mpListing?.return_policy  || undefined,
        fulfillmentPolicyId: mpListing?.shipping_policy || undefined
      };

      const newOfferBody: any = {
        sku: String(item?.sku || offerEcho0?.sku || ''),
        marketplaceId,
        format: 'FIXED_PRICE',
        availableQuantity: qty,
        listingDescription: String(profile?.product_description || ''),
        categoryId: offerEcho0?.categoryId || undefined,
        merchantLocationKey,
        listingPolicies,
        pricingSummary: priceValue != null ? { price: { currency: 'USD', value: priceValue } } : undefined,
        itemSpecifics
      };
      (function stripNulls(obj: any){ if(obj && typeof obj==='object'){ for(const k of Object.keys(obj)){ if(obj[k]&&typeof obj[k]==='object') stripNulls(obj[k]); if(obj[k]==null) delete obj[k]; } } return obj; })(newOfferBody);

      console.log('[ebay:update.offer.create.body]', safeStringify(newOfferBody));
      const crt = await ebayFetch(`/sell/inventory/v1/offer`, {
        method: 'POST',
        body: JSON.stringify(newOfferBody)
      });
      const newOfferId = String((crt as any)?.offerId || '');

      if (!newOfferId) {
        throw new Error('recreate_offer_failed: POST /offer returned no offerId');
      }

      console.log('[ebay:update.offer.publish]', { newOfferId });
      const pub = await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(newOfferId)}/publish`, {
        method: 'POST',
        body: '{}'
      });

      // Persist new offerId for downstream (run.ts will also write it, but we log an event here)
      try {
        await sql/*sql*/`
          INSERT INTO app.item_marketplace_events
            (item_id, tenant_id, marketplace_id, kind, payload)
          VALUES (
            ${String((item as any)?.item_id || '')},
            ${tenant_id},
            ${Number(mpListing?.marketplace_id || 1)},
            'recreated',
            ${JSON.stringify({ fromOfferId: offerId, toOfferId: newOfferId, publish: pub ?? null })}
          )
        `;
      } catch (e) {
        console.warn('[ebay:update.event.recreated.warn]', String((e as Error)?.message || e || ''));
      }

      // Switch context to the newly created offer for the remainder of update()
      offerId = newOfferId;
      offerEcho0 = null; // force later GET to read fresh if needed
    }
  }

  // 4) Price/quantity updates via Offer API (applies to live listing without re-publish)
  const pricingFormat = String(mpListing?.pricing_format || 'fixed');
  const priceValue =
    (mpListing?.buy_it_now_price ?? item?.price ?? null) != null
      ? Number(mpListing?.buy_it_now_price ?? item?.price)
      : null;

  const pqBody: any = {
    price: priceValue != null ? { currency: 'USD', value: priceValue } : undefined,
    quantity: computedQty
  };
  // scrub undefineds
  Object.keys(pqBody).forEach(k => pqBody[k] == null && delete pqBody[k]);

  const updRes = await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/update_price_quantity`, {
    method: 'POST',
    body: JSON.stringify(pqBody)
  });

  // 4) Read back offer to return listing identifiers/URL
  const offerEcho = await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, { method: 'GET' });
  const remoteId  = (offerEcho as any)?.listing?.listingId || (offerEcho as any)?.listingId || null;
  const remoteUrl = (offerEcho as any)?.listing?.itemWebUrl || (offerEcho as any)?.itemWebUrl || null;

  return {
    remoteId,
    remoteUrl,
    offerId,
    categoryId: null,
    connectionId: String(conn?.[0]?.connection_id || '') || null,
    environment: envStr,
    campaignId: null,
    rawOffer: offerEcho ?? null,
    rawPublish: null,
    warnings
  };
}

export const ebayAdapter: MarketplaceAdapter = { create, update };

// end ebay.ts file
