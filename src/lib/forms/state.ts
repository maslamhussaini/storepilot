/**
 * Shared form-action state.
 *
 * This lives OUTSIDE the `"use server"` action modules on purpose: a
 * `"use server"` file may only export async functions, so exporting a plain
 * object (`idleState`) or a runtime value from one is a build error
 * (https://nextjs.org/docs/messages/invalid-use-server-value). Keeping the
 * types and the initial value here lets both server actions and client
 * components import them freely.
 */

export interface ActionState {
  status: "idle" | "error" | "success";
  /** Form-level message, safe to show a merchant. Never a raw database error. */
  message?: string;
  /** Field-level errors, keyed by input `name`. */
  fieldErrors?: Record<string, string>;
}

export const idleState: ActionState = { status: "idle" };
