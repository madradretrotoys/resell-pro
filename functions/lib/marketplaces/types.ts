// Begin types.ts file
export type CreateParams = {
  env: any;
  tenant_id: string;
  item: any;
  profile: any;
  mpListing: any;
  images: Array<{ cdn_url: string; is_primary: boolean; sort_order: number }>;
};

export type CreateResult = {
  remoteId?: string | null;         // eBay listingId/itemId
  remoteUrl?: string | null;        // eBay itemWebUrl
  offerId?: string | null;          // eBay offerId used to publish
  categoryId?: string | null;       // eBay category id we resolved
  connectionId?: string | null;     // marketplace_connections.connection_id used
  environment?: string | null;      // 'production' | 'sandbox'
  rawOffer?: any;                   // raw offer response (for live_snapshot)
  rawPublish?: any;                 // raw publish response (for live_snapshot)
  warnings?: string[];
};

export interface MarketplaceAdapter {
  create(params: CreateParams): Promise<CreateResult>;
  // future: update(), end()
}
// end types.ts file
