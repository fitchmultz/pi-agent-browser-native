/**
 * Purpose: Provide TypeScript declarations for the command-reference verifier's JavaScript module.
 * Responsibilities: Type exported constants and verifier helpers consumed by TypeScript unit tests.
 * Scope: Compile-time declarations only; runtime behavior lives in verify-command-reference.mjs.
 * Usage: Resolved automatically by TypeScript for imports of `./verify-command-reference.mjs`.
 * Invariants/Assumptions: Keep these declarations synchronized with the verifier exports when test-facing APIs change.
 */

export interface HelpCommand {
  label: string;
  args: readonly string[];
}

export interface UpstreamExpectation {
  token: string;
  help: string;
}

export interface VerifyCommandReferenceOptions {
  cwd?: string;
  run?: (args: readonly string[]) => Promise<string>;
  readDoc?: (path: string) => Promise<string>;
}

export const EXPECTED_VERSION: string;
export const HELP_COMMANDS: readonly HelpCommand[];
export const DOC_REQUIRED_TOKENS: readonly string[];
export const UPSTREAM_EXPECTATIONS: readonly UpstreamExpectation[];

export function collectMissingTokens(text: string, tokens: readonly string[]): string[];
export function stripGeneratedCapabilityBaselineBlocks(content: string): string;
export function verifyCommandReference(options?: VerifyCommandReferenceOptions): Promise<string[]>;
export function main(argv?: string[]): Promise<number>;
