"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { ActionState as AuthActionState } from "@/lib/forms/state";

/**
 * Authentication Server Actions.
 *
 * All three run on the server, so the Supabase session cookies are set with
 * `HttpOnly` and are never readable by client JavaScript.
 */

// AuthActionState / idleAuthState live in @/lib/forms/state (as ActionState /
// idleState) — a "use server" module may only export async functions.

const GENERIC_AUTH_ERROR =
  "We couldn't reach StorePilot's servers. Please check your connection and try again.";

/** Minimal, permissive shape check. Real validation is Supabase's job. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

function validateCredentials(email: string, password: string) {
  const fieldErrors: Record<string, string> = {};
  if (!email) fieldErrors.email = "Email is required";
  else if (!EMAIL_RE.test(email)) fieldErrors.email = "Enter a valid email address";
  if (!password) fieldErrors.password = "Password is required";
  return fieldErrors;
}

/**
 * Only relative, same-site paths are accepted as a post-login destination.
 * Anything else (absolute URL, protocol-relative `//evil.com`) is discarded —
 * otherwise `?next=` would be an open redirect.
 */
function safeNextPath(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

// ---------------------------------------------------------------------------

export async function signInAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState | never> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = safeNextPath(
    formData.get("next") ? String(formData.get("next")) : null,
  );

  const fieldErrors = validateCredentials(email, password);
  if (Object.keys(fieldErrors).length > 0) {
    return { status: "error", message: "Please fix the highlighted fields.", fieldErrors };
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      // Never distinguish "no such account" from "wrong password": doing so
      // turns the login form into an account-enumeration oracle.
      if (
        error.message.toLowerCase().includes("email not confirmed") ||
        error.code === "email_not_confirmed"
      ) {
        return {
          status: "error",
          message:
            "Please confirm your email address first — check your inbox for the confirmation link.",
        };
      }
      return { status: "error", message: "That email and password don't match." };
    }
  } catch (error) {
    console.error("[auth] signIn threw:", error);
    return { status: "error", message: GENERIC_AUTH_ERROR };
  }

  revalidatePath("/", "layout");
  redirect(next);
}

// ---------------------------------------------------------------------------

export async function signUpAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState | never> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  const fieldErrors = validateCredentials(email, password);
  if (password && password.length < MIN_PASSWORD_LENGTH) {
    fieldErrors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { status: "error", message: "Please fix the highlighted fields.", fieldErrors };
  }

  let needsEmailConfirmation = false;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signUp({ email, password });

    if (error) {
      if (error.code === "weak_password") {
        return {
          status: "error",
          message: "Please choose a stronger password.",
          fieldErrors: { password: error.message },
        };
      }
      if (error.code === "over_email_send_rate_limit") {
        return {
          status: "error",
          message: "Too many attempts. Please wait a minute and try again.",
        };
      }
      console.error("[auth] signUp failed:", error.message);
      return { status: "error", message: GENERIC_AUTH_ERROR };
    }

    // When "Confirm email" is ON in the Supabase project's auth settings,
    // signUp returns a user but NO session — the account is not usable yet. We
    // must not pretend the user is logged in. When it is OFF, a session is
    // returned and the cookies are already set, so we can go straight to the
    // dashboard.
    needsEmailConfirmation = data.session === null;

    // Supabase's anti-enumeration behaviour: signing up with an address that
    // already exists succeeds with an obfuscated user carrying no identities.
    // Show the same "check your inbox" message so the form reveals nothing.
    const alreadyRegistered =
      data.user !== null && (data.user.identities?.length ?? 0) === 0;
    if (alreadyRegistered) needsEmailConfirmation = true;
  } catch (error) {
    console.error("[auth] signUp threw:", error);
    return { status: "error", message: GENERIC_AUTH_ERROR };
  }

  if (needsEmailConfirmation) {
    return {
      status: "success",
      message:
        "Check your inbox — we've sent a confirmation link to " +
        email +
        ". You'll be able to sign in once you've confirmed your address.",
    };
  }

  revalidatePath("/", "layout");
  redirect("/");
}

// ---------------------------------------------------------------------------

export async function signOutAction(): Promise<never> {
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  } catch (error) {
    // Even if the server-side revocation fails, continue to /login: the proxy
    // will bounce the user back if the session somehow survived, and stranding
    // them on the dashboard after clicking "Sign out" is the worse outcome.
    console.error("[auth] signOut threw:", error);
  }

  revalidatePath("/", "layout");
  redirect("/login");
}
