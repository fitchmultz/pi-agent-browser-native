import {
	GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES,
	VALUE_FLAGS,
	optionalGlobalValueFlagConsumesNext,
	stripUpstreamGlobalFlags,
} from "./argv-grammar.js";
import { isOpenNavigationCommand } from "./command-taxonomy.js";

export interface CommandInfo {
	readonly command?: string;
	readonly commandTokens?: readonly string[];
	readonly subcommand?: string;
}

export interface ArgvDescriptor {
	readonly commandInfo: CommandInfo;
	readonly commandTokens: readonly string[];
	readonly upstreamCommandTokens: readonly string[];
}

export interface WaitCommandShape {
	readonly downloadPath?: string;
	readonly downloadPathIndex?: number;
	readonly subcommand?: string;
}

function isBooleanLiteral(token: string | undefined): boolean {
	const normalized = token?.trim().toLowerCase();
	return normalized === "true" || normalized === "false";
}

function flagConsumesFollowingToken(token: string, nextToken: string | undefined): boolean {
	const normalizedToken = token.split("=", 1).at(0) ?? token;
	if (optionalGlobalValueFlagConsumesNext(normalizedToken, nextToken)) {
		return true;
	}
	if (token.includes("=")) {
		return false;
	}
	return (
		VALUE_FLAGS.has(normalizedToken) ||
		(GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(normalizedToken) && isBooleanLiteral(nextToken))
	);
}

export function findCommandStartIndex(args: readonly string[]): number | undefined {
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (
			token.startsWith("--session=") ||
			token.startsWith("--namespace=") ||
			token.startsWith("--restore=")
		) {
			continue;
		}
		if (token.startsWith("-")) {
			if (flagConsumesFollowingToken(token, args[index + 1])) {
				index += 1;
			}
			continue;
		}
		return index;
	}
	return undefined;
}

export function extractCommandTokens(args: readonly string[]): string[] {
	const commandStartIndex = findCommandStartIndex(args);
	return commandStartIndex === undefined ? [] : args.slice(commandStartIndex);
}

export function extractUpstreamCommandTokens(args: readonly string[]): string[] {
	return stripUpstreamGlobalFlags(extractCommandTokens(args));
}

function waitDownloadShape(
	considered: readonly { readonly token: string; readonly index: number }[],
	downloadIndex: number,
): WaitCommandShape {
	const next = considered.at(downloadIndex + 1);
	const candidate = next?.token.startsWith("--") === false ? next : undefined;
	return {
		downloadPath: candidate?.token,
		downloadPathIndex: candidate?.index,
		subcommand: considered[downloadIndex].token,
	};
}

export function parseWaitCommandTokens(commandTokens: readonly string[]): WaitCommandShape {
	if (commandTokens[0] !== "wait") {
		return {};
	}
	const considered = commandTokens.slice(1).map((token, offset) => ({ index: offset + 1, token }));
	const timeoutIndex = considered.findIndex((entry) => entry.token === "--timeout");
	if (timeoutIndex >= 0) {
		considered.splice(timeoutIndex, Math.min(2, considered.length - timeoutIndex));
	}
	for (const flags of [
		["--url", "-u"],
		["--load", "-l"],
		["--fn", "-f"],
		["--text", "-t"],
	] as const) {
		const match = considered.find((entry) => flags.some((flag) => flag === entry.token));
		if (match) {
			return { subcommand: match.token };
		}
	}
	const downloadIndex = considered.findIndex(
		(entry) => entry.token === "--download" || entry.token === "-d",
	);
	if (downloadIndex >= 0) {
		return waitDownloadShape(considered, downloadIndex);
	}
	return { subcommand: considered[0]?.token };
}

function getOpenCommandTarget(commandTokens: readonly string[]): string | undefined {
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

function getCommandSubcommand(tokens: readonly string[]): string | undefined {
	if (isOpenNavigationCommand(tokens.at(0))) {
		return getOpenCommandTarget(tokens);
	}
	if (tokens.at(0) === "wait") {
		return parseWaitCommandTokens(tokens).subcommand;
	}
	return tokens.at(1);
}

function parseCommandInfoFromTokens(upstreamCommandTokens: readonly string[]): CommandInfo {
	const command = upstreamCommandTokens[0];
	return {
		command,
		subcommand: getCommandSubcommand(upstreamCommandTokens),
	};
}

export function parseCommandInfo(args: readonly string[]): CommandInfo {
	return parseCommandInfoFromTokens(extractUpstreamCommandTokens(args));
}

export function parseArgvDescriptor(args: readonly string[]): ArgvDescriptor {
	const commandTokens = extractCommandTokens(args);
	const upstreamCommandTokens = stripUpstreamGlobalFlags(commandTokens);
	return {
		commandInfo: parseCommandInfoFromTokens(upstreamCommandTokens),
		commandTokens,
		upstreamCommandTokens,
	};
}
