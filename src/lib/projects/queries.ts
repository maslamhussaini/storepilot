import "server-only";

import { cache } from "react";
import type { SpBusinessProfile, SpProject } from "@/lib/supabase/types";
import {
  createSupabaseServerClient,
  SupabaseNotConfiguredError,
} from "@/lib/supabase/server";
import { getAuth } from "@/lib/auth/dal";
import { isUuid } from "@/lib/projects/ids";

/**
 * Data Access Layer — projects.
 *
 * Every function here re-derives the caller from the session and lets Postgres
 * RLS scope the rows. Note what is *absent*: none of these take a `userId`
 * parameter. There is deliberately no way for a caller to ask for someone
 * else's data, because the query never expresses ownership as an argument.
 *
 * Reads are additionally filtered by `.eq("id", projectId)` only — the
 * `user_id = auth.uid()` restriction comes from the RLS policy, so a tampered
 * projectId in the URL returns zero rows rather than another tenant's project
 * (security scenario G).
 */

export type QueryResult<T> =
  | { status: "ok"; data: T }
  | { status: "unavailable" }
  | { status: "schema_missing" }
  | { status: "unauthenticated" };

/**
 * PostgREST's code for "no such table/view in the exposed schema" — distinct
 * from a network failure, a misconfigured client, or an auth error. Surfacing
 * it separately matters during environment bring-up: connecting a fresh
 * Supabase project (real URL, real key, reachable Auth/REST API) before its
 * migrations have been applied is a normal, expected state, not an outage.
 * Telling an operator "servers unavailable" in that case sends them chasing a
 * network problem that doesn't exist.
 */
const SCHEMA_MISSING_CODE = "PGRST205";

function isSchemaMissingError(error: { code?: string } | null | undefined): boolean {
  return error?.code === SCHEMA_MISSING_CODE;
}

export interface ProjectWithProfile {
  project: SpProject;
  profile: SpBusinessProfile | null;
}

/** All of the current user's non-archived projects, newest activity first. */
export const listProjects = cache(async (): Promise<QueryResult<SpProject[]>> => {
  const auth = await getAuth();
  if (auth.status === "unavailable") return { status: "unavailable" };
  if (auth.status === "anonymous") return { status: "unauthenticated" };

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("sp_projects")
      .select("*")
      .neq("status", "archived")
      .order("updated_at", { ascending: false });

    if (error) {
      // Log the real cause for operators; never surface it to the merchant.
      console.error("[projects] listProjects failed:", error.message);
      if (isSchemaMissingError(error)) return { status: "schema_missing" };
      return { status: "unavailable" };
    }
    return { status: "ok", data: data ?? [] };
  } catch (error) {
    if (!(error instanceof SupabaseNotConfiguredError)) {
      console.error("[projects] listProjects threw:", error);
    }
    return { status: "unavailable" };
  }
});

/**
 * One project plus its business profile.
 *
 * Returns `null` data for both "does not exist" and "belongs to someone else",
 * which are deliberately indistinguishable to the caller — distinguishing them
 * would leak the existence of other tenants' project ids.
 */
export const getProjectWithProfile = cache(
  async (projectId: string): Promise<QueryResult<ProjectWithProfile | null>> => {
    const auth = await getAuth();
    if (auth.status === "unavailable") return { status: "unavailable" };
    if (auth.status === "anonymous") return { status: "unauthenticated" };

    // Reject anything that is not a UUID before it reaches Postgres: an
    // invalid uuid literal makes PostgREST return a 400, which we would then
    // have to translate anyway. Cheaper and clearer to short-circuit.
    if (!isUuid(projectId)) return { status: "ok", data: null };

    try {
      const supabase = await createSupabaseServerClient();

      const { data: project, error: projectError } = await supabase
        .from("sp_projects")
        .select("*")
        .eq("id", projectId)
        .maybeSingle();

      if (projectError) {
        console.error("[projects] getProject failed:", projectError.message);
        if (isSchemaMissingError(projectError)) return { status: "schema_missing" };
        return { status: "unavailable" };
      }
      if (!project) return { status: "ok", data: null };

      const { data: profile, error: profileError } = await supabase
        .from("sp_business_profiles")
        .select("*")
        .eq("project_id", projectId)
        .maybeSingle();

      if (profileError) {
        console.error("[projects] getProfile failed:", profileError.message);
        if (isSchemaMissingError(profileError)) return { status: "schema_missing" };
        return { status: "unavailable" };
      }

      return { status: "ok", data: { project, profile: profile ?? null } };
    } catch (error) {
      if (!(error instanceof SupabaseNotConfiguredError)) {
        console.error("[projects] getProjectWithProfile threw:", error);
      }
      return { status: "unavailable" };
    }
  },
);

export { isUuid };
