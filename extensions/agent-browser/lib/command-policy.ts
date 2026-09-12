import type { ArgvDescriptor } from "./argv-descriptor.js";
import { hasOnlyBooleanFlags, hasOnlyOptionFlags, isNonFlagToken, stripSessionlessShapeGlobalFlags } from "./argv-grammar.js";
import { getUpstreamEffectiveBatchSteps } from "./orchestration/batch-stdin.js";

const SESSIONLESS_AUTH_SUBCOMMANDS = new Set(["save", "list", "show", "delete", "remove"]);
const PLUGIN_SESSIONLESS_SUBCOMMANDS = new Set(["list", "show", "add", "run"]);
const EMPTY_BOOLEAN_FLAGS = new Set<string>();
const JSON_BOOLEAN_FLAGS = new Set(["--json"]);
const AUTH_SAVE_BOOLEAN_FLAGS = new Set(["--json", "--password-stdin"]);
const AUTH_SAVE_VALUE_FLAGS = new Set(["--password", "--password-selector", "--submit-selector", "--url", "--username", "--username-selector"]);
const DASHBOARD_VALUE_FLAGS = new Set(["--allowed-origins", "--port"]);
const DOCTOR_BOOLEAN_FLAGS = new Set(["--fix", "--headed", "--json", "--offline", "--quick", "--webgpu"]);
const INSTALL_BOOLEAN_FLAGS = new Set(["--with-deps", "-d"]);
const STATE_SESSIONLESS_SUBCOMMANDS = new Set(["list", "show", "clear", "clean", "rename"]);
const STATE_CLEAN_VALUE_FLAGS = new Set(["--older-than"]);
const SESSION_ID_VALUE_FLAGS = new Set(["--scope", "--prefix"]);

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
	if (subcommand === "stop") return rest.length === 0;
	return hasOnlyOptionFlags(subcommand === "start" ? rest : commandTokens.slice(1), JSON_BOOLEAN_FLAGS, DASHBOARD_VALUE_FLAGS);
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

function isSessionlessPluginCommand(commandTokens: readonly string[]): boolean {
	const [, subcommand] = commandTokens;
	if (subcommand === undefined) return true;
	return PLUGIN_SESSIONLESS_SUBCOMMANDS.has(subcommand);
}

function isSessionlessSessionCommand(commandTokens: readonly string[]): boolean {
	const [, subcommand, ...rest] = commandTokens;
	if (subcommand === "list" || subcommand === "info") return rest.length === 0;
	if (subcommand === "id") return hasOnlyOptionFlags(rest, JSON_BOOLEAN_FLAGS, SESSION_ID_VALUE_FLAGS);
	return false;
}

function isSessionlessCommand(commandTokens: readonly string[]): boolean {
	const normalizedTokens = stripSessionlessShapeGlobalFlags(commandTokens);
	const [command, subcommand] = normalizedTokens;
	if (command === "skills") return ["list", "get", "path"].includes(subcommand ?? "");
	if (command === "auth") return isSessionlessAuthCommand(normalizedTokens);
	if (command === "plugin") return isSessionlessPluginCommand(normalizedTokens);
	if (command === "mcp") return true;
	if (command === "dashboard") return isSessionlessDashboardCommand(normalizedTokens);
	if (command === "device") return normalizedTokens.length === 2 && subcommand === "list";
	if (command === "doctor") return hasOnlyBooleanFlags(normalizedTokens.slice(1), DOCTOR_BOOLEAN_FLAGS);
	if (command === "install") return hasOnlyBooleanFlags(normalizedTokens.slice(1), INSTALL_BOOLEAN_FLAGS);
	if (command === "profiles" || command === "upgrade") return normalizedTokens.length === 1;
	if (command === "session") return isSessionlessSessionCommand(normalizedTokens);
	if (command === "state") return isSessionlessStateCommand(normalizedTokens);
	return false;
}

// undefined is a valid DOM read; null is invalid native syntax, which must not trigger page helpers.
export function getExplicitReadUrl(commandTokens: readonly string[]): string | null | undefined {
	if (commandTokens[0] !== "read") return undefined;
	let url: string | undefined;
	let llms = false;
	let outline = false;
	for (let index = 1; index < commandTokens.length; index += 1) {
		const token = commandTokens[index];
		if (["--filter", "--llms", "--timeout"].includes(token)) {
			const value = commandTokens[++index];
			if (value === undefined) return null;
			if (token === "--llms") {
				if (!["index", "full"].includes(value)) return null;
				llms = true;
			}
			if (token === "--timeout" && (!/^\+?\d+$/.test(value) || BigInt(value) === 0n || BigInt(value) > 18446744073709551615n)) return null;
		} else if (["--raw", "--require-md", "--outline", "--json"].includes(token)) {
			if (token === "--outline") outline = true;
		}
		else if (token.startsWith("--") || url !== undefined) return null;
		else url = token;
	}
	return llms && outline ? null : url;
}

export function isBrowserIndependentRead(commandTokens: readonly string[], stdin?: string): boolean {
	if (commandTokens[0] !== "batch") return getExplicitReadUrl(commandTokens) !== undefined;
	const steps = getUpstreamEffectiveBatchSteps(commandTokens, stdin);
	return steps.length > 0 && steps.every((step) => getExplicitReadUrl(step) !== undefined);
}

export function needsManagedSession(descriptor: ArgvDescriptor, stdin?: string): boolean {
	return !isSessionlessCommand(descriptor.upstreamCommandTokens) && !isBrowserIndependentRead(descriptor.upstreamCommandTokens, stdin);
}
