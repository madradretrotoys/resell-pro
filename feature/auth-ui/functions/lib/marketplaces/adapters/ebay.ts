import type { MarketplaceAdapter, CreateParams, CreateResult } from '../types';

async function create(params: CreateParams): Promise<CreateResult> {
  const { item, profile, mpListing, images } = params;

  // Minimal payload assembly (we'll expand with real mapping & token usage next)
  // This proves the end-to-end path; returns a stubbed remote id/link for now.
  const primary = images?.[0]?.cdn_url || null;

  // TODO: pull/refresh token from app.marketplace_connections and call eBay
  // TODO: map category via app.marketplace_category_ebay_map, brand/color/condition via *_map tables
  // TODO: respect fixed/auction/best-offer settings in mpListing

  return {
    remoteId: null,
    remoteUrl: null,
    warnings: primary ? [] : ['No primary image set']
  };
}

export const ebayAdapter: MarketplaceAdapter = { create };
