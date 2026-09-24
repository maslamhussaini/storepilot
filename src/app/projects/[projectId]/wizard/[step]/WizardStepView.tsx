"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { GradientButton } from "@/components/GradientButton";
import { SubmitButton } from "@/components/SubmitButton";
import { StatusBadge } from "@/components/StatusBadge";
import { FormAlert, FormField } from "@/components/FormField";
import { UploadDropzone, type UploadState } from "@/components/UploadDropzone";
import { MappingRow } from "@/components/MappingRow";
import { BlueprintPreview } from "@/components/BlueprintPreview";
import { BuildProgress } from "@/components/BuildProgress";
import { ActivityFeed } from "@/components/ActivityFeed";
import { ReadinessScore } from "@/components/ReadinessScore";
import { LaunchCheck } from "@/components/LaunchCheck";
import { IndustryIcon } from "@/components/IndustryIcon";
import {
  advanceWizardAction,
  saveBusinessProfileAction,
} from "@/lib/projects/actions";
import { idleState } from "@/lib/forms/state";
import { nextStepId, prevStepId, wizardPath, stepIds } from "@/lib/wizard/steps";
import {
  readDemoCatalog,
  writeDemoCatalog,
  clearDemoCatalog,
  type DemoCatalogState,
} from "@/lib/wizard/demoCatalogState";
import type { WizardStepKey } from "@/lib/supabase/types";
import {
  industries,
  brandStyles,
  catalogMappings,
  catalogSummary,
  blueprintCollections,
  blueprintNav,
  blueprintPages,
  buildResources,
  readinessBuckets,
} from "@/data/wizard";
import { normalizeShopDomain } from "@/lib/shopify/shop";
import type { ShopifyConnectionStatus } from "@/lib/shopify/status";

/**
 * Wizard step bodies.
 *
 * Phase 2A split:
 *   * BUSINESS is REAL. It posts to `saveBusinessProfileAction`, which
 *     validates server-side and upserts `sp_business_profiles`. Its initial
 *     values come from the database via props, so a refresh restores them.
 *   * CONNECT, CATALOG, BLUEPRINT, BUILD and LAUNCH are still DEMO ONLY —
 *     see the `DemoNotice` on each. They know which project they are demoing
 *     against (they carry `projectId` through every navigation) but they write
 *     no data of their own. Their animation/simulation state is intentionally
 *     ephemeral: it represents no real work, so persisting it would imply a
 *     durability that does not exist.
 *
 * Step-to-step navigation is a `<form>` posting `advanceWizardAction`, so the
 * merchant's position is persisted to `sp_projects.current_step` on every
 * forward move — not just Business → Catalog.
 */

export interface BusinessProfileView {
  businessName: string;
  description: string;
  industry: string | null;
  brandStyle: string | null;
  countryCode: string | null;
  currencyCode: string;
  primaryLanguage: string;
  secondaryLanguage: string | null;
}

interface StepProps {
  step: WizardStepKey;
  projectId: string;
  projectName: string;
  profile: BusinessProfileView | null;
  /** Durable connection state from sp_shopify_connections (safe DTO). */
  connection: ShopifyConnectionStatus;
  /** Generic, non-sensitive OAuth failure reason code from the callback, if any. */
  oauthError?: string | null;
}

export function WizardStepView({
  step,
  projectId,
  projectName,
  profile,
  connection,
  oauthError = null,
}: StepProps) {
  switch (step) {
    case "connect":
      return <ConnectStep projectId={projectId} connection={connection} oauthError={oauthError} />;
    case "business":
      return <BusinessStep projectId={projectId} profile={profile} />;
    case "catalog":
      return <CatalogStep projectId={projectId} />;
    case "blueprint":
      return (
        <BlueprintStep
          projectId={projectId}
          brandStyle={profile?.brandStyle ?? "modern"}
          storeName={profile?.businessName || projectName}
        />
      );
    case "build":
      return (
        <BuildStep
          projectId={projectId}
          storeName={profile?.businessName || projectName}
        />
      );
    case "launch":
      return <LaunchStep projectId={projectId} />;
  }
}

