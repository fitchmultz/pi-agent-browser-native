/**
 * Purpose: Provide TypeScript declarations for the pure helpers exported by the opt-in lifecycle verification script.
 * Responsibilities: Keep unit tests type-safe when importing the JavaScript maintainer harness.
 * Scope: Declaration surface only; runtime behavior lives in `verify-lifecycle.mjs`.
 * Usage: Imported automatically by TypeScript when tests import `scripts/verify-lifecycle.mjs`.
 * Invariants/Assumptions: Declarations mirror only helper APIs intentionally exercised outside the direct CLI run path.
 */

export interface LifecycleCliArgs {
	keepArtifacts: boolean;
	showHelp: boolean;
	timeoutMs: number;
	verbose: boolean;
}

export interface LifecycleSettingsPayload {
	enableInstallTelemetry: boolean;
	extensions: string[];
	packages: string[];
	prompts: string[];
	quietStartup: boolean;
	sessionDir: string;
	skills: string[];
	themes: string[];
}

export interface LifecycleToolResult {
	content?: Array<{ text?: string; type?: string }>;
	details?: {
		fullOutputPath?: string;
		fullOutputPaths?: string[];
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

export function parseCliArgs(argv?: string[]): LifecycleCliArgs;
export function parseJsonl(text: string): unknown[];
export function agentBrowserResults(entries: unknown[]): LifecycleToolResult[];
export function sentinelTokens(entries: unknown[]): string[];
export function collectFullOutputPaths(results: unknown[]): string[];
export function buildSettingsPayload(options: { packageDir: string; sessionDir: string }): LifecycleSettingsPayload;
export function injectLifecycleSentinelSource(source: string, token: string): string;
export function isDirectRun(metaUrl: string, argv?: string[]): boolean;
export function main(argv?: string[]): Promise<number>;
