import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
	hasLinuxElectronEvidence,
	isDirectory,
	isFile,
	resolveRealPath,
} from "./discovery-evidence.js";
import type { LinuxDesktopEntry, ResolvedElectronDiscoveryLocations } from "./discovery-types.js";

const MAX_DEPTH = 7;
const MAX_ENTRIES = 5_000;
const NON_EXECUTABLE_EXTENSIONS = new Set([
	".asar",
	".dat",
	".desktop",
	".json",
	".md",
	".pak",
	".png",
	".so",
	".txt",
]);

export function pathIsWithin(path: string, parent: string): boolean {
	const relativePath = relative(resolve(parent), resolve(path));
	return relativePath.length === 0 || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
export async function findExecutableInPath(
	command: string,
	pathEnv: string,
): Promise<string | undefined> {
	if (command.includes("/")) {
		return undefined;
	}
	for (const directory of pathEnv.split(":")) {
		if (directory.length === 0) {
			continue;
		}
		const candidate = join(directory, command);
		// PATH priority requires returning the first present file, not the fastest stat.
		if (await isFile(candidate)) {
			return candidate;
		}
	}
	return undefined;
}
class ElectronBinarySearch {
	private readonly preferredNames: ReadonlySet<string>;
	private readonly candidates: string[] = [];
	private visitedEntries = 0;

	constructor(preferredNames: readonly string[]) {
		this.preferredNames = new Set(preferredNames.filter((name) => name.length > 0));
	}
	async find(root: string): Promise<string | undefined> {
		if (!(await isDirectory(root))) {
			return undefined;
		}
		const preferred = await this.visit(root, 0);
		if (preferred !== undefined) {
			return preferred;
		}
		for (const candidate of this.candidates) {
			// Keep DFS candidate order and stop at the first verified fallback executable.
			if (await hasLinuxElectronEvidence(candidate)) {
				return resolveRealPath(candidate);
			}
		}
		return undefined;
	}
	private async visit(directory: string, depth: number): Promise<string | undefined> {
		if (depth > MAX_DEPTH || this.visitedEntries >= MAX_ENTRIES) {
			return undefined;
		}
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return undefined;
		}
		for (const entry of entries) {
			this.visitedEntries += 1;
			if (this.visitedEntries > MAX_ENTRIES) {
				return undefined;
			}
			// The shared entry budget and preferred-match DFS ordering require serialized traversal.
			const found = await this.inspectEntry(directory, entry, depth);
			if (found !== undefined) {
				return found;
			}
		}
		return undefined;
	}
	private async inspectEntry(
		directory: string,
		entry: Dirent,
		depth: number,
	): Promise<string | undefined> {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			return this.visit(path, depth + 1);
		}
		if (!entry.isFile() || NON_EXECUTABLE_EXTENSIONS.has(extname(path).toLowerCase())) {
			return undefined;
		}
		if (this.preferredNames.has(entry.name) && (await hasLinuxElectronEvidence(path))) {
			return resolveRealPath(path);
		}
		this.candidates.push(path);
		return undefined;
	}
}
export async function resolveSnapExecutable(
	commandPath: string,
	entry: LinuxDesktopEntry,
	locations: ResolvedElectronDiscoveryLocations,
): Promise<string | undefined> {
	const commandName = basename(commandPath);
	const names = [commandName, commandName.split(".")[0] ?? "", entry.desktopId.split(".")[0] ?? ""];
	for (const snapName of new Set(names.filter((name) => name.length > 0))) {
		const root = join(locations.snapMountDirectory, snapName, "current");
		// Native package name priority determines which executable wins.
		const candidate = await new ElectronBinarySearch([
			commandName,
			commandName.split(".").at(-1) ?? commandName,
		]).find(root);
		if (candidate !== undefined) {
			return candidate;
		}
	}
	return undefined;
}
function getFlatpakAppId(tokens: readonly string[], desktopId: string): string {
	return (
		tokens.findLast(
			(token) => !token.startsWith("-") && token.includes(".") && token !== "flatpak",
		) ?? desktopId
	);
}
function getFlatpakCommandName(tokens: readonly string[]): string | undefined {
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] ?? "";
		if (token.startsWith("--command=")) {
			return token.slice("--command=".length);
		}
		if (token === "--command") {
			return tokens[index + 1];
		}
	}
	return undefined;
}
function getFlatpakRoots(
	entry: LinuxDesktopEntry,
	locations: ResolvedElectronDiscoveryLocations,
): readonly string[] {
	const userExport = join(
		locations.homeDir,
		".local",
		"share",
		"flatpak",
		"exports",
		"share",
		"applications",
	);
	if (pathIsWithin(entry.filePath, userExport)) {
		return [locations.flatpakUserAppDirectory, locations.flatpakSystemAppDirectory];
	}
	if (pathIsWithin(entry.filePath, "/var/lib/flatpak/exports/share/applications")) {
		return [locations.flatpakSystemAppDirectory, locations.flatpakUserAppDirectory];
	}
	return [locations.flatpakUserAppDirectory, locations.flatpakSystemAppDirectory];
}
export async function resolveFlatpakExecutable(
	tokens: readonly string[],
	entry: LinuxDesktopEntry,
	locations: ResolvedElectronDiscoveryLocations,
): Promise<string | undefined> {
	const appId = getFlatpakAppId(tokens, entry.desktopId);
	const commandName = getFlatpakCommandName(tokens);
	for (const root of getFlatpakRoots(entry, locations)) {
		// Preserve user/system installation priority; each root has its own bounded scan.
		const candidate = await new ElectronBinarySearch(
			commandName === undefined ? [] : [commandName],
		).find(join(root, appId, "current", "active", "files"));
		if (candidate !== undefined) {
			return candidate;
		}
	}
	return undefined;
}
