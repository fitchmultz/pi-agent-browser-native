import { GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES, VALUE_FLAGS, optionalGlobalValueFlagConsumesNext, stripUpstreamGlobalFlags } from "./argv-grammar.js";
import { isOpenNavigationCommand } from "./command-taxonomy.js";

export interface CommandInfo {
	command?: string;
	commandTokens?: string[];
	subcommand?: string;
}

export interface ArgvDescriptor {
	commandInfo: CommandInfo;
	commandTokens: string[];
	upstreamCommandTokens: string[];
}

export interface WaitCommandShape {
	downloadPath?: string;
	downloadPathIndex?: number;
	subcommand?: string;
}

function isBooleanLiteral(token: string | undefined): boolean {
	const normalized = token?.trim().toLowerCase();
	return normalized === "true" || normalized === "false";
}

export function findCommandStartIndex(args: string[]): number | undefined {
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token.startsWith("--session=") || token.startsWith("--namespace=") || token.startsWith("--restore=")) {
			continue;
		}
		if (token.startsWith("-")) {
			const normalizedToken = token.split("=", 1)[0] ?? token;
			if (optionalGlobalValueFlagConsumesNext(normalizedToken, args[index + 1])) {
				index += 1;
			} else if (VALUE_FLAGS.has(normalizedToken) && !token.includes("=")) {
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

export function extractUpstreamCommandTokens(args: string[]): string[] {
	return stripUpstreamGlobalFlags(extractCommandTokens(args));
}

export function parseWaitCommandTokens(commandTokens: string[]): WaitCommandShape {
	if (commandTokens[0] !== "wait") return {};
	const considered = commandTokens.slice(1).map((token, offset) => ({ index: offset + 1, token }));
	const timeoutIndex = considered.findIndex((entry) => entry.token === "--timeout");
	if (timeoutIndex >= 0) considered.splice(timeoutIndex, Math.min(2, considered.length - timeoutIndex));
	for (const flags of [["--url", "-u"], ["--load", "-l"], ["--fn", "-f"], ["--text", "-t"]] as const) {
		const match = considered.find((entry) => (flags as readonly string[]).includes(entry.token));
		if (match) return { subcommand: match.token };
	}
	const download = considered.find((entry) => entry.token === "--download" || entry.token === "-d");
	if (download) {
		const downloadPathIndex = download.index + 1;
		const candidate = commandTokens[downloadPathIndex];
		return {
			downloadPath: candidate && !candidate.startsWith("--") ? candidate : undefined,
			downloadPathIndex: candidate && !candidate.startsWith("--") ? downloadPathIndex : undefined,
			subcommand: download.token,
		};
	}
	return { subcommand: considered[0]?.token };
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
	const upstreamCommandTokens = stripUpstreamGlobalFlags(commandTokens);
	const command = upstreamCommandTokens[0];
	return {
		command,
		subcommand: isOpenNavigationCommand(command)
			? getOpenCommandTarget(upstreamCommandTokens)
			: command === "wait" ? parseWaitCommandTokens(upstreamCommandTokens).subcommand : upstreamCommandTokens[1],
	};
}

export function parseCommandInfo(args: string[]): CommandInfo {
	return parseCommandInfoFromTokens(extractCommandTokens(args));
}

export function parseArgvDescriptor(args: string[]): ArgvDescriptor {
	const commandTokens = extractCommandTokens(args);
	const upstreamCommandTokens = stripUpstreamGlobalFlags(commandTokens);
	return {
		commandInfo: parseCommandInfoFromTokens(commandTokens),
		commandTokens,
		upstreamCommandTokens,
	};
}
