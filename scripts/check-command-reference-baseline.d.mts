/**
 * Purpose: Provide TypeScript declarations for the command-reference baseline documentation checker module.
 * Responsibilities: Type exported render helpers and CLI entrypoint consumed by TypeScript tests.
 * Scope: Compile-time declarations only; runtime behavior lives in check-command-reference-baseline.mjs.
 * Usage: Resolved automatically by TypeScript for imports of `./check-command-reference-baseline.mjs`.
 * Invariants/Assumptions: Keep declarations synchronized with exported helpers when generated-block behavior changes.
 */

export type CommandReferenceBaselineBlockId = "upstream-baseline" | "capability-token-baseline";

export function renderCommandReferenceBaselineBlock(id: CommandReferenceBaselineBlockId): string;
export function markedCommandReferenceBaselineBlock(id: CommandReferenceBaselineBlockId): string;
export function main(argv?: string[]): Promise<number>;
