// Purpose: Prevent native tool calls from crossing wrapper-owned managed-state boundaries.
// Responsibilities: Guard destructive global state operations, foreign checkout restore/state references, and browser file access to local agent-browser state.
// Scope: Pre-spawn policy only; result redaction and managed snapshot retention live elsewhere.

import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgvDescriptor } from "./argv-descriptor.js";
import { extractExplicitSessionName, optionalGlobalValueFlagConsumesNext } from "./argv-grammar.js";
import { extractManagedSessionRestoreKeys, isWrapperManagedSessionName } from "./managed-session-capabilities.js";
import { createManagedSessionRestoreKey, hasManagedSessionRestoreProjectIdentity } from "./managed-session-storage.js";

const BLOCKED_GLOBAL_STATE_MESSAGE = "This operation could read or modify wrapper-owned browser state outside the current checkout. Use a caller-owned state name or path instead.";
const BLOCKED_MANAGED_BROWSER_FILE_MESSAGE = "Browser access to .agent-browser storage is blocked because local state files can contain authenticated cookies and storage. Use the guarded state commands instead.";
const BLOCKED_MANAGED_SESSION_MESSAGE = "This session name is reserved for a browser managed by this extension instance. Use the current managed session or a caller-owned session name instead.";
const FILE_PAGE_NAVIGATION_COMMANDS = new Set([
	"back", "check", "click", "dblclick", "download", "drag", "drop", "fill", "focus", "forward", "hover", "key", "keyboard", "keydown", "keyup", "mouse", "press", "pushstate", "reload", "select", "swipe", "tap", "type", "uncheck", "upload",
]);
const SAFE_EXPLICIT_NAVIGATION_COMMANDS = new Set(["goto", "navigate", "open", "visit"]);

function decodeUrlComponent(value: string): string {
	let decoded = value;
	for (let attempt = 0; attempt < 8; attempt += 1) {
		try {
			const next = decodeURIComponent(decoded);
			if (next === decoded) break;
			decoded = next;
		} catch {
			break;
		}
	}
	return decoded;
}

function hasAgentBrowserPathComponent(value: string): boolean {
	return decodeUrlComponent(value).replaceAll("\\", "/").toLowerCase().split("/").includes(".agent-browser");
}

function getFileUrlPath(value: string | undefined): string | undefined {
	if (!value || !/^file:/i.test(value)) return undefined;
	try {
		return fileURLToPath(new URL(value));
	} catch {
		try {
			return decodeUrlComponent(new URL(value).pathname);
		} catch {
			return value;
		}
	}
}

function isFileDirectoryUrl(value: string | undefined): boolean {
	const filePath = getFileUrlPath(value);
	return filePath !== undefined && filePath.replaceAll("\\", "/").endsWith("/");
}

function isProtectedAgentBrowserFileTarget(value: string | undefined): boolean {
	if (!value) return false;
	const filePath = getFileUrlPath(value);
	const windowsPath = /^[a-z]:[\\/]/i.test(value);
	const pathValue = filePath ?? value;
	if (hasAgentBrowserPathComponent(pathValue)) {
		return filePath !== undefined || windowsPath || !/^[a-z][a-z\d+.-]*:/i.test(value);
	}
	if (filePath === undefined && !windowsPath && !isAbsolute(value)) return false;
	try {
		return hasAgentBrowserPathComponent(realpathSync(pathValue));
	} catch {
		return false;
	}
}

function getExplicitNavigationTarget(args: string[]): string | undefined {
	const descriptor = parseArgvDescriptor(args);
	if (SAFE_EXPLICIT_NAVIGATION_COMMANDS.has(descriptor.commandInfo.command ?? "")) return descriptor.commandTokens[1];
	if (descriptor.commandInfo.command === "tab" && descriptor.commandInfo.subcommand === "new") {
		for (let index = 2; index < descriptor.commandTokens.length; index += 1) {
			if (descriptor.commandTokens[index] === "--label") {
				index += 1;
				continue;
			}
			if (!descriptor.commandTokens[index]?.startsWith("-")) return descriptor.commandTokens[index];
		}
	}
	return undefined;
}

function getManagedBrowserFileAccessValidationError(options: { args: string[]; currentPageUrl?: string; stdin?: string }): string | undefined {
	const descriptor = parseArgvDescriptor(options.args);
	const command = descriptor.commandInfo.command;
	const subcommand = descriptor.commandInfo.subcommand;
	const explicitTarget = getExplicitNavigationTarget(options.args);
	if (options.args.some(isProtectedAgentBrowserFileTarget)
		|| (command === "eval" && options.stdin !== undefined && /(?:\.agent-browser|%2eagent-browser)/i.test(options.stdin))) {
		return BLOCKED_MANAGED_BROWSER_FILE_MESSAGE;
	}
	if (isProtectedAgentBrowserFileTarget(options.currentPageUrl)) {
		if (["close", "exit", "quit"].includes(command ?? "") || (command === "tab" && subcommand === "close")) return undefined;
		if (explicitTarget && !isProtectedAgentBrowserFileTarget(explicitTarget)) return undefined;
		return BLOCKED_MANAGED_BROWSER_FILE_MESSAGE;
	}
	if (isFileDirectoryUrl(options.currentPageUrl)) {
		if (FILE_PAGE_NAVIGATION_COMMANDS.has(command ?? "")) return BLOCKED_MANAGED_BROWSER_FILE_MESSAGE;
		if (command === "find" && descriptor.commandTokens.some((token) => ["check", "click", "fill", "hover"].includes(token))) return BLOCKED_MANAGED_BROWSER_FILE_MESSAGE;
	}
	return undefined;
}

