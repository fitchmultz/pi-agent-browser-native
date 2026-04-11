/**
 * Purpose: Provide the tracked repo-local pi development entrypoint for the agent-browser extension.
 * Responsibilities: Re-export the real extension module so launching pi from this repository root loads the current source tree without installing the package.
 * Scope: Local development wiring only; published package loading continues to flow through the `pi` manifest in package.json.
 * Usage: Auto-loaded by pi from `.pi/extensions/agent-browser.ts` when running from this repository root.
 * Invariants/Assumptions: This file stays a thin shim, mirrors the package entrypoint, and must not diverge from `extensions/agent-browser/index.ts`.
 */

export { default } from "../../extensions/agent-browser/index.ts";
