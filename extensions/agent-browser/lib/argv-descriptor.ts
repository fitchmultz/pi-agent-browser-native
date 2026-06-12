/**
 * Purpose: Parse raw agent-browser argv once into a stable command descriptor for planners and policy.
 * Responsibilities: Own command-token extraction, command/subcommand identification, and descriptor construction.
 * Scope: Pure argv parsing; runtime planning and session policy consume descriptors instead of re-parsing tokens.
 */

import { GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES, VALUE_FLAGS } from "./argv-grammar.js";
import { isOpenNavigationCommand } from "./command-taxonomy.js";

export interface CommandInfo {
	command?: string;
	commandTokens?: string[];
	subcommand?: string;
}

export interface ArgvDescriptor {
	commandInfo: CommandInfo;
	commandTokens: string[];
}

function isBooleanLiteral(token: string | undefined): boolean {
	const normalized = token?.trim().toLowerCase();
	return normalized === "true" || normalized === "false";
}

export function findCommandStartIndex(args: string[]): number | undefined {
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token.startsWith("--session=")) {
			continue;
		}
		if (token.startsWith("-")) {
			const normalizedToken = token.split("=", 1)[0] ?? token;
			if (VALUE_FLAGS.has(normalizedToken) && !token.includes("=")) {
				index += 1;
			} else if (
				GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(normalizedToken) &&
				!token.includes("=") &&
				isBooleanLiteral(args[index + 1])
			) {
				index += 1;
			}
			continue;
		}
		return index;
	}
	return undefined;
}

export function extractCommandTokens(args: string[]): string[] {
	const commandStartIndex = findCommandStartIndex(args);
	return commandStartIndex === undefined ? [] : args.slice(commandStartIndex);
}

function getOpenCommandTarget(commandTokens: string[]): string | undefined {
	for (let index = 1; index < commandTokens.length; index += 1) {
		const token = commandTokens[index];
		if (token === "--init-script" || token === "--enable") {
			index += 1;
			continue;
		}
		if (token.startsWith("--init-script=") || token.startsWith("--enable=")) {
			continue;
		}
		if (token.startsWith("-")) {
			continue;
		}
		return token;
	}
	return undefined;
}

export function parseCommandInfoFromTokens(commandTokens: string[]): CommandInfo {
	const command = commandTokens[0];
	return {
		command,
		subcommand: isOpenNavigationCommand(command) ? getOpenCommandTarget(commandTokens) : commandTokens[1],
	};
}

export function parseCommandInfo(args: string[]): CommandInfo {
	return parseCommandInfoFromTokens(extractCommandTokens(args));
}

export function parseArgvDescriptor(args: string[]): ArgvDescriptor {
	const commandTokens = extractCommandTokens(args);
	return {
		commandInfo: parseCommandInfoFromTokens(commandTokens),
		commandTokens,
	};
}
