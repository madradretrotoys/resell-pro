export type CreateParams = {
  env: any;
  tenant_id: string;
  item: any;
  profile: any;
  mpListing: any;
  images: Array<{ cdn_url: string; is_primary: boolean; sort_order: number }>;
};

export type CreateResult = {
  remoteId?: string | null;
  remoteUrl?: string | null;
  warnings?: string[];
};

export interface MarketplaceAdapter {
  create(params: CreateParams): Promise<CreateResult>;
  // future: update(), end()
}
