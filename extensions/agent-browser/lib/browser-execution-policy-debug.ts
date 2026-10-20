import { AsyncLocalStorage } from "node:async_hooks";
import { debuglog } from "node:util";
import { isRecord } from "./parsing.js";

const debug = debuglog("pi-agent-browser-policy");
export const policyDebugEnabled = debug.enabled;
const attempts = policyDebugEnabled
	? new AsyncLocalStorage<{
			readonly attempt: number;
			readonly phase: "acquire" | "release";
		}>()
	: undefined;
let nextAttempt = 0;
const syscalls = new Set([
	"mkdir",
	"lstat",
	"stat",
	"scandir",
	"open",
	"read",
	"write",
	"rename",
	"rmdir",
	"unlink",
	"rm",
	"kill",
	"spawn",
]);

/** Standard NODE_DEBUG facility only; never include paths, records, messages or probe output. */
export function debugPolicyFailure(stage: string, reason: string, error?: unknown): void {
	if (!policyDebugEnabled) {
		return;
	}
	const context = attempts?.getStore();
	const code = nativeField(error, "code");
	const syscall = nativeField(error, "syscall");
	const exit =
		isRecord(error) && typeof error.code === "number" && Number.isSafeInteger(error.code)
			? error.code
			: "-";
	debug(
		"attempt=%s phase=%s stage=%s reason=%s code=%s syscall=%s exit=%s",
		context?.attempt ?? 0,
		context?.phase ?? "standalone",
		stage,
		reason,
		code,
		syscall,
		exit,
	);
}
function nativeField(error: unknown, field: "code" | "syscall"): string {
	const value: unknown = isRecord(error) ? error[field] : undefined;
	if (typeof value !== "string") {
		return "-";
	}
	if (field === "code") {
		return /^(?:E[A-Z0-9]{1,24}|ABORT_ERR|ERR_[A-Z_]{1,48})$/.test(value) ? value : "unknown";
	}
	// Node includes the executable path in spawn-error syscall strings.
	if (value.startsWith("spawn ")) {
		return "spawn";
	}
	return syscalls.has(value) ? value : "unknown";
}
export function withPolicyDebugAttempt<T>(run: () => T): T {
	return attempts === undefined
		? run()
		: attempts.run({ attempt: ++nextAttempt, phase: "acquire" }, run);
}
/** Retain the acquisition's opaque id when release runs in a later async context. */
export function policyDebugPhase<T>(phase: "release", run: () => T): () => T {
	const context = attempts?.getStore();
	return context === undefined || attempts === undefined
		? run
		: () => attempts.run({ ...context, phase }, run);
}
/** A bounded allowlisted descriptor, safe to retain until an existing absence check finishes. */
export function policyDebugError(error: unknown): {
	readonly code?: string | number;
	readonly syscall?: string;
} {
	const code = nativeField(error, "code");
	const syscall = nativeField(error, "syscall");
	let normalizedCode: string | number | undefined = code === "-" ? undefined : code;
	if (isRecord(error) && typeof error.code === "number" && Number.isSafeInteger(error.code)) {
		normalizedCode = error.code;
	}
	return { code: normalizedCode, syscall: syscall === "-" ? undefined : syscall };
}
