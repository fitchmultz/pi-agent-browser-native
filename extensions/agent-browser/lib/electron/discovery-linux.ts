import { readdir, readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { parseDesktopFile, stripEnvLauncher, tokenizeDesktopExec } from "./discovery-desktop.js";
import { hasLinuxElectronEvidence, resolveRealPath } from "./discovery-evidence.js";
import {
	findExecutableInPath,
	pathIsWithin,
	resolveFlatpakExecutable,
	resolveSnapExecutable,
} from "./discovery-packages.js";
import type {
	ElectronAppDiscovery,
	ElectronDiscoveryScan,
	LinuxDesktopEntry,
	ResolvedElectronDiscoveryLocations,
} from "./discovery-types.js";

interface LinuxExecutableResolution {
	readonly executablePath: string;
	readonly packageSource: "desktop" | "flatpak" | "snap";
}
async function resolveLinuxExecutable(
	entry: LinuxDesktopEntry,
	locations: ResolvedElectronDiscoveryLocations,
): Promise<LinuxExecutableResolution | undefined> {
	const tokens = stripEnvLauncher(tokenizeDesktopExec(entry.exec));
	const token = tokens.at(0);
	if (token === undefined || token.length === 0) {
		return undefined;
	}
	if (basename(token) === "flatpak") {
		const path = await resolveFlatpakExecutable(tokens, entry, locations);
		return path === undefined ? undefined : { executablePath: path, packageSource: "flatpak" };
	}
	const executablePath = isAbsolute(token)
		? token
		: await findExecutableInPath(token, locations.pathEnv);
	if (executablePath === undefined) {
		return undefined;
	}
	if (pathIsWithin(executablePath, locations.snapBinDirectory)) {
		const path = await resolveSnapExecutable(executablePath, entry, locations);
		return path === undefined ? undefined : { executablePath: path, packageSource: "snap" };
	}
	return { executablePath: await resolveRealPath(executablePath), packageSource: "desktop" };
}
async function inspectLinuxDesktopFile(
	filePath: string,
	locations: ResolvedElectronDiscoveryLocations,
): Promise<ElectronAppDiscovery | undefined> {
	let text;
	try {
		text = await readFile(filePath, "utf8");
	} catch {
		return undefined;
	}
	const entry = parseDesktopFile(text, filePath);
	if (!entry) {
		return undefined;
	}
	const resolution = await resolveLinuxExecutable(entry, locations);
	if (!resolution || !(await hasLinuxElectronEvidence(resolution.executablePath))) {
		return undefined;
	}
	return {
		comment: entry.comment,
		desktopId: entry.desktopId,
		executablePath: resolution.executablePath,
		icon: entry.icon,
		name: entry.name,
		packageSource: resolution.packageSource,
		platform: "linux",
	};
}
async function inspectDirectory(
	directory: string,
	locations: ResolvedElectronDiscoveryLocations,
): Promise<ElectronDiscoveryScan> {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return { apps: [], skippedCount: 0 };
	}
	const apps: ElectronAppDiscovery[] = [];
	let skippedCount = 0;
	for (const entry of entries) {
		if (!entry.isFile() || extname(entry.name) !== ".desktop") {
			continue;
		}
		try {
			// Preserve desktop-file priority and bound concurrent package scans to one.
			const app = await inspectLinuxDesktopFile(join(directory, entry.name), locations);
			if (app) {
				apps.push(app);
			}
		} catch {
			skippedCount += 1;
		}
	}
	return { apps, skippedCount };
}
export async function discoverLinuxApps(
	locations: ResolvedElectronDiscoveryLocations,
): Promise<ElectronDiscoveryScan> {
	const apps: ElectronAppDiscovery[] = [];
	let skippedCount = 0;
	for (const directory of locations.linuxDesktopDirectories) {
		// Location order determines which duplicate desktop entry is retained.
		const scan = await inspectDirectory(directory, locations);
		apps.push(...scan.apps);
		skippedCount += scan.skippedCount;
	}
	return { apps, skippedCount };
}
