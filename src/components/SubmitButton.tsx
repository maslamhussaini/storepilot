"use client";

import { useFormStatus } from "react-dom";
import { GradientButton } from "@/components/GradientButton";

/**
 * Submit button that disables itself while its form is in flight.
 *
 * This is the duplicate-submission guard referenced in the project-creation and
 * business-save flows: `useFormStatus` reads the pending state of the enclosing
 * `<form>`, so a double-click cannot fire the action twice. Server-side
 * idempotency backs it up (see `createProjectAction`) for the case where the
 * client retries a POST outside React's control.
 */
export function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
  className,
  disabled,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  variant?: "primary" | "secondary" | "ghost";
  className?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();

  return (
    <GradientButton
      type="submit"
      variant={variant}
      className={className}
      disabled={pending || disabled}
      aria-busy={pending}
    >
      {pending ? pendingLabel : children}
    </GradientButton>
  );
}
