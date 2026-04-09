/**
 * Purpose: Project-local development entrypoint for the pi-agent-browser extension.
 * Responsibilities: Re-export the real package extension so pi can load it directly from this repository during local tmux-based development and testing.
 * Scope: Local repository development only; package consumers load the extension through the package manifest instead.
 * Usage: Launch `pi` from this repository root and pi will auto-discover this file via `.pi/extensions/`.
 * Invariants/Assumptions: The implementation source of truth lives in `extensions/agent-browser/index.ts`.
 */

export { default } from "../../extensions/agent-browser/index.ts";
