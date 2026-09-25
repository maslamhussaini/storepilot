/**
 * Registers the `@/*` -> `src/*` resolver hook for `node --test`
 * (see `scripts/ts-alias-loader.mjs`). Used via `--import`, test-only.
 */
import { register } from "node:module";

register("./ts-alias-loader.mjs", import.meta.url);
