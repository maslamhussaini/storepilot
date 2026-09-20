import Link from "next/link";
import type { Metadata } from "next";
import { AuthLayout } from "@/components/AuthLayout";
import { AuthForm } from "@/components/AuthForm";
import { FormAlert } from "@/components/FormField";
import { signUpAction } from "@/lib/auth/actions";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export const metadata: Metadata = {
  title: "Create your account — StorePilot",
};

export default function SignupPage() {
  return (
    <AuthLayout
      title="Create your account"
      subtitle="Start building your first store in a few guided steps."
      footer={
        <>
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-semibold text-[var(--sp-emerald-700)] underline-offset-4 hover:underline dark:text-[var(--sp-mint-200)]"
          >
            Sign in
          </Link>
        </>
      }
    >
      {isSupabaseConfigured() ? (
        <AuthForm mode="signup" action={signUpAction} />
      ) : (
        <FormAlert tone="error">
          StorePilot isn&apos;t able to reach its servers right now. Please try again in a
          few minutes.
        </FormAlert>
      )}
    </AuthLayout>
  );
}
