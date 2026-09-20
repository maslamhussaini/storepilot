import { type InputHTMLAttributes } from "react";

/**
 * Text input matching the Phase 1 Business-step field exactly — same border,
 * radius, focus ring and error type styles. Extracted (not redesigned) so the
 * auth forms and the Business step cannot drift apart.
 */
export function FormField({
  id,
  label,
  error,
  hint,
  ...rest
}: {
  id: string;
  label: string;
  error?: string | null;
  hint?: string;
} & InputHTMLAttributes<HTMLInputElement>) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        className="mt-1.5 w-full rounded-lg border border-[var(--sp-border)] bg-transparent px-3 py-2 text-sm transition-colors focus:border-[var(--sp-green-500)] focus:outline-none focus:ring-2 focus:ring-[var(--sp-green-500)]/25"
        {...rest}
      />
      {error ? (
        <p id={errorId} className="mt-1 text-xs text-[#b42318]">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="mt-1 text-xs text-[var(--sp-muted)]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Inline status banner. Tones reuse the StatusBadge palette so success/error
 * colours stay consistent with the rest of the app.
 */
export function FormAlert({
  tone,
  children,
}: {
  tone: "error" | "success" | "info";
  children: React.ReactNode;
}) {
  const styles = {
    error: "border-[#f3c2c0] bg-[#fde8e8] text-[#b42318]",
    success:
      "border-[var(--sp-green-500)]/40 bg-[var(--sp-mint-100)] text-[var(--sp-emerald-800)]",
    info: "border-[var(--sp-border)] bg-black/[.03] text-[var(--sp-muted)] dark:bg-white/5",
  }[tone];

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-xl border px-4 py-3 text-sm ${styles}`}
    >
      {children}
    </div>
  );
}
