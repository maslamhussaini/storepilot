/**
 * Hand-maintained database types for the Phase 2A schema.
 *
 * Kept by hand rather than generated so the repo has no build-time dependency
 * on a live Supabase project. Regenerate with
 * `npx supabase gen types typescript --local > src/lib/supabase/types.ts`
 * once a canonical project exists; the shape below matches what that command
 * emits for the two migrations in `supabase/migrations/`.
 */

/** The six wizard step keys. Mirrors the CHECK constraint on sp_projects.current_step. */
export const WIZARD_STEP_KEYS = [
  "connect",
  "business",
  "catalog",
  "blueprint",
  "build",
  "launch",
] as const;
export type WizardStepKey = (typeof WIZARD_STEP_KEYS)[number];

/** Project lifecycle. Mirrors the CHECK constraint on sp_projects.status. */
export const PROJECT_STATUSES = [
  "draft",
  "in_progress",
  "ready",
  "archived",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** JSON column/argument shape used by supabase-js (mirrors PostgREST's Json). */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type SpProject = {
  id: string;
  user_id: string;
  name: string;
  status: ProjectStatus;
  current_step: WizardStepKey;
  progress_percent: number;
  industry: string | null;
  country_code: string | null;
  currency_code: string | null;
  primary_language: string | null;
  created_at: string;
  updated_at: string;
}

export type SpBusinessProfile = {
  id: string;
  project_id: string;
  user_id: string;
  business_name: string;
  description: string;
  industry: string | null;
  country_code: string | null;
  currency_code: string;
  primary_language: string;
  secondary_language: string | null;
  brand_style: string | null;
  logo_url: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * NOTE: `Relationships` is required on every table by supabase-js's
 * `GenericTable` constraint. Omitting it makes the whole schema fail the
 * constraint, and `.from("…")` silently degrades to `never` — which shows up as
 * a wall of confusing "Property 'id' does not exist on type 'never'" errors
 * rather than a clear message. Both tables declare their foreign keys here.
 */
export interface Database {
  public: {
    Tables: {
      sp_projects: {
        Row: SpProject;
        Insert: Partial<SpProject> & { user_id: string };
        Update: Partial<SpProject>;
        Relationships: [
          {
            foreignKeyName: "sp_projects_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      sp_business_profiles: {
        Row: SpBusinessProfile;
        Insert: Partial<SpBusinessProfile> & {
          project_id: string;
          user_id: string;
        };
        Update: Partial<SpBusinessProfile>;
        Relationships: [
          {
            foreignKeyName: "sp_business_profiles_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: true;
            referencedRelation: "sp_projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sp_business_profiles_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: { [_ in never]: never };
    /**
     * Phase 2B.3A SECURITY DEFINER functions (migration
     * 20260921000200_create_shopify_security_definer_functions.sql).
     * Signatures hand-maintained to match the actual SQL — EXECUTE grants are
     * NOT expressible in types and are enforced in SQL (test scenario F):
     *   store_connection_tokens / get_connection_tokens / revoke_connection_tokens
     *     -> service_role ONLY (server-only callers)
     *   get_connection_tokens_by_id / claim_connection_token_refresh /
     *   complete_connection_token_refresh / release_connection_token_refresh /
     *   mark_connection_reauth_required -> service_role ONLY (refresh lifecycle)
     *   get_connection_metadata -> authenticated (+ service_role) — the safe
     *     wizard read; ownership checked inside via auth.uid().
     */
    Functions: {
      store_connection_tokens: {
        Args: {
          p_project_id: string;
          p_shop_domain: string;
          p_token_payload: Json;
        };
        Returns: string;
      };
      get_connection_metadata: {
        Args: { p_project_id: string };
        Returns: Array<{
          shop_domain: string;
          status: string;
          granted_scopes: string[] | null;
          installed_at: string | null;
          disconnected_at: string | null;
          last_verified_at: string | null;
        }>;
      };
      get_connection_tokens: {
        Args: { p_project_id: string };
        Returns: Array<{
          shop_domain: string;
          access_token: string | null;
          refresh_token: string | null;
          access_token_expires_at: string | null;
          refresh_token_expires_at: string | null;
        }>;
      };
      get_connection_tokens_by_id: {
        Args: { p_connection_id: string };
        Returns: Array<{
          connection_id: string;
          project_id: string;
          shop_domain: string;
          status: string;
          access_token: string | null;
          refresh_token: string | null;
          access_token_expires_at: string | null;
          refresh_token_expires_at: string | null;
          credential_version: number;
          refresh_claim_id: string | null;
          refresh_claim_expires_at: string | null;
        }>;
      };
      claim_connection_token_refresh: {
        Args: {
          p_connection_id: string;
          p_claim_id: string;
          p_expected_version: number;
          p_lease_seconds?: number;
        };
        Returns: Array<{
          claim_result: string;
          connection_id: string | null;
          project_id: string | null;
          shop_domain: string | null;
          status: string | null;
          access_token: string | null;
          refresh_token: string | null;
          access_token_expires_at: string | null;
          refresh_token_expires_at: string | null;
          credential_version: number | null;
        }>;
      };
      complete_connection_token_refresh: {
        Args: {
          p_connection_id: string;
          p_claim_id: string;
          p_expected_version: number;
          p_token_payload: Json;
          p_reason?: string;
          p_api_version?: string | null;
        };
        Returns: Array<{ result: string }>;
      };
      release_connection_token_refresh: {
        Args: { p_connection_id: string; p_claim_id: string };
        Returns: Array<{ result: string }>;
      };
      mark_connection_reauth_required: {
        Args: {
          p_connection_id: string;
          p_claim_id: string;
          p_expected_version: number;
          p_reason?: string;
        };
        Returns: Array<{ result: string }>;
      };
      revoke_connection_tokens: {
        Args: { p_project_id: string; p_reason?: string };
        Returns: undefined;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
}
