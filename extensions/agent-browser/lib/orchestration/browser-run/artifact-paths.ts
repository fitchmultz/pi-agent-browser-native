import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

import {
	beforeEndOfOptions,
	foldAgentBrowserFilesystemIdentity,
	scanCommandPositionals,
	type IndexedArgvToken,
} from "../../argv-grammar.js";
import { parseWaitCommandTokens } from "../../argv-descriptor.js";
import {
	getRecordCommandOperandIndices,
	getRecordCommandOperands,
} from "../../command-taxonomy.js";

const SCREENSHOT_IMAGE_EXTENSIONS = [".jpeg", ".jpg", ".png", ".webp"];
const SCREENSHOT_BOOLEAN_FLAGS = new Set(["--full", "-f", "--if-changed"]);
const SCREENSHOT_VALUE_FLAGS = new Set(["--threshold"]);

function isSingleScreenshotPathToken(token: string): boolean {
	const explicitlyRelative = token.startsWith("./") || token.startsWith("../");
	if (
		token.startsWith("#") ||
		token.startsWith("@") ||
		(token.startsWith(".") && !explicitlyRelative && !token.includes("/"))
	) {
		return false;
	}
	return (
		explicitlyRelative ||
		token.includes("/") ||
		SCREENSHOT_IMAGE_EXTENSIONS.some((extension) => token.endsWith(extension))
	);
}

export function getScreenshotOperands(commandTokens: readonly string[]): IndexedArgvToken[] {
	if (commandTokens[0] !== "screenshot") {
		return [];
	}
	return scanCommandPositionals(commandTokens, 1, {
		booleanFlags: SCREENSHOT_BOOLEAN_FLAGS,
		valueFlags: SCREENSHOT_VALUE_FLAGS,
	});
}

export function getScreenshotPathOperand(
	commandTokens: readonly string[],
): IndexedArgvToken | undefined {
	const [first, second] = getScreenshotOperands(commandTokens);
	if (second !== undefined) {
		return second;
	}
	return first !== undefined && isSingleScreenshotPathToken(first.token) ? first : undefined;
}

const DIFF_SCREENSHOT_VALUE_FLAGS = new Set([
	"-b",
	"--baseline",
	"-o",
	"--output",
	"-s",
	"--selector",
	"-t",
	"--threshold",
]);

export function getDiffFilePathIndices(commandTokens: readonly string[]): {
	baseline?: number;
	output?: number;
} {
	const [command, subcommand] = commandTokens;
	if (command !== "diff" || (subcommand !== "snapshot" && subcommand !== "screenshot")) {
		return {};
	}
	const valueFlags =
		subcommand === "screenshot"
			? DIFF_SCREENSHOT_VALUE_FLAGS
			: new Set(["-b", "--baseline", "-s", "--selector", "-d", "--depth"]);
	const paths: { baseline?: number; output?: number } = {};
	const entries = commandTokens.entries();
	entries.next();
	entries.next();
	for (const [, token] of entries) {
		if (!valueFlags.has(token)) {
			continue;
		}
		const value = entries.next().value;
		if (value === undefined) {
			return {};
		}
		if (["-o", "--output"].includes(token)) {
			paths.output = value[0];
		}
		if (["-b", "--baseline"].includes(token)) {
			paths.baseline = value[0];
		}
	}
	return paths;
}

function canonicalFileIdentity(path: string, platform: NodeJS.Platform): string {
	try {
		const stats = statSync(path, { bigint: true });
		if (stats.ino > 0n) {
			return `inode:${stats.dev}:${stats.ino}`;
		}
	} catch {
		// The destination does not exist yet; canonical ancestry still catches aliases.
	}
	return foldAgentBrowserFilesystemIdentity(path, platform);
}

function readSymlinkTarget(path: string): string | undefined {
	try {
		return lstatSync(path).isSymbolicLink()
			? resolve(dirname(path), readlinkSync(path))
			: undefined;
	} catch {
		// Missing ancestry is resolved by walking to the next existing parent.
		return undefined;
	}
}

