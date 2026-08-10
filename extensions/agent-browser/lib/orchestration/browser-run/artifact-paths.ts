import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import { GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES, VALUE_FLAGS } from "../../argv-grammar.js";

const SCREENSHOT_BOOLEAN_FLAGS = new Set(["--annotate", "--full", "-f"]);
const SCREENSHOT_VALUE_FLAGS = new Set(["--screenshot-dir", "--screenshot-format", "--screenshot-quality"]);
const SCREENSHOT_IMAGE_EXTENSIONS = new Set([".jpeg", ".jpg", ".png", ".webp"]);

function isImagePathToken(token: string): boolean {
	const extension = extname(token).toLowerCase();
	return SCREENSHOT_IMAGE_EXTENSIONS.has(extension);
}

function getScreenshotPositionalIndices(commandTokens: string[]): number[] {
	if (commandTokens[0] !== "screenshot") return [];
	const positionalIndices: number[] = [];
	for (let index = 1; index < commandTokens.length; index += 1) {
		const token = commandTokens[index];
		if (token === "--") {
			for (let positionalIndex = index + 1; positionalIndex < commandTokens.length; positionalIndex += 1) {
				positionalIndices.push(positionalIndex);
			}
			break;
		}
		if (token.startsWith("-")) {
			const normalizedToken = token.split("=", 1)[0] ?? token;
			if ((SCREENSHOT_VALUE_FLAGS.has(normalizedToken) || VALUE_FLAGS.has(normalizedToken)) && !token.includes("=")) {
				index += 1;
				continue;
			}
			if (SCREENSHOT_BOOLEAN_FLAGS.has(normalizedToken) || GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(normalizedToken)) {
				if (["true", "false"].includes(commandTokens[index + 1] ?? "")) index += 1;
				continue;
			}
		}
		positionalIndices.push(index);
	}

	return positionalIndices;
}

export function getPotentialScreenshotPathToken(commandTokens: string[]): string | undefined {
	const positionalIndices = getScreenshotPositionalIndices(commandTokens);
	return positionalIndices.length > 0 ? commandTokens[positionalIndices[positionalIndices.length - 1]] : undefined;
}

export function getScreenshotPathTokenIndex(commandTokens: string[]): number | undefined {
	const positionalIndices = getScreenshotPositionalIndices(commandTokens);
	if (positionalIndices.length === 0) return undefined;
	const candidateIndex = positionalIndices[positionalIndices.length - 1];
	const candidate = commandTokens[candidateIndex];
	if (positionalIndices.length >= 2 || isImagePathToken(candidate) || isAbsolute(candidate) || candidate.startsWith("./") || candidate.startsWith("../")) {
		return candidateIndex;
	}
	return undefined;
}

function getFlagValue(commandTokens: string[], flag: string): string | undefined {
	const equalsPrefix = `${flag}=`;
	for (let index = commandTokens.length - 1; index >= 0; index -= 1) {
		const token = commandTokens[index];
		if (token.startsWith(equalsPrefix)) return token.slice(equalsPrefix.length) || undefined;
		if (token === flag) return commandTokens[index + 1];
	}
	return undefined;
}

function foldArtifactPath(path: string, platform: NodeJS.Platform): string {
	return platform === "win32" || platform === "darwin" ? path.normalize("NFC").toLowerCase() : path;
}

function canonicalizeArtifactPath(absolutePath: string, platform: NodeJS.Platform, seenSymlinks: Set<string>): string {
	let cursor = absolutePath;
	const suffix: string[] = [];
	while (true) {
		try {
			const canonicalPath = join(realpathSync.native(cursor), ...suffix);
			try {
				const stats = statSync(canonicalPath, { bigint: true });
				if (stats.ino > 0n) return `inode:${stats.dev}:${stats.ino}`;
			} catch {
				// The destination does not exist yet; canonical ancestry still catches aliases.
			}
			return foldArtifactPath(canonicalPath, platform);
		} catch {
			let symlinkTarget: string | undefined;
			try {
				if (lstatSync(cursor).isSymbolicLink()) symlinkTarget = resolve(dirname(cursor), readlinkSync(cursor));
			} catch {}
			if (symlinkTarget) {
				if (seenSymlinks.has(cursor)) throw new Error(`Artifact destination contains a symlink loop: ${absolutePath}`);
				if (seenSymlinks.size >= 32) throw new Error(`Artifact destination has too many symlink hops: ${absolutePath}`);
				seenSymlinks.add(cursor);
				return canonicalizeArtifactPath(join(symlinkTarget, ...suffix), platform, seenSymlinks);
			}
			const parent = dirname(cursor);
			if (parent === cursor) return foldArtifactPath(absolutePath, platform);
			suffix.unshift(basename(cursor));
			cursor = parent;
		}
	}
}

export function canonicalizeExplicitArtifactDestination(cwd: string, destination: string, platform: NodeJS.Platform = process.platform): string {
	return canonicalizeArtifactPath(resolve(cwd, destination), platform, new Set());
}

export function getExplicitArtifactDestination(commandTokens: string[]): string | undefined {
	const command = commandTokens[0];
	const subcommand = commandTokens[1];
	if (command === "screenshot") {
		const index = getScreenshotPathTokenIndex(commandTokens);
		return index === undefined ? undefined : commandTokens[index];
	}
	if (command === "download") return commandTokens[2];
	if (command === "pdf") return commandTokens[1];
	if (command === "wait" && subcommand === "--download" && commandTokens[2] && !commandTokens[2].startsWith("--")) return commandTokens[2];
	if (command === "wait" && subcommand?.startsWith("--download=")) return subcommand.slice("--download=".length) || undefined;
	if (command === "state" && subcommand === "save") return commandTokens[2];
	if (command === "diff" && subcommand === "screenshot") return getFlagValue(commandTokens, "--output");
	if (command === "network" && subcommand === "har" && commandTokens[2] === "stop") return commandTokens[3];
	if ((command === "trace" || command === "profiler") && subcommand === "stop") return commandTokens[2];
	if (command === "record" && (subcommand === "start" || subcommand === "restart")) return commandTokens[2];
	return undefined;
}
