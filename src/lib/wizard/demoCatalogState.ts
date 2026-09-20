"use client";

/**
 * Session-scoped memory for the Catalog demo step.
 *
 * The wizard is a real Next.js route per step
 * (`/projects/[projectId]/wizard/[step]`), so navigating between steps fully
 * unmounts and remounts each step's client component — any local `useState`
 * is gone the moment you leave the page. That's correct for genuinely
 * ephemeral things (the Build simulation is meant to restart), but it made
 * Catalog behave inconsistently: Blueprint/Build/Launch all *display* an
 * already-imported catalog, yet navigating back to Catalog showed the
 * original empty "Choose file" state, as if nothing had happened.
 *
 * This module is the fix: a small `sessionStorage`-backed flag, scoped to one
 * browser tab and one project, recording only that the demo analysis ran and
 * what the user's fake filename was — never real file bytes or parsed
 * products. It intentionally does NOT go through Supabase. Real file bytes
 * can't be restored after a refresh anyway (browsers never let JS repopulate
 * a `<input type="file">`), so this only ever represents "the demo catalog
 * step has been completed in this browser session," which is exactly the
 * fact that downstream demo screens are already assuming.
 *
 * FUTURE WORK (not implemented here — see task requirement 9): once Catalog
 * genuinely re-imports a file, replacing it must invalidate whatever
 * Blueprint/Build downstream state depended on the old catalog (collections,
 * product counts, build resource totals). This module's `clearDemoCatalog`
 * is the seam where that invalidation would eventually be triggered — for
 * now "Replace file" only clears this flag and re-shows the upload zone; it
 * does not attempt to invalidate Blueprint/Build, which remain fixed sample
 * data regardless of what catalog state is active.
 */

export interface DemoCatalogState {
  /** User-facing filename shown in the summary. Never real file contents. */
  filename: string;
  /** Whether the demo analysis surfaced sample warnings (vs. a clean pass). */
  hasWarnings: boolean;
}

function storageKey(projectId: string): string {
  return `storepilot:demo-catalog:${projectId}`;
}

export function readDemoCatalog(projectId: string): DemoCatalogState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DemoCatalogState>;
    if (typeof parsed.filename !== "string") return null;
    return { filename: parsed.filename, hasWarnings: Boolean(parsed.hasWarnings) };
  } catch {
    return null;
  }
}

export function writeDemoCatalog(projectId: string, state: DemoCatalogState): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(storageKey(projectId), JSON.stringify(state));
  } catch {
    // sessionStorage can throw in private-browsing/storage-restricted contexts.
    // Worst case the demo simply forgets on navigation, which is the
    // pre-existing Phase 1 behavior — never a functional failure.
  }
}

export function clearDemoCatalog(projectId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(storageKey(projectId));
  } catch {
    // See writeDemoCatalog.
  }
}