function canonicalizeArtifactPath(
	absolutePath: string,
	platform: NodeJS.Platform,
	seenSymlinks: ReadonlySet<string>,
): string {
	let cursor = absolutePath;
	const suffix: string[] = [];
	while (true) {
		try {
			const canonicalPath = join(realpathSync.native(cursor), ...suffix);
			return canonicalFileIdentity(canonicalPath, platform);
		} catch {
			// Resolve missing destinations through their existing ancestry below.
		}
		const symlinkTarget = readSymlinkTarget(cursor);
		if (symlinkTarget !== undefined && symlinkTarget !== "") {
			if (seenSymlinks.has(cursor)) {
				throw new Error(`Artifact destination contains a symlink loop: ${absolutePath}`);
			}
			if (seenSymlinks.size >= 32) {
				throw new Error(`Artifact destination has too many symlink hops: ${absolutePath}`);
			}
			return canonicalizeArtifactPath(
				join(symlinkTarget, ...suffix),
				platform,
				new Set([...seenSymlinks, cursor]),
			);
		}
		const parent = dirname(cursor);
		if (parent === cursor) {
			return foldAgentBrowserFilesystemIdentity(absolutePath, platform);
		}
		suffix.unshift(basename(cursor));
		cursor = parent;
	}
}

export function canonicalizeExplicitArtifactDestination(
	cwd: string,
	destination: string,
	platform: NodeJS.Platform = process.platform,
): string {
	return canonicalizeArtifactPath(resolve(cwd, destination), platform, new Set());
}

export function getRecordContactSheetDestination(
	commandTokens: readonly string[],
): string | undefined {
	const path = getRecordCommandOperands(commandTokens).path;
	if (
		path === undefined ||
		path === "" ||
		!beforeEndOfOptions(commandTokens.slice(2)).some(
			(token) => token === "--contact-sheet" || token === "--contact-sheet-threshold",
		)
	) {
		return undefined;
	}
	const extension = extname(path);
	return extension !== "" ? `${path.slice(0, -extension.length)}.contact-sheet.png` : undefined;
}

export function getStateLoadPathIndex(commandTokens: readonly string[]): number | undefined {
	return commandTokens[0] === "state" && commandTokens[1] === "load"
		? scanCommandPositionals(commandTokens, 2)[0]?.index
		: undefined;
}

function getCompoundArtifactDestinationIndex(commandTokens: readonly string[]): number | undefined {
	const [command, subcommand] = commandTokens;
	switch (command) {
		case "state":
			return subcommand === "save" ? scanCommandPositionals(commandTokens, 2)[0]?.index : undefined;
		case "diff":
			return subcommand === "screenshot" ? getDiffFilePathIndices(commandTokens).output : undefined;
		case "network":
			return subcommand === "har" && commandTokens[2] === "stop"
				? scanCommandPositionals(commandTokens, 3)[0]?.index
				: undefined;
		case "trace":
		case "profiler":
			return subcommand === "stop" ? scanCommandPositionals(commandTokens, 2)[0]?.index : undefined;
		case undefined:
		default:
			return undefined;
	}
}

export function getExplicitArtifactDestinationIndex(
	commandTokens: readonly string[],
): number | undefined {
	const command = commandTokens[0];
	if (command === "screenshot") {
		return getScreenshotPathOperand(commandTokens)?.index;
	}
	if (command === "download") {
		return scanCommandPositionals(commandTokens, 1)[1]?.index;
	}
	if (command === "pdf") {
		return scanCommandPositionals(commandTokens, 1)[0]?.index;
	}
	if (command === "wait") {
		return parseWaitCommandTokens(commandTokens).downloadPathIndex;
	}
	if (command === "record") {
		return getRecordCommandOperandIndices(commandTokens)[0];
	}
	return getCompoundArtifactDestinationIndex(commandTokens);
}

export function getExplicitArtifactDestination(
	commandTokens: readonly string[],
): string | undefined {
	const index = getExplicitArtifactDestinationIndex(commandTokens);
	return index === undefined ? undefined : commandTokens[index];
}
