/**
 * Purpose: Provide TypeScript declarations for the canonical command-reference capability baseline module.
 * Responsibilities: Type baseline metadata imported by TypeScript tests and JavaScript verifier scripts.
 * Scope: Compile-time declarations only; runtime data lives in agent-browser-capability-baseline.mjs.
 * Usage: Resolved automatically by TypeScript for imports of `./agent-browser-capability-baseline.mjs`.
 * Invariants/Assumptions: Keep declarations synchronized with exported metadata consumed by tests and scripts.
 */

export interface HelpCommand {
  label: string;
  args: readonly string[];
}

export interface UpstreamExpectation {
  token: string;
  help: string;
}

export interface CapabilityBaseline {
  targetVersion: string;
  helpCommands: readonly HelpCommand[];
  docRequiredTokens: readonly string[];
  upstreamExpectations: readonly UpstreamExpectation[];
}

export const CAPABILITY_BASELINE_SOURCE: string;
export const COMMAND_REFERENCE_DOC_PATH: string;
export const CAPABILITY_BASELINE_BLOCK_MARKER_PREFIX: string;
export const COMMAND_REFERENCE_BASELINE_BLOCK_IDS: readonly ["upstream-baseline", "capability-token-baseline"];
export const CAPABILITY_BASELINE: CapabilityBaseline;
export function expectedVersionLabel(): string;
