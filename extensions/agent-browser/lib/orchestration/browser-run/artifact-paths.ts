import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { foldAgentBrowserFilesystemIdentity } from "../../argv-grammar.js";
import { parseWaitCommandTokens } from "../../argv-descriptor.js";

const SCREENSHOT_BOOLEAN_FLAGS = new Set(["--annotate", "--full", "-f"]);
const SCREENSHOT_VALUE_FLAGS = new Set(["--screenshot-dir", "--screenshot-format", "--screenshot-quality"]);
const SCREENSHOT_IMAGE_EXTENSIONS = [".jpeg", ".jpg", ".png", ".webp"];

function isSingleScreenshotPathToken(token: string): boolean {
	const explicitlyRelative = token.startsWith("./") || token.startsWith("../");
	if (token.startsWith("#") || token.startsWith("@") || (token.startsWith(".") && !explicitlyRelative && !token.includes("/"))) return false;
	return explicitlyRelative || token.includes("/") || SCREENSHOT_IMAGE_EXTENSIONS.some((extension) => token.endsWith(extension));
}

function getScreenshotPositionalIndices(commandTokens: string[]): number[] {
	if (commandTokens[0] !== "screenshot") return [];
	const positionalIndices: number[] = [];
	for (let index = 1; index < commandTokens.length; index += 1) {
		const token = commandTokens[index];
		if (SCREENSHOT_VALUE_FLAGS.has(token)) {
			index += 1;
			continue;
		}
		if (SCREENSHOT_BOOLEAN_FLAGS.has(token)) continue;
		positionalIndices.push(index);
	}

	return positionalIndices;
}

export function getScreenshotPathTokenIndex(commandTokens: string[]): number | undefined {
	const positionalIndices = getScreenshotPositionalIndices(commandTokens);
	if (positionalIndices.length === 0) return undefined;
	const candidateIndex = positionalIndices.length >= 2 ? positionalIndices[1] : positionalIndices[0];
	const candidate = commandTokens[candidateIndex];
	if (positionalIndices.length >= 2 || isSingleScreenshotPathToken(candidate)) {
		return candidateIndex;
	}
	return undefined;
}

const DIFF_SCREENSHOT_VALUE_FLAGS = new Set(["-b", "--baseline", "-o", "--output", "-s", "--selector", "-t", "--threshold"]);

function getDiffScreenshotOutputPath(commandTokens: string[]): string | undefined {
	let outputPath: string | undefined;
	for (let index = 2; index < commandTokens.length; index += 1) {
		const token = commandTokens[index];
		if (!DIFF_SCREENSHOT_VALUE_FLAGS.has(token)) continue;
		const value = commandTokens[index + 1];
		if (value === undefined) return undefined;
		if (token === "-o" || token === "--output") outputPath = value;
		index += 1;
	}
	return outputPath;
}

function foldArtifactPath(path: string, platform: NodeJS.Platform): string {
	return foldAgentBrowserFilesystemIdentity(path, platform);
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
	if (command === "wait") return parseWaitCommandTokens(commandTokens).downloadPath;
	if (command === "state" && subcommand === "save") return commandTokens[2];
	if (command === "diff" && subcommand === "screenshot") return getDiffScreenshotOutputPath(commandTokens);
	if (command === "network" && subcommand === "har" && commandTokens[2] === "stop") return commandTokens[3];
	if ((command === "trace" || command === "profiler") && subcommand === "stop") return commandTokens[2];
	if (command === "record" && (subcommand === "start" || subcommand === "restart")) return commandTokens[2];
	return undefined;
}
