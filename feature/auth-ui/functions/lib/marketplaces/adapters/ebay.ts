import type { MarketplaceAdapter, CreateParams, CreateResult } from '../types';
import { getSql } from '../../../../_shared/db';

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

async function create(params: CreateParams): Promise<CreateResult> {
  const { env, tenant_id, item, profile, mpListing, images } = params;
  const sql = getSql(env);

  // 1) Basic presence checks
  const warnings: string[] = [];
  if (!item?.sku) warnings.push('Missing SKU');
  if (!item?.product_short_title) warnings.push('Missing title');
  if (!images?.length) warnings.push('No images attached');

  // 2) Resolve eBay category id from marketplace_category_ebay_map via listing_category_key
  let ebayCategoryId: string | null = null;
  if (profile?.listing_category_key) {
    const rows = await sql/*sql*/`
      SELECT mcem.ebay_category_id
      FROM app.marketplace_category_ebay_map mcem
      WHERE mcem.category_key = ${profile.listing_category_key}
      ORDER BY mcem.updated_at DESC NULLS LAST
      LIMIT 1
    `;
    ebayCategoryId = rows?.[0]?.ebay_category_id ? String(rows[0].ebay_category_id) : null;
  } else {
    warnings.push('No listing_category_key on profile');
  }

  // 3) Pull tenant eBay connection (assumes access_token is usable as stored)
  const conn = await sql/*sql*/`
    SELECT mc.access_token, COALESCE(mc.environment, 'sandbox') AS environment
    FROM app.marketplace_connections mc
    JOIN app.marketplaces_available ma ON ma.id = mc.marketplace_id
    WHERE mc.tenant_id = ${tenant_id}
      AND ma.slug = 'ebay'
      AND mc.status = 'connected'
    ORDER BY mc.updated_at DESC
    LIMIT 1
  `;
  if (!conn?.length) {
    throw new Error('Tenant not connected to eBay');
  }
  const accessToken = String(conn[0].access_token || '').trim();
  const envStr = String(conn[0].environment || 'sandbox').toLowerCase() as EbayEnv;
  if (!accessToken) {
    throw new Error('Empty eBay access token');
  }

  // 4) Build payload from our rows (Rows 1–27, 29, 30; skip 33–38)
  const { primary, gallery } = pickPrimary(images || []);
  const pricingFormat = String(mpListing?.pricing_format || 'fixed'); // 'fixed' | 'auction'
  const isFixed = pricingFormat === 'fixed';

  const payload = {
    // Core
    title: item?.product_short_title || '',
    sku: item?.sku || '',                              // Row 29 → eBay Custom Label
    description: profile?.product_description || '',
    categoryId: ebayCategoryId || undefined,           // Row 30 resolved via map
    // Item specifics (lightweight — can be expanded to exact eBay aspect names/IDs if needed)
    aspects: {
      condition_key: profile?.condition_key || null,
      brand_key: profile?.brand_key || null,
      color_key: profile?.color_key || null
    },
    // Pricing
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
    // Fulfillment/policies
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

  // 5) Call eBay (Inventory/Listings). We use a single adapter endpoint that your gateway can evolve behind the scenes.
  // NOTE: If you already have a proxy route, you can point to it instead. This calls eBay directly.
  const base = ebayBase(envStr);
  const url = `${base}/sell/inventory/v1/listing`; // placeholder endpoint path; align with your gateway or chosen eBay API

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(txt.slice(0, 500));
  }

  const out = await res.json().catch(() => ({}));
  const remoteId  = out?.id || out?.listingId || out?.itemId || null;
  const remoteUrl = out?.url || out?.itemWebUrl || null;

  return {
    remoteId,
    remoteUrl,
    warnings
  };
}

export const ebayAdapter: MarketplaceAdapter = { create };
