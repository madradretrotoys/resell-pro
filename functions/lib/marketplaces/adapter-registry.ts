
// begin adapter-registry.ts file
import type { MarketplaceAdapter } from './types';
import { ebayAdapter } from './adapters/ebay';

const registryById = new Map<number, MarketplaceAdapter>();
const registryBySlug = new Map<string, MarketplaceAdapter>();

// For now, we register eBay only. Add others here as they come online.
function init() {
  if (registryById.size === 0) {
    registryById.set(1, ebayAdapter);        // if your 'ebay' id is 1; adjust if different
    registryBySlug.set('ebay', ebayAdapter);
  }
}

export function getRegistry() {
  init();
  return {
    byId: (id: number) => registryById.get(id),
    bySlug: (slug: string) => registryBySlug.get(slug)
  };
}
// end adapter-registry.ts file
