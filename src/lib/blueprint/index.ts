// Placeholder store-blueprint generation boundary (collections, nav, pages, theme style).
// Phase 1: typed stubs over demo data only.

export interface StoreBlueprint {
  style: string;
  collections: string[];
  navigation: string[];
  pages: string[];
}

/** Simulates blueprint generation from a chosen style. */
export function generateDemoBlueprint(style: string): StoreBlueprint {
  return {
    style,
    collections: ["New Arrivals", "Best Sellers", "Oud Collection", "Gift Sets"],
    navigation: ["Home", "Shop", "Collections", "About", "Contact"],
    pages: ["About Us", "Shipping & Returns", "FAQ", "Contact"],
  };
}
