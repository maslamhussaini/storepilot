"use client";

import { useActionState } from "react";
import { FormAlert, FormField } from "@/components/FormField";
import { SubmitButton } from "@/components/SubmitButton";
import {
  idleState as idleAuthState,
  type ActionState as AuthActionState,
} from "@/lib/forms/state";

/**
 * Shared email/password form for /login and /signup.
 *
 * State handling mirrors the Phase 1 Business step: inline per-field errors in
 * the same `text-[#b42318]` treatment, a form-level banner, and a button that
 * shows a pending label while the action runs.
 *
 * On sign-up, a `success` result means "account created but email confirmation
 * is required" — the action only ever returns success in that case, because a
 * fully-signed-in user is redirected server-side and never comes back here. So
 * we replace the form with the confirmation notice rather than implying the
 * user is logged in.
 */
export function AuthForm({
  mode,
  action,
  nextPath,
}: {
  mode: "login" | "signup";
  action: (
    state: AuthActionState,
    formData: FormData,
  ) => Promise<AuthActionState>;
  nextPath?: string;
}) {
  const [state, formAction] = useActionState(action, idleAuthState);

  if (mode === "signup" && state.status === "success") {
    return (
      <div className="sp-animate-in space-y-4">
        <FormAlert tone="success">{state.message}</FormAlert>
        <p className="text-sm text-[var(--sp-muted)]">
          Didn&apos;t get the email? Check your spam folder, then try signing in — we&apos;ll
          offer to resend it.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {nextPath ? <input type="hidden" name="next" value={nextPath} /> : null}

      {state.status === "error" && state.message ? (
        <FormAlert tone="error">{state.message}</FormAlert>
      ) : null}

      <FormField
        id="email"
        name="email"
        type="email"
        label="Email"
        autoComplete="email"
        placeholder="you@company.com"
        required
        error={state.fieldErrors?.email}
      />

      <FormField
        id="password"
        name="password"
        type="password"
        label="Password"
        autoComplete={mode === "login" ? "current-password" : "new-password"}
        placeholder="••••••••"
        required
        error={state.fieldErrors?.password}
        hint={mode === "signup" ? "At least 8 characters." : undefined}
      />

      <SubmitButton
        className="w-full"
        pendingLabel={mode === "login" ? "Signing in…" : "Creating account…"}
      >
        {mode === "login" ? "Sign in" : "Create account"}
      </SubmitButton>
    </form>
  );
}
