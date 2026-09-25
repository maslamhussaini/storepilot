/**
 * Node ESM resolution hook so the REAL server-only TypeScript sources can run
 * under plain `node --test`.
 *
 * The application uses the Next.js `@/*` path alias (tsconfig `paths`);
 * Node's ESM resolver does not know it. This hook maps `@/*` to `src/*` and
 * applies Node-style extension probing (exact, `.ts`, `.tsx`, `/index.ts`).
 *
 * TEST-ONLY INFRASTRUCTURE: production resolves aliases through Next.js.
 * Registered by `scripts/register-ts-alias.mjs`.
 */
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC_ROOT = new URL("../src/", import.meta.url);

function isFile(url) {
  try {
    return statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = new URL(specifier.slice(2), SRC_ROOT).href;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      if (isFile(candidate)) {
        return nextResolve(candidate, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
