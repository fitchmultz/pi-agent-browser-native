import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathExists } from "../fs-utils.js";
import { hasElectronAppPayload, isDirectory } from "./discovery-evidence.js";
import type { ElectronAppDiscovery, ElectronDiscoveryScan } from "./discovery-types.js";

function readPlistString(plist: string, key: string): string | undefined {
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(
		`<key>\\s*${escapedKey}\\s*</key>\\s*<string>([\\s\\S]*?)</string>`,
		"i",
	).exec(plist);
	return match?.[1]
		?.trim()
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'");
}
async function readMacInfoPlist(appPath: string): Promise<Readonly<Record<string, string>>> {
	try {
		const plist = await readFile(join(appPath, "Contents", "Info.plist"), "utf8");
		return {
			CFBundleDisplayName: readPlistString(plist, "CFBundleDisplayName") ?? "",
			CFBundleExecutable: readPlistString(plist, "CFBundleExecutable") ?? "",
			CFBundleIdentifier: readPlistString(plist, "CFBundleIdentifier") ?? "",
			CFBundleName: readPlistString(plist, "CFBundleName") ?? "",
		};
	} catch {
		return {};
	}
}
async function resolveMacExecutablePath(
	appPath: string,
	executableName: string | undefined,
	fallbackName: string,
): Promise<string | undefined> {
	const directory = join(appPath, "Contents", "MacOS");
	if (executableName !== undefined && executableName.trim().length > 0) {
		const path = join(directory, executableName);
		return (await pathExists(path)) ? path : undefined;
	}
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		const candidate =
			entries.find((entry) => entry.isFile() && entry.name === fallbackName) ??
			entries.find((entry) => entry.isFile());
		return candidate ? join(directory, candidate.name) : undefined;
	} catch {
		return undefined;
	}
}
function firstNonempty(values: readonly (string | undefined)[]): string | undefined {
	return values.find((value) => value !== undefined && value.length > 0);
}
export async function inspectDarwinApp(appPath: string): Promise<ElectronAppDiscovery | undefined> {
	const framework = join(appPath, "Contents", "Frameworks", "Electron Framework.framework");
	if (!(await isDirectory(framework))) {
		return undefined;
	}
	if (!(await hasElectronAppPayload(join(appPath, "Contents", "Resources")))) {
		return undefined;
	}
	const info = await readMacInfoPlist(appPath);
	const directoryName = basename(appPath, ".app");
	const executablePath = await resolveMacExecutablePath(
		appPath,
		info.CFBundleExecutable,
		directoryName,
	);
	if (executablePath === undefined) {
		return undefined;
	}
	return {
		appPath,
		bundleId: firstNonempty([info.CFBundleIdentifier]),
		executablePath,
		name: firstNonempty([info.CFBundleDisplayName, info.CFBundleName]) ?? directoryName,
		platform: "darwin",
	};
}
async function inspectDirectory(directory: string): Promise<ElectronDiscoveryScan> {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return { apps: [], skippedCount: 0 };
	}
	const apps: ElectronAppDiscovery[] = [];
	let skippedCount = 0;
	for (const entry of entries) {
		if (!entry.name.endsWith(".app")) {
			continue;
		}
		try {
			// Inspect in filesystem order and count failures without overlapping app reads.
			// oxlint-disable-next-line no-await-in-loop
			const app = await inspectDarwinApp(join(directory, entry.name));
			if (app) {
				apps.push(app);
			}
		} catch {
			skippedCount += 1;
		}
	}
	return { apps, skippedCount };
}
export async function discoverDarwinApps(
	directories: readonly string[],
): Promise<ElectronDiscoveryScan> {
	const apps: ElectronAppDiscovery[] = [];
	let skippedCount = 0;
	for (const directory of directories) {
		// Location priority is observable when duplicate bundles are discovered.
		// oxlint-disable-next-line no-await-in-loop
		const scan = await inspectDirectory(directory);
		apps.push(...scan.apps);
		skippedCount += scan.skippedCount;
	}
	return { apps, skippedCount };
}
