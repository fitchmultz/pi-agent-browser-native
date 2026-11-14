import type { ArgvDescriptor } from "./argv-descriptor.js";
import { getExplicitReadUrl } from "./read-command.js";
export { getExplicitReadUrl } from "./read-command.js";
import {
	hasOnlyBooleanFlags,
	hasOnlyOptionFlags,
	isNonFlagToken,
	stripSessionlessShapeGlobalFlags,
} from "./argv-grammar.js";
import { getUpstreamEffectiveBatchSteps } from "./orchestration/batch-stdin.js";

const SESSIONLESS_AUTH_SUBCOMMANDS = new Set(["save", "list", "show", "delete", "remove"]);
const PLUGIN_SESSIONLESS_SUBCOMMANDS = new Set(["list", "show", "add", "install", "run"]);
const SKILLS_SESSIONLESS_SUBCOMMANDS = new Set(["list", "get", "path"]);
const EMPTY_BOOLEAN_FLAGS = new Set<string>();
const JSON_BOOLEAN_FLAGS = new Set(["--json"]);
const AUTH_SAVE_BOOLEAN_FLAGS = new Set(["--json", "--password-stdin"]);
const AUTH_SAVE_VALUE_FLAGS = new Set([
	"--password",
	"--password-selector",
	"--submit-selector",
	"--url",
	"--username",
	"--username-selector",
]);
const DASHBOARD_VALUE_FLAGS = new Set(["--allowed-origins", "--port"]);
const DOCTOR_BOOLEAN_FLAGS = new Set([
	"--fix",
	"--headed",
	"--json",
	"--offline",
	"--quick",
	"--webgpu",
]);
const INSTALL_BOOLEAN_FLAGS = new Set(["--with-deps", "-d"]);
const STATE_SESSIONLESS_SUBCOMMANDS = new Set(["list", "show", "clear", "clean", "rename"]);
const STATE_CLEAN_VALUE_FLAGS = new Set(["--older-than"]);
const SESSION_ID_VALUE_FLAGS = new Set(["--scope", "--prefix"]);

function isSessionlessAuthCommand(commandTokens: readonly string[]): boolean {
	const subcommand = commandTokens.at(1);
	const target = commandTokens.at(2);
	const rest = commandTokens.slice(3);
	if (!SESSIONLESS_AUTH_SUBCOMMANDS.has(subcommand ?? "")) {
		return false;
	}
	if (subcommand === "list") {
		return target === undefined;
	}
	if (!isNonFlagToken(target)) {
		return false;
	}
	if (subcommand === "save") {
		return hasOnlyOptionFlags(rest, AUTH_SAVE_BOOLEAN_FLAGS, AUTH_SAVE_VALUE_FLAGS);
	}
	return rest.length === 0;
}

function isSessionlessDashboardCommand(commandTokens: readonly string[]): boolean {
	const [, subcommand, ...rest] = commandTokens;
	if (subcommand === "stop") {
		return rest.length === 0;
	}
	return hasOnlyOptionFlags(
		subcommand === "start" ? rest : commandTokens.slice(1),
		JSON_BOOLEAN_FLAGS,
		DASHBOARD_VALUE_FLAGS,
	);
}

function isSessionlessStateClear(operands: readonly string[]): boolean {
	const firstArg = operands.at(0);
	const secondArg = operands.at(1);
	const rest = operands.slice(2);
	if ((firstArg === "--all" || firstArg === "-a") && secondArg === undefined) {
		return true;
	}
	return (
		isNonFlagToken(firstArg) &&
		(secondArg === undefined || (secondArg === "--all" && rest.length === 0))
	);
}

function isSessionlessStateCommand(commandTokens: readonly string[]): boolean {
	const subcommand = commandTokens.at(1);
	const firstArg = commandTokens.at(2);
	const secondArg = commandTokens.at(3);
	const rest = commandTokens.slice(4);
	if (!STATE_SESSIONLESS_SUBCOMMANDS.has(subcommand ?? "")) {
		return false;
	}
	switch (subcommand) {
		case undefined:
			return false;
		case "list":
			return firstArg === undefined;
		case "show":
			return isNonFlagToken(firstArg) && secondArg === undefined;
		case "rename":
			return isNonFlagToken(firstArg) && isNonFlagToken(secondArg) && rest.length === 0;
		case "clean": {
			const optionTokens = commandTokens.slice(2);
			return (
				optionTokens.length > 0 &&
				hasOnlyOptionFlags(optionTokens, EMPTY_BOOLEAN_FLAGS, STATE_CLEAN_VALUE_FLAGS)
			);
		}
		case "clear":
			return isSessionlessStateClear(commandTokens.slice(2));
		default:
			return false;
	}
}

function isSessionlessPluginCommand(commandTokens: readonly string[]): boolean {
	const subcommand = commandTokens.at(1);
	if (subcommand === undefined) {
		return true;
	}
	return PLUGIN_SESSIONLESS_SUBCOMMANDS.has(subcommand);
}

function isSessionlessSessionCommand(commandTokens: readonly string[]): boolean {
	const [, subcommand, ...rest] = commandTokens;
	if (subcommand === "list" || subcommand === "info") {
		return rest.length === 0;
	}
	if (subcommand === "id") {
		return hasOnlyOptionFlags(rest, JSON_BOOLEAN_FLAGS, SESSION_ID_VALUE_FLAGS);
	}
	return false;
}

function isSessionlessCommand(commandTokens: readonly string[]): boolean {
	const normalizedTokens = stripSessionlessShapeGlobalFlags(commandTokens);
	const command = normalizedTokens.at(0);
	const subcommand = normalizedTokens.at(1);
	switch (command) {
		case undefined:
			return false;
		case "skills":
			return subcommand === undefined || SKILLS_SESSIONLESS_SUBCOMMANDS.has(subcommand);
		case "auth":
			return isSessionlessAuthCommand(normalizedTokens);
		case "plugin":
		case "plugins":
			return isSessionlessPluginCommand(normalizedTokens);
		case "mcp":
			return true;
		case "dashboard":
			return isSessionlessDashboardCommand(normalizedTokens);
		case "device":
			return normalizedTokens.length === 2 && subcommand === "list";
		case "doctor":
			return hasOnlyBooleanFlags(normalizedTokens.slice(1), DOCTOR_BOOLEAN_FLAGS);
		case "install":
			return hasOnlyBooleanFlags(normalizedTokens.slice(1), INSTALL_BOOLEAN_FLAGS);
		case "profiles":
		case "upgrade":
			return normalizedTokens.length === 1;
		case "session":
			return isSessionlessSessionCommand(normalizedTokens);
		case "state":
			return isSessionlessStateCommand(normalizedTokens);
		default:
			return false;
	}
}

export function isBrowserIndependentRead(
	commandTokens: readonly string[],
	stdin?: string,
): boolean {
	if (commandTokens[0] !== "batch") {
		return getExplicitReadUrl(commandTokens) !== undefined;
	}
	const steps = getUpstreamEffectiveBatchSteps(commandTokens, stdin);
	return steps.length > 0 && steps.every((step) => getExplicitReadUrl(step) !== undefined);
}

export function needsManagedSession(descriptor: ArgvDescriptor, stdin?: string): boolean {
	return (
		!isSessionlessCommand(descriptor.upstreamCommandTokens) &&
		!isBrowserIndependentRead(descriptor.upstreamCommandTokens, stdin)
	);
}
