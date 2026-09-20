/**
 * ============================================================================
 * PHASE 1 DEMO FIXTURES — NOT USED BY THE APPLICATION.
 * ============================================================================
 *
 * As of Phase 2A the dashboard renders REAL `sp_projects` rows belonging to the
 * signed-in user (see `src/lib/projects/queries.ts` and `src/app/page.tsx`).
 * Nothing in this file is imported by any route, component or server action —
 * it is retained only as a reference for the card layout and status vocabulary
 * that the Phase 1 visual design was approved against.
 *
 * Every export is prefixed `devOnly` so that an accidental import is obvious in
 * review and in a diff. DO NOT render these as if they were a user's data.
 *
 * Verify with: `grep -rn "devOnly" src/app src/components`  -> expect no hits.
 * ============================================================================
 */

export type ProjectStatus =
  | "Ready for review"
  | "Catalog imported"
  | "Draft"
  | "Building"
  | "Launched";

export interface Project {
  id: string;
  name: string;
  industry: string;
  status: ProjectStatus;
  readiness: number; // 0-100
  productCount: number;
  updatedAt: string;
}

export const devOnlyDemoProjects: Project[] = [
  {
    id: "royal-oud",
    name: "Royal Oud",
    industry: "Beauty & Cosmetics",
    status: "Ready for review",
    readiness: 94,
    productCount: 842,
    updatedAt: "2026-09-15",
  },
  {
    id: "abc-fashion",
    name: "ABC Fashion",
    industry: "Fashion & Apparel",
    status: "Catalog imported",
    readiness: 46,
    productCount: 318,
    updatedAt: "2026-09-12",
  },
  {
    id: "north-home",
    name: "North & Home",
    industry: "Home & Furniture",
    status: "Draft",
    readiness: 12,
    productCount: 0,
    updatedAt: "2026-09-08",
  },
];

export interface DashboardMetric {
  label: string;
  value: string;
  helpText: string;
}

export const devOnlyDashboardMetrics: DashboardMetric[] = [
  { label: "Active projects", value: "3", helpText: "Across all industries" },
  { label: "Products mapped", value: "1,160", helpText: "This month" },
  { label: "Avg. readiness score", value: "51%", helpText: "Up from 38% last week" },
  { label: "Stores launched", value: "0", helpText: "Demo phase — no live launches yet" },
];
