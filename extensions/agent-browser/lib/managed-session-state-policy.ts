// Purpose: Prevent native tool calls from crossing wrapper-owned managed-state boundaries.
// Responsibilities: Guard destructive global state operations and foreign checkout restore/state references.
// Scope: Pre-spawn policy only; result redaction and managed snapshot retention live elsewhere.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { parseArgvDescriptor } from "./argv-descriptor.js";
import { optionalGlobalValueFlagConsumesNext } from "./argv-grammar.js";
import { extractManagedSessionRestoreKeys } from "./managed-session-capabilities.js";
import { createManagedSessionRestoreKey, hasManagedSessionRestoreProjectIdentity } from "./managed-session-storage.js";

const WRAPPER_MANAGED_SESSION_PREFIX = "piab-";
const BLOCKED_GLOBAL_STATE_MESSAGE = "This operation could read or modify wrapper-owned browser state outside the current checkout. Use a caller-owned state name or path instead.";

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
				for (const step of steps) {
					if (!Array.isArray(step) || !step.every((token) => typeof token === "string")) continue;
					const error = getManagedSessionStateAccessValidationError({ ...options, args: step, stdin: undefined });
					if (error) return error;
				}
			}
		} catch {}
	}
	if (command === "state" && subcommand === "clean") return BLOCKED_GLOBAL_STATE_MESSAGE;
	if (command === "state" && subcommand === "clear") {
		const target = descriptor.commandTokens.slice(2).find((token) => !token.startsWith("-"));
		if (!target || descriptor.commandTokens.includes("--all") || descriptor.commandTokens.includes("-a") || target.startsWith(WRAPPER_MANAGED_SESSION_PREFIX)) {
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
