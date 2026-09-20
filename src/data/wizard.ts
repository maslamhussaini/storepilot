export interface Industry {
  id: string;
  label: string;
  icon: string;
}

export const industries: Industry[] = [
  { id: "fashion", label: "Fashion & Apparel", icon: "fashion" },
  { id: "beauty", label: "Beauty & Cosmetics", icon: "beauty" },
  { id: "home", label: "Home & Furniture", icon: "home" },
  { id: "electronics", label: "Electronics", icon: "electronics" },
  { id: "food", label: "Food & Beverage", icon: "food" },
  { id: "wellness", label: "Health & Wellness", icon: "wellness" },
  { id: "jewelry", label: "Jewelry & Accessories", icon: "jewelry" },
  { id: "sports", label: "Sports & Outdoors", icon: "sports" },
  { id: "toys", label: "Toys & Kids", icon: "toys" },
  { id: "pets", label: "Pet Supplies", icon: "pets" },
];

export interface BrandStyle {
  id: string;
  label: string;
  description: string;
}

export const brandStyles: BrandStyle[] = [
  { id: "luxury", label: "Luxury", description: "Deep tones, generous whitespace, refined type" },
  { id: "modern", label: "Modern", description: "Bold contrast, clean grids, confident color" },
  { id: "minimal", label: "Minimal", description: "Quiet, functional, product-first" },
  { id: "playful", label: "Playful", description: "Bright accents, rounded shapes, energetic" },
];

export interface MappingRowData {
  source: string;
  target: string;
  confidence: number;
}

export const catalogMappings: MappingRowData[] = [
  { source: "Item", target: "Product Title", confidence: 99 },
  { source: "SKU", target: "Variant SKU", confidence: 97 },
  { source: "Retail Price", target: "Variant Price", confidence: 96 },
  { source: "Stock Qty", target: "Inventory Quantity", confidence: 92 },
  { source: "Category", target: "Product Type", confidence: 88 },
  { source: "Description", target: "Body (HTML)", confidence: 85 },
  { source: "Image URL", target: "Image Src", confidence: 81 },
];

export const catalogSummary = {
  products: 842,
  categories: 18,
  issues: 7,
};

export interface BlueprintCollection {
  name: string;
  productCount: number;
}

export const blueprintCollections: BlueprintCollection[] = [
  { name: "New Arrivals", productCount: 64 },
  { name: "Best Sellers", productCount: 122 },
  { name: "Oud Collection", productCount: 48 },
  { name: "Gift Sets", productCount: 31 },
];

export const blueprintNav = ["Home", "Shop", "Collections", "About", "Contact"];

export const blueprintPages = ["About Us", "Shipping & Returns", "FAQ", "Contact"];

export interface BuildResource {
  id: string;
  label: string;
  total: number;
}

export const buildResources: BuildResource[] = [
  { id: "products", label: "Products", total: 842 },
  { id: "collections", label: "Collections", total: 18 },
  { id: "pages", label: "Pages", total: 4 },
  { id: "navigation", label: "Navigation", total: 5 },
  { id: "theme", label: "Theme", total: 1 },
];

export interface ReadinessBucketItem {
  label: string;
  detail: string;
}

export const readinessBuckets: {
  auto: ReadinessBucketItem[];
  review: ReadinessBucketItem[];
  action: ReadinessBucketItem[];
} = {
  auto: [
    { label: "842 Products", detail: "Mapped and imported from your catalog" },
    { label: "18 Collections", detail: "Generated from your product categories" },
    { label: "Navigation", detail: "Primary menu built from blueprint" },
    { label: "Pages", detail: "About, Shipping & Returns, FAQ, Contact" },
  ],
  review: [
    { label: "Product descriptions", detail: "12 descriptions flagged for tone review" },
    { label: "Refund policy", detail: "Draft generated — confirm before launch" },
  ],
  action: [
    { label: "Connect payment provider", detail: "Required before you can accept orders" },
    { label: "Configure domain", detail: "Not configured — Phase 2 feature" },
    { label: "Run a test order", detail: "Verify checkout end-to-end before going live" },
  ],
};
