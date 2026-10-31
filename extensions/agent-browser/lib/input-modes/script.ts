import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import which from "which";
import { AGENT_BROWSER_CODE_MAX_TIMEOUT_MS } from "./types.js";
import { runScriptChild } from "./script-child.js";
import type { AgentBrowserScriptRunResult, RunAgentBrowserScriptOptions } from "./script-types.js";

export type {
	AgentBrowserScriptBrowserEnvelope,
	AgentBrowserScriptBrowserParams,
	AgentBrowserScriptRunResult,
	AgentBrowserScriptStepSummary,
	RunAgentBrowserScriptOptions,
} from "./script-types.js";
export {
	bindBrowserCodeCall,
	validateAgentBrowserScriptBrowserParams,
} from "./script-validation.js";
export {
	SCRIPT_FINAL_OUTPUT_MAX_BYTES as AGENT_BROWSER_SCRIPT_FINAL_OUTPUT_MAX_BYTES,
	SCRIPT_IPC_MESSAGE_MAX_BYTES as AGENT_BROWSER_SCRIPT_IPC_MESSAGE_MAX_BYTES,
	SCRIPT_MAX_CALLS as AGENT_BROWSER_SCRIPT_MAX_CALLS,
} from "./script-protocol.js";

export const AGENT_BROWSER_SCRIPT_CODE_MAX_BYTES = 64 * 1_024;
export const AGENT_BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS = 120_000;
export const AGENT_BROWSER_SCRIPT_NAMESPACE = "";
const SCRIPT_SESSION_NAME_PATTERN =
	/^piab-script-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A Bun-compiled Pi executable is not a Node runtime and rejects Node permission flags. */
export function resolveScriptChildNodePath(options: {
	readonly runtime: { readonly bun?: string };
	readonly execPath: string;
	readonly whichNode: () => string | null;
}): string {
	if (options.runtime.bun === undefined) {
		return options.execPath;
	}
	const nodePath = options.whichNode();
	if (nodePath === null) {
		throw new Error(
			"agent_browser_code requires a `node` runtime on PATH when pi runs on a Bun binary.",
		);
	}
	return nodePath;
}

function resolveScriptWorkerPath(): string {
	let currentDir = dirname(fileURLToPath(import.meta.url));
	while (!existsSync(join(currentDir, "package.json"))) {
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			throw new Error("Unable to resolve the pi-agent-browser-native package root.");
		}
		currentDir = parentDir;
	}
	const workerPath = join(currentDir, "dist", "extensions", "agent-browser", "script-worker.js");
	if (!existsSync(workerPath)) {
		throw new Error(
			"Compiled script worker is missing; run npm run build or reinstall pi-agent-browser-native.",
		);
	}
	// Node's permissioned entrypoint cannot traverse an ungranted symlink.
	return realpathSync(workerPath);
}

export function createAgentBrowserScriptCloseArgs(sessionName: string): string[] {
	return ["--namespace", AGENT_BROWSER_SCRIPT_NAMESPACE, "--session", sessionName, "close"];
}

export function isAgentBrowserScriptSessionName(value: unknown): value is string {
	return typeof value === "string" && SCRIPT_SESSION_NAME_PATTERN.test(value);
}

function invalidRun(
	error: string,
	failureCategory: "validation-error" | "missing-binary" | "aborted",
	aborted?: boolean,
): AgentBrowserScriptRunResult {
	return {
		...(aborted === true ? { aborted } : {}),
		callCount: 0,
		emitCount: 0,
		error,
		failureCategory,
		ok: false,
		rejectedCallCount: 0,
		steps: [],
	};
}

function sourceError(code: unknown): string | undefined {
	if (typeof code !== "string") {
		return "script must be a string.";
	}
	if (Buffer.byteLength(code, "utf8") > AGENT_BROWSER_SCRIPT_CODE_MAX_BYTES) {
		return `script must be ${AGENT_BROWSER_SCRIPT_CODE_MAX_BYTES} bytes or less.`;
	}
	return undefined;
}

function timeoutError(timeoutMs: number): string | undefined {
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs > AGENT_BROWSER_CODE_MAX_TIMEOUT_MS
	) {
		return `script timeoutMs must be between 1 and ${AGENT_BROWSER_CODE_MAX_TIMEOUT_MS}.`;
	}
	return undefined;
}

export async function runAgentBrowserScript(
	options: RunAgentBrowserScriptOptions,
): Promise<AgentBrowserScriptRunResult> {
	const error = sourceError(options.code);
	if (error !== undefined) {
		return invalidRun(error, "validation-error");
	}
	const timeoutMs = options.timeoutMs ?? AGENT_BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS;
	const invalidTimeout = timeoutError(timeoutMs);
	if (invalidTimeout !== undefined) {
		return invalidRun(invalidTimeout, "validation-error");
	}
	if (options.signal?.aborted === true) {
		return invalidRun("Script execution was aborted.", "aborted", true);
	}
	let workerPath: string;
	let childNodePath: string;
	try {
		workerPath = resolveScriptWorkerPath();
	} catch (failure) {
		return invalidRun(
			failure instanceof Error ? failure.message : "Compiled script worker is missing.",
			"missing-binary",
		);
	}
	try {
		childNodePath = resolveScriptChildNodePath({
			runtime: { bun: process.versions.bun },
			execPath: process.execPath,
			whichNode: () => which.sync("node", { nothrow: true }),
		});
	} catch (failure) {
		return invalidRun(
			failure instanceof Error
				? failure.message
				: "No Node runtime is available for the code child.",
			"missing-binary",
		);
	}
	return runScriptChild(options, childNodePath, workerPath, timeoutMs);
}
