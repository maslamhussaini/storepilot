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
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
}
