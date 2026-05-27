/**
 * Purpose: Own upstream command-shape policies that decide whether the wrapper should allocate a managed browser session.
 * Responsibilities: Keep local/sessionless command grammar out of the runtime execution planner while preserving exact upstream shapes.
 * Scope: Pure argv-token policy; command discovery, subprocess execution, and presentation live in focused modules.
 */

import type { ArgvDescriptor } from "./argv-descriptor.js";
import { hasOnlyBooleanFlags, hasOnlyOptionFlags, isNonFlagToken, stripSessionlessShapeGlobalFlags } from "./argv-grammar.js";

const SESSIONLESS_AUTH_SUBCOMMANDS = new Set(["save", "list", "show", "delete", "remove"]);
const EMPTY_BOOLEAN_FLAGS = new Set<string>();
const JSON_BOOLEAN_FLAGS = new Set(["--json"]);
const AUTH_SAVE_BOOLEAN_FLAGS = new Set(["--json", "--password-stdin"]);
const AUTH_SAVE_VALUE_FLAGS = new Set(["--password", "--password-selector", "--submit-selector", "--url", "--username", "--username-selector"]);
const DASHBOARD_SUBCOMMANDS = new Set(["start", "stop"]);
const DASHBOARD_START_VALUE_FLAGS = new Set(["--port"]);
const DOCTOR_BOOLEAN_FLAGS = new Set(["--fix", "--json", "--offline", "--quick"]);
const INSTALL_BOOLEAN_FLAGS = new Set(["--with-deps", "-d"]);
const STATE_SESSIONLESS_SUBCOMMANDS = new Set(["list", "show", "clear", "clean", "rename"]);
const STATE_CLEAN_VALUE_FLAGS = new Set(["--older-than"]);

function isSessionlessAuthCommand(commandTokens: readonly string[]): boolean {
	const [, subcommand, target, ...rest] = commandTokens;
	if (!SESSIONLESS_AUTH_SUBCOMMANDS.has(subcommand ?? "")) return false;
	if (subcommand === "list") return target === undefined;
	if (!isNonFlagToken(target)) return false;
	if (subcommand === "save") return hasOnlyOptionFlags(rest, AUTH_SAVE_BOOLEAN_FLAGS, AUTH_SAVE_VALUE_FLAGS);
	return rest.length === 0;
}

function isSessionlessDashboardCommand(commandTokens: readonly string[]): boolean {
	const [, subcommand, ...rest] = commandTokens;
	if (subcommand === undefined) return true;
	if (!DASHBOARD_SUBCOMMANDS.has(subcommand)) return false;
	return subcommand === "start" ? hasOnlyOptionFlags(rest, JSON_BOOLEAN_FLAGS, DASHBOARD_START_VALUE_FLAGS) : rest.length === 0;
}

function isSessionlessStateCommand(commandTokens: readonly string[]): boolean {
	const [, subcommand, firstArg, secondArg, ...rest] = commandTokens;
	if (!STATE_SESSIONLESS_SUBCOMMANDS.has(subcommand ?? "")) return false;
	if (subcommand === "list") return firstArg === undefined;
	if (subcommand === "show") return isNonFlagToken(firstArg) && secondArg === undefined;
	if (subcommand === "rename") return isNonFlagToken(firstArg) && isNonFlagToken(secondArg) && rest.length === 0;
	if (subcommand === "clean") {
		const optionTokens = commandTokens.slice(2);
		return optionTokens.length > 0 && hasOnlyOptionFlags(optionTokens, EMPTY_BOOLEAN_FLAGS, STATE_CLEAN_VALUE_FLAGS);
	}
	if (subcommand !== "clear") return false;
	if ((firstArg === "--all" || firstArg === "-a") && secondArg === undefined) return true;
	if (!isNonFlagToken(firstArg)) return false;
	return secondArg === undefined || (secondArg === "--all" && rest.length === 0);
}

function isSessionlessCommand(commandTokens: readonly string[]): boolean {
	const normalizedTokens = stripSessionlessShapeGlobalFlags(commandTokens);
	const [command, subcommand] = normalizedTokens;
	if (command === "skills") return ["list", "get", "path"].includes(subcommand ?? "");
	if (command === "auth") return isSessionlessAuthCommand(normalizedTokens);
	if (command === "dashboard") return isSessionlessDashboardCommand(normalizedTokens);
	if (command === "device") return normalizedTokens.length === 2 && subcommand === "list";
	if (command === "doctor") return hasOnlyBooleanFlags(normalizedTokens.slice(1), DOCTOR_BOOLEAN_FLAGS);
	if (command === "install") return hasOnlyBooleanFlags(normalizedTokens.slice(1), INSTALL_BOOLEAN_FLAGS);
	if (command === "profiles" || command === "upgrade") return normalizedTokens.length === 1;
	if (command === "session") return normalizedTokens.length === 2 && subcommand === "list";
	if (command === "state") return isSessionlessStateCommand(normalizedTokens);
	return false;
}

export function needsManagedSession(descriptor: ArgvDescriptor): boolean {
	return !isSessionlessCommand(descriptor.commandTokens);
}
