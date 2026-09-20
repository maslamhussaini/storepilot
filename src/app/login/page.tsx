import Link from "next/link";
import type { Metadata } from "next";
import { AuthLayout } from "@/components/AuthLayout";
import { AuthForm } from "@/components/AuthForm";
import { FormAlert } from "@/components/FormField";
import { signInAction } from "@/lib/auth/actions";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export const metadata: Metadata = {
  title: "Sign in — StorePilot",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  // Only a relative same-site path may be carried through to the action; the
  // action re-validates this anyway (defence in depth against open redirects).
  const nextPath =
    next && next.startsWith("/") && !next.startsWith("//") ? next : undefined;

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to pick up where you left off."
      footer={
        <>
          New to StorePilot?{" "}
          <Link
            href="/signup"
            className="font-semibold text-[var(--sp-emerald-700)] underline-offset-4 hover:underline dark:text-[var(--sp-mint-200)]"
          >
            Create an account
          </Link>
        </>
      }
    >
      {isSupabaseConfigured() ? (
        <AuthForm mode="login" action={signInAction} nextPath={nextPath} />
      ) : (
        <FormAlert tone="error">
          StorePilot isn&apos;t able to reach its servers right now. Please try again in a
          few minutes.
        </FormAlert>
      )}
    </AuthLayout>
  );
}
