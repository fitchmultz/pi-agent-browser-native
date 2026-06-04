/**
 * Purpose: Compatibility barrel for focused result modules.
 * Responsibilities: Preserve the historical `./results/shared.js` import surface while delegating all logic to focused files.
 * Scope: Re-exports only; do not add runtime policy here.
 * Usage: Existing internal imports may keep using this path during migration, while new code should prefer focused modules.
 * Invariants/Assumptions: This file intentionally contains no business logic so `shared` cannot grow back into a catch-all module.
 */

export * from "./contracts.js";
export * from "./categories.js";
export * from "./action-recommendations.js";
export * from "./artifact-manifest.js";
export * from "./artifact-state.js";
export * from "./editable-ref-evidence.js";
export * from "./network.js";
export * from "./network-routes.js";
export * from "./next-actions.js";
export * from "./recovery-actions.js";
export * from "./recovery-next-actions.js";
export * from "./selector-recovery.js";
export * from "./text.js";