/** Standard banner marking a step that does not persist anything yet. */
function DemoNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-xl border border-[var(--sp-border)] p-4">
      <p className="text-xs text-[var(--sp-muted)]">
        <span className="font-semibold">Demo step.</span> {children}
      </p>
    </div>
  );
}

/**
 * Forward/back navigation. "Back" is a plain link — moving backwards must not
 * rewind recorded progress. "Continue" is a form post so the new position is
 * written to the database before the navigation happens.
 */
function StepNav({
  projectId,
  step,
  nextLabel = "Continue →",
  nextDisabled,
}: {
  projectId: string;
  step: WizardStepKey;
  nextLabel?: string;
  nextDisabled?: boolean;
}) {
  const prev = prevStepId(step);
  const next = nextStepId(step);

  return (
    <div className="mt-8 flex items-center justify-between">
      {prev ? (
        <GradientButton variant="ghost" href={wizardPath(projectId, prev)}>
          ← Back
        </GradientButton>
      ) : (
        <span />
      )}
      {next ? (
        <form action={advanceWizardAction}>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="fromStep" value={step} />
          <input type="hidden" name="toStep" value={next} />
          <SubmitButton pendingLabel="Saving…" disabled={nextDisabled}>
            {nextLabel}
          </SubmitButton>
        </form>
      ) : (
        <span />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Connect — REAL Shopify OAuth + DURABLE connection (Phase 2B.3B-1)
//
// This posts straight to POST /api/shopify/authorize as a native HTML form
// (not a client fetch): the browser must literally follow the 302 redirect
// to Shopify's authorize page, which fetch() cannot do — it would just
// receive Shopify's HTML as a JS value instead of navigating there. This is
// also what keeps authorization server-initiated: the client never sees a
// client_id, a state value, or a token — it only ever submits a shop domain
// and gets redirected.
//
// DURABLE STATE: after the callback persists the connection (Vault +
// sp_shopify_connections, server-side), the connected view below is driven
// exclusively by the `connection` prop, which the Server Component reads from
// Supabase on EVERY render. Refresh, new tab, sign-out/sign-in all re-read
// the same row — never a query parameter, never sessionStorage. The
// `oauthError` prop only ever renders a failure banner; no query parameter
// can present a store as connected.
// ---------------------------------------------------------------------------

function ConnectStep({
  projectId,
  connection,
  oauthError,
}: {
  projectId: string;
  connection: ShopifyConnectionStatus;
  oauthError: string | null;
}) {
  const [shopInput, setShopInput] = useState("");
  const normalized = shopInput.trim() ? normalizeShopDomain(shopInput) : null;
  const shopLooksInvalid = shopInput.trim().length > 0 && normalized === null;

  // Single source of truth: durable DB metadata, nothing else.
  const connected = connection.connected;

  return (
    <div>
      <p className="text-sm text-[var(--sp-muted)]">
        Connect your store and let StorePilot prepare the foundation. Secure authorization
        keeps you in control — StorePilot never asks for your Shopify password.
      </p>

      {/* Node-link connection visual — original graphic, no Shopify branding reproduced */}
      <div className="mt-6 flex flex-col items-center gap-6 rounded-2xl border border-[var(--sp-border)] sp-gradient-soft p-10 text-center">
        <div className="flex w-full max-w-sm items-center justify-between">
          <div className="flex flex-col items-center gap-2">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl sp-gradient-primary text-white shadow-[0_8px_20px_-8px_rgba(4,46,36,0.5)]">
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
              </svg>
            </span>
            <span className="text-xs font-medium">StorePilot</span>
          </div>

          <svg viewBox="0 0 120 24" className="mx-2 h-6 w-24 flex-1" aria-hidden="true">
            <line
              x1="4"
              y1="12"
              x2="116"
              y2="12"
              stroke={connected ? "var(--sp-green-500)" : "var(--sp-border-strong)"}
              strokeWidth="2"
              strokeDasharray="6 6"
              className={connected ? "sp-dash-animate" : ""}
            />
            <circle
              cx={connected ? 100 : 16}
              cy="12"
              r="4"
              fill="var(--sp-green-500)"
              className={!connected ? "sp-pulse" : ""}
            />
          </svg>

          <div className="flex flex-col items-center gap-2">
            <span
              className={`flex h-14 w-14 items-center justify-center rounded-2xl border text-[var(--sp-emerald-800)] transition-colors ${
                connected
                  ? "border-[var(--sp-green-500)] bg-[var(--sp-mint-100)]"
                  : "border-[var(--sp-border-strong)] bg-white dark:bg-[var(--sp-surface-raised)]"
              }`}
            >
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M4 8l2-4h12l2 4M4 8v11a1 1 0 001 1h14a1 1 0 001-1V8M4 8h16M9 12a3 3 0 006 0" />
              </svg>
            </span>
            <span className="text-xs font-medium">Your store</span>
          </div>
        </div>

        {connected ? (
          <>
            <StatusBadge label="✓ Shopify connected" tone="success" />
            <p className="text-sm text-[var(--sp-muted)]">{connection.shopDomain}</p>
          </>
        ) : (
          <form
            action="/api/shopify/authorize"
            method="POST"
            className="flex w-full max-w-sm flex-col items-stretch gap-3"
          >
            <input type="hidden" name="projectId" value={projectId} />
            <FormField
              id="shop"
              name="shop"
              label="Shopify store domain"
              type="text"
              placeholder="mystore.myshopify.com"
              autoComplete="off"
              value={shopInput}
              onChange={(e) => setShopInput(e.target.value)}
              error={shopLooksInvalid ? "Enter a valid myshopify.com domain" : undefined}
            />
            <SubmitButton disabled={!normalized} pendingLabel="Redirecting to Shopify…">
              Connect Shopify →
            </SubmitButton>
          </form>
        )}
      </div>

      {oauthError ? (
        <div className="mt-4">
          <FormAlert tone="error">
            Shopify authorization couldn&apos;t be completed ({oauthError}). Please try
            again.
          </FormAlert>
        </div>
      ) : null}

      <div className="mt-4 rounded-xl border border-[var(--sp-border)] p-4">
        <p className="text-xs text-[var(--sp-muted)]">
          <span className="font-semibold">Secure connection.</span> Authorization runs for
          real against Shopify. Your connection is saved to your StorePilot account
          (tokens encrypted, never shown here) and stays connected across refreshes and
          sign-in. Catalog import and store build remain simulated in this preview.
        </p>
      </div>

      <StepNav projectId={projectId} step="connect" nextDisabled={!connected} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Business — REAL, persisted to sp_business_profiles
// ---------------------------------------------------------------------------

function BusinessStep({
  projectId,
  profile,
}: {
  projectId: string;
  profile: BusinessProfileView | null;
}) {
  const [state, formAction] = useActionState(saveBusinessProfileAction, idleState);

  // Seeded from the database, then owned by the client for the life of this
  // page. On refresh the server re-reads the profile and re-seeds these, which
  // is what makes the data survive without any client-side persistence.
  const [industry, setIndustry] = useState<string | null>(profile?.industry ?? null);
  const [brandStyle, setBrandStyle] = useState<string | null>(profile?.brandStyle ?? null);

  const fieldErrors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-8" noValidate>
      <input type="hidden" name="projectId" value={projectId} />
      {/* Selection widgets are buttons, so their values ride along as hidden inputs. */}
      <input type="hidden" name="industry" value={industry ?? ""} />
      <input type="hidden" name="brandStyle" value={brandStyle ?? ""} />
      <input type="hidden" name="countryCode" value={profile?.countryCode ?? ""} />
      <input type="hidden" name="currencyCode" value={profile?.currencyCode ?? "USD"} />
      <input type="hidden" name="primaryLanguage" value={profile?.primaryLanguage ?? "en"} />
      <input
        type="hidden"
        name="secondaryLanguage"
        value={profile?.secondaryLanguage ?? ""}
      />

      {state.status === "error" && state.message ? (
        <FormAlert tone="error">{state.message}</FormAlert>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField
          id="businessName"
          name="businessName"
          label="Business name"
          type="text"
          defaultValue={profile?.businessName ?? ""}
          placeholder="Royal Oud"
          error={fieldErrors.businessName}
        />
        <FormField
          id="description"
          name="description"
          label="Short description"
          type="text"
          defaultValue={profile?.description ?? ""}
          placeholder="Premium fragrance & oud house"
          error={fieldErrors.description}
        />
      </div>

      <fieldset>
        <legend className="text-sm font-medium">Industry</legend>
        {fieldErrors.industry ? (
          <p className="mt-1 text-xs text-[#b42318]">{fieldErrors.industry}</p>
        ) : null}
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {industries.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setIndustry(item.id)}
              aria-pressed={industry === item.id}
              className={`sp-card-hover flex flex-col items-center gap-1.5 rounded-xl border p-3 text-center text-xs transition-colors ${
                industry === item.id
                  ? "border-[var(--sp-green-500)] bg-[var(--sp-mint-100)] font-semibold text-[var(--sp-emerald-800)] shadow-[0_0_0_3px_rgba(16,185,129,0.15)] dark:bg-white/10 dark:text-[var(--sp-mint-200)]"
                  : "border-[var(--sp-border)] hover:border-[var(--sp-border-strong)] dark:hover:bg-white/5"
              }`}
            >
              <IndustryIcon
                icon={item.icon}
                className={`h-6 w-6 ${
                  industry === item.id
                    ? "text-[var(--sp-emerald-800)] dark:text-[var(--sp-mint-200)]"
                    : "text-[var(--sp-muted)]"
                }`}
              />
              {item.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-medium">Brand style</legend>
        {fieldErrors.brandStyle ? (
          <p className="mt-1 text-xs text-[#b42318]">{fieldErrors.brandStyle}</p>
        ) : null}
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {brandStyles.map((style) => {
            const cue: Record<string, string> = {
              luxury: "font-serif tracking-wide",
              modern: "font-sans font-bold",
              minimal: "font-sans font-light tracking-tight",
              playful: "font-sans font-semibold",
            };
            return (
              <button
                key={style.id}
                type="button"
                onClick={() => setBrandStyle(style.id)}
                aria-pressed={brandStyle === style.id}
                className={`sp-card-hover rounded-xl border p-4 text-left transition-colors ${
                  brandStyle === style.id
                    ? "border-[var(--sp-green-500)] bg-[var(--sp-mint-100)] shadow-[0_0_0_3px_rgba(16,185,129,0.15)] dark:bg-white/10"
                    : "border-[var(--sp-border)] hover:border-[var(--sp-border-strong)] dark:hover:bg-white/5"
                }`}
              >
                <p className={`text-base ${cue[style.id] ?? ""}`}>{style.label}</p>
                <p className="mt-1 text-xs text-[var(--sp-muted)]">{style.description}</p>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-8 flex items-center justify-between">
        <GradientButton variant="ghost" href={wizardPath(projectId, "connect")}>
          ← Back
        </GradientButton>
        <SubmitButton pendingLabel="Saving…">Continue →</SubmitButton>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// 3. Catalog — DEMO ONLY
// ---------------------------------------------------------------------------

function CatalogStep({ projectId }: { projectId: string }) {
  // `uploadState` drives the upload dropzone's own animation, and is
  // intentionally remount-local: it is the moment-to-moment "uploading /
  // analyzing" sequence, which has no meaning to resume mid-flight.
  const [uploadState, setUploadState] = useState<UploadState>("empty");

  // `imported` is the fact that survives navigating away and back — see
  // `demoCatalogState.ts`. It starts `null` on every mount (server-rendered
  // markup can't know sessionStorage) and is hydrated client-side in the
  // effect below, so the very first paint always matches the server.
  const [imported, setImported] = useState<DemoCatalogState | null>(null);
  const [mappingOpen, setMappingOpen] = useState(false);

  useEffect(() => {
    // Deliberately not a lazy `useState(() => readDemoCatalog(projectId))`
    // initializer: that would read sessionStorage during the very first
    // client render, before hydration reconciles against server-rendered
    // markup (which always sees `imported === null`, since sessionStorage
    // doesn't exist on the server) — a guaranteed hydration mismatch. Reading
    // it here, one tick after mount, is the standard safe pattern for
    // syncing from browser-only storage.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setImported(readDemoCatalog(projectId));
  }, [projectId]);

  function simulateUpload(filename: string) {
    setUploadState("uploading");
    setTimeout(() => setUploadState("analyzing"), 700);
    setTimeout(() => {
      setUploadState("warning");
      const record: DemoCatalogState = { filename, hasWarnings: true };
      writeDemoCatalog(projectId, record);
      setImported(record);
    }, 1600);
  }

  function handleReplace() {
    clearDemoCatalog(projectId);
    setImported(null);
    setMappingOpen(false);
    setUploadState("empty");
  }

  const isProcessing = uploadState === "uploading" || uploadState === "analyzing";
  // A catalog counts as "ready" either because this mount just finished the
  // demo analysis, or because a previous mount did and we restored the flag.
  const catalogReady = Boolean(imported) && !isProcessing;

  return (
    <div>
      {isProcessing || !imported ? (
        <UploadDropzone
          state={uploadState}
          onFile={(e) => simulateUpload(e.target.files?.[0]?.name ?? "catalog.csv")}
        />
      ) : (
        // Persisted/imported catalog state — distinct from the upload zone
        // above on purpose. There is no local `File` behind this any more
        // (browsers never let JS restore a file input's selection), so it
        // must not be presented as if a file were still "chosen."
        <div className="sp-animate-in rounded-2xl border border-[var(--sp-border)] p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--sp-mint-200)] text-[var(--sp-emerald-800)]">
                ✓
              </span>
              <div>
                <p className="text-sm font-medium">{imported.filename}</p>
                <p className="text-xs text-[var(--sp-muted)]">Catalog imported for this session</p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleReplace}
              className="rounded-full border border-[var(--sp-border-strong)] px-3 py-1.5 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/5"
            >
              Replace file
            </button>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-[var(--sp-border)] p-4 text-center">
              <p className="text-2xl font-bold tabular-nums">{catalogSummary.products}</p>
              <p className="text-xs text-[var(--sp-muted)]">Products</p>
            </div>
            <div className="rounded-xl border border-[var(--sp-border)] p-4 text-center">
              <p className="text-2xl font-bold tabular-nums">{catalogSummary.categories}</p>
              <p className="text-xs text-[var(--sp-muted)]">Collections</p>
            </div>
            <div className="rounded-xl border border-[var(--sp-border)] p-4 text-center">
              <p className="text-2xl font-bold tabular-nums text-[#a3510a]">
                {catalogSummary.issues}
              </p>
              <p className="text-xs text-[var(--sp-muted)]">Issues</p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setMappingOpen((v) => !v)}
            aria-expanded={mappingOpen}
            className="mt-4 text-xs font-semibold uppercase tracking-widest text-[var(--sp-emerald-700)] dark:text-[var(--sp-mint-200)]"
          >
            {mappingOpen ? "Hide mapping ▲" : "View mapping ▼"}
          </button>

          {mappingOpen && (
            <div className="mt-3 space-y-2">
              {catalogMappings.map((mapping, i) => (
                <div
                  key={mapping.source}
                  className="sp-animate-in"
                  style={{ animationDelay: `${i * 60}ms` }}
                >
                  <MappingRow mapping={mapping} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <DemoNotice>
        No spreadsheet is actually read and no products are stored — the counts and
        confidence scores above are fixed sample values. What StorePilot does remember, only
        for this browser tab, is the fact that the demo analysis ran, so Blueprint/Build/Launch
        and Catalog stay consistent if you navigate back and forth. It forgets when the tab
        closes, and real CSV/XLSX parsing and AI field mapping are still not part of this phase.
      </DemoNotice>

      <StepNav
        projectId={projectId}
        step="catalog"
        nextLabel="Analyze Catalog →"
        nextDisabled={!catalogReady}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Blueprint — DEMO ONLY
// ---------------------------------------------------------------------------

function BlueprintStep({
  projectId,
  brandStyle,
  storeName,
}: {
  projectId: string;
  brandStyle: string;
  storeName: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
      <div className="space-y-6">
        <div>
          <h3 className="text-sm font-semibold">Collections</h3>
          <ul className="mt-2 space-y-1.5">
            {blueprintCollections.map((c) => (
              <li
                key={c.name}
                className="flex items-center justify-between rounded-lg border border-[var(--sp-border)] px-3 py-2 text-sm"
              >
                <span>{c.name}</span>
                <span className="text-xs text-[var(--sp-muted)]">
                  {c.productCount} products
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="text-sm font-semibold">Navigation</h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {blueprintNav.map((item) => (
              <li key={item} className="rounded-full bg-black/5 px-3 py-1 text-xs dark:bg-white/10">
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="text-sm font-semibold">Pages</h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {blueprintPages.map((item) => (
              <li key={item} className="rounded-full bg-black/5 px-3 py-1 text-xs dark:bg-white/10">
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div>
        {/*
          The brand style and store name ARE real — they come from the saved
          business profile. Everything else on this screen is sample data.
        */}
        <BlueprintPreview style={brandStyle} storeName={storeName || "Your Store"} />
      </div>
      <div className="lg:col-span-2">
        <DemoNotice>
          Collections, navigation and pages are fixed sample values — the production
          blueprint engine is not implemented. Your brand style and store name are real,
          read back from the Business step.
        </DemoNotice>
        <StepNav projectId={projectId} step="blueprint" nextLabel="Build My Store ✦" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. Build — DEMO ONLY
// ---------------------------------------------------------------------------

const activityCopy: Record<string, string[]> = {
  products: [
    "Product catalog prepared",
    "Products validated and queued",
    "Product catalog import complete",
  ],
  collections: ["Men collection created", "Women collection created", "Collections build complete"],
  pages: ["About Us prepared", "Preparing FAQ...", "Pages build complete"],
  navigation: ["Primary navigation mapped", "Navigation build complete"],
  theme: ["Preparing SEO metadata...", "Theme build complete"],
};

function BuildStep({ projectId, storeName }: { projectId: string; storeName: string }) {
  // Simulation only — no build queue exists. Restarts on every mount, and that
  // is intentional: there is no real job whose state could be resumed.
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [logLines, setLogLines] = useState<string[]>([]);

  const totalUnits = useMemo(
    () => buildResources.reduce((sum, r) => sum + r.total, 0),
    [],
  );

  // Root cause of the old "Build complete" / incomplete-counts mismatch:
  // the interval advanced a resource cursor by directly mutating a `let`
  // variable captured by the `setProgress` updater. React 18 invokes state
  // updaters twice in development (Strict Mode) to surface exactly this kind
  // of impurity; the second invocation saw the *already-incremented* cursor
  // from the first, so the cursor could race ahead of what `progress` (whose
  // value React keeps from only one of the two calls) actually reflected —
  // the headline could flip to "complete" while a resource's own counter was
  // still short of its total. The fix: the updater now derives which
  // resource to advance purely from `prev`, with no variable outside it, so
  // calling it twice with the same `prev` is harmless and produces the same
  // result either way. "Complete" is no longer separate state at all — it is
  // derived from `progress` in render, so it can never disagree with the
  // counts on screen.
  useEffect(() => {
    const interval = setInterval(() => {
      setProgress((prev) => {
        const resource = buildResources.find((r) => (prev[r.id] ?? 0) < r.total);
        if (!resource) {
          clearInterval(interval);
          return prev;
        }
        const current = prev[resource.id] ?? 0;
        const stepSize = Math.max(1, Math.round(resource.total / 8));
        const nextValue = Math.min(resource.total, current + stepSize);
        return { ...prev, [resource.id]: nextValue };
      });
    }, 350);

    return () => clearInterval(interval);
  }, []);

  // Log lines are a pure function of `progress`, appended in response to
  // progress changing — not as a side effect buried inside the progress
  // updater above, for the same reason: side effects inside a `setState`
  // updater are unsafe under Strict Mode's double-invocation. `lastLoggedIdx`
  // tracks, per resource, which message has already been appended, so a
  // resource whose progress hasn't moved since the last tick is never
  // re-logged just because a *different* resource pushed the most recent line.
  const lastLoggedIdx = useRef<Record<string, number>>({});
  useEffect(() => {
    const newLines: string[] = [];
    for (const resource of buildResources) {
      const done = Math.min(resource.total, progress[resource.id] ?? 0);
      if (done <= 0) continue;
      const messages = activityCopy[resource.id] ?? [
        `${resource.label} prepared`,
        `${resource.label} build complete`,
      ];
      const isDone = done >= resource.total;
      const msgIdx = isDone
        ? messages.length - 1
        : Math.max(0, Math.min(messages.length - 2, Math.floor((done / resource.total) * (messages.length - 1))));
      if (lastLoggedIdx.current[resource.id] === msgIdx) continue;
      lastLoggedIdx.current[resource.id] = msgIdx;
      newLines.push(`✓ ${messages[msgIdx]}`);
    }
    // `logLines` is a time-ordered history of transitions, not a snapshot —
    // once `progress` moves past an intermediate message, that message can
    // only survive by having already been appended. It genuinely cannot be
    // derived from the current `progress` value alone (which is why this
    // can't simply be computed during render instead of via an effect).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (newLines.length > 0) setLogLines((lines) => [...lines, ...newLines]);
  }, [progress]);

  const doneUnits = buildResources.reduce(
    (sum, r) => sum + Math.min(r.total, progress[r.id] ?? 0),
    0,
  );
  const overallPercent = (doneUnits / totalUnits) * 100;
  const complete = doneUnits >= totalUnits;

  return (
    <div>
      <h3 className="text-lg font-semibold">
        {complete ? "Build complete" : `We're building ${storeName || "your store"}`}
      </h3>
      <p className="mt-1 text-sm text-[var(--sp-muted)]">
        In production, builds will continue safely in the background.
      </p>
      <div className="mt-5">
        <BuildProgress
          resources={buildResources}
          progressByResource={progress}
          overallPercent={overallPercent}
        />
      </div>
      <div className="mt-6">
        <h3 className="mb-2 text-sm font-semibold">Activity feed</h3>
        <ActivityFeed lines={logLines} active={!complete} />
      </div>

      <DemoNotice>
        This is a timed animation, not a real build. No Shopify resources are created and no
        job is queued; refreshing restarts the simulation.
      </DemoNotice>

      <StepNav
        projectId={projectId}
        step="build"
        nextLabel="View launch summary →"
        nextDisabled={!complete}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6. Launch — DEMO ONLY
// ---------------------------------------------------------------------------

function LaunchStep({ projectId }: { projectId: string }) {
  // Reaching this step means all previous steps were continued through, so
  // setup is complete by definition — but "setup complete" and "ready to
  // launch" are different claims. Setup finishing at 6/6 does not mean the
  // store is 100% launch-ready: readiness also depends on items in the
  // REVIEW/ACTION buckets below (policies to check, payment provider to
  // connect, etc.), which is why the two numbers below are allowed to differ
  // and must not be presented as the same metric.
  const readinessScore = 87;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1.5 font-medium text-[var(--sp-emerald-700)] dark:text-[var(--sp-mint-200)]">
          <span aria-hidden="true">✓</span> Setup: {stepIds.length}/{stepIds.length} steps complete
        </span>
        <span className="text-[var(--sp-muted)]">Launch readiness: {readinessScore}%</span>
      </div>

      <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start sm:gap-10">
        <ReadinessScore score={readinessScore} />
        <div className="flex-1">
          <h3 className="text-lg font-semibold">Your store is almost ready to launch.</h3>
          <p className="mt-1 text-sm text-[var(--sp-muted)]">
            Setup is complete, but launch readiness isn&apos;t the same thing — a few items
            below still need your review before you go live.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <GradientButton
              variant="secondary"
              type="button"
              disabled
              className="opacity-50 grayscale"
              title="Coming soon — demo preview only"
            >
              Preview Store
            </GradientButton>
            <GradientButton
              variant="secondary"
              type="button"
              disabled
              className="opacity-50 grayscale"
              title="Real Shopify connection is not implemented in this preview"
            >
              Open Shopify
            </GradientButton>
          </div>
        </div>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <LaunchCheck bucket="auto" items={readinessBuckets.auto} />
        <LaunchCheck bucket="review" items={readinessBuckets.review} />
        <LaunchCheck bucket="action" items={readinessBuckets.action} />
      </div>

      <DemoNotice>
        The readiness score and checklist are fixed sample values. Preview and publish are
        disabled because no live store exists — nothing here has been created on Shopify.
      </DemoNotice>

      <div className="mt-8 flex items-center justify-between">
        <GradientButton variant="ghost" href={wizardPath(projectId, "build")}>
          ← Back
        </GradientButton>
        <Link
          href="/"
          className="inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-all duration-200 sp-btn-primary"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