function getResultingPageUrl(args: string[], currentPageUrl: string | undefined): string | undefined {
	return getExplicitNavigationTarget(args) ?? currentPageUrl;
}

export function getManagedSessionTargetAccessValidationError(args: string[], ownedManagedSession: boolean, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const sessionName = extractExplicitSessionName(args) ?? env.AGENT_BROWSER_SESSION;
	return sessionName && isWrapperManagedSessionName(sessionName) && !ownedManagedSession
		? BLOCKED_MANAGED_SESSION_MESSAGE
		: undefined;
}

function getFlagValues(args: string[], flag: "--restore" | "--state"): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token.startsWith(`${flag}=`)) {
			values.push(token.slice(flag.length + 1));
			continue;
		}
		if (token !== flag) continue;
		const value = args[index + 1];
		if (flag === "--restore" && !optionalGlobalValueFlagConsumesNext(flag, value)) continue;
		if (value !== undefined && !value.startsWith("-")) values.push(value);
	}
	return values;
}

function resolveExistingPath(cwd: string, value: string): string | undefined {
	try {
		return realpathSync(resolve(cwd, value));
	} catch {
		return undefined;
	}
}

function getReferencedValues(args: string[], cwd: string, env: NodeJS.ProcessEnv): string[] {
	const descriptor = parseArgvDescriptor(args);
	const values = [
		...args,
		...getFlagValues(args, "--restore"),
		...getFlagValues(args, "--state"),
		env.AGENT_BROWSER_RESTORE,
		env.AGENT_BROWSER_STATE,
	].filter((value): value is string => typeof value === "string" && value.length > 0);
	if (descriptor.commandInfo.command === "state" && ["clear", "load", "rename", "save", "show"].includes(descriptor.commandInfo.subcommand ?? "")) {
		values.push(...descriptor.commandTokens.slice(2));
	}
	for (const value of [...values]) {
		const realPath = resolveExistingPath(cwd, value);
		if (realPath) values.push(realPath);
	}
	return values;
}

export function getManagedSessionStateAccessValidationError(options: {
	args: string[];
	currentPageUrl?: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	parentEnv?: NodeJS.ProcessEnv;
	stdin?: string;
}): string | undefined {
	const descriptor = parseArgvDescriptor(options.args);
	const command = descriptor.commandInfo.command;
	const subcommand = descriptor.commandInfo.subcommand;
	if (command === "batch" && options.stdin) {
		try {
			const steps = JSON.parse(options.stdin) as unknown;
			if (Array.isArray(steps)) {
				let currentPageUrl = options.currentPageUrl;
				for (const step of steps) {
					if (!Array.isArray(step) || !step.every((token) => typeof token === "string")) continue;
					const error = getManagedSessionStateAccessValidationError({ ...options, args: step, currentPageUrl, stdin: undefined });
					if (error) return error;
					currentPageUrl = getResultingPageUrl(step, currentPageUrl);
				}
			}
		} catch {}
	}
	const browserFileError = getManagedBrowserFileAccessValidationError(options);
	if (browserFileError) return browserFileError;
	if (command === "state" && subcommand === "clean") return BLOCKED_GLOBAL_STATE_MESSAGE;
	if (command === "state" && subcommand === "clear") {
		const target = descriptor.commandTokens.slice(2).find((token) => !token.startsWith("-"));
		if (!target || descriptor.commandTokens.includes("--all") || descriptor.commandTokens.includes("-a") || isWrapperManagedSessionName(target)) {
			return BLOCKED_GLOBAL_STATE_MESSAGE;
		}
	}

	const effectiveEnv = { ...(options.parentEnv ?? process.env), ...options.env };
	const referencedValues = [
		...getReferencedValues(options.args, options.cwd, effectiveEnv),
		...(options.stdin ? [options.stdin] : []),
	];
	const referencedKeys = [...new Set(referencedValues.flatMap(extractManagedSessionRestoreKeys))];
	if (referencedKeys.length === 0) return undefined;
	if (command === "state" && ["rename", "save"].includes(subcommand ?? "")) return BLOCKED_GLOBAL_STATE_MESSAGE;
	if (!hasManagedSessionRestoreProjectIdentity(options.cwd)) return BLOCKED_GLOBAL_STATE_MESSAGE;
	const currentKey = createManagedSessionRestoreKey(options.cwd).toLowerCase();
	return referencedKeys.every((key) => key === currentKey) ? undefined : BLOCKED_GLOBAL_STATE_MESSAGE;
}
