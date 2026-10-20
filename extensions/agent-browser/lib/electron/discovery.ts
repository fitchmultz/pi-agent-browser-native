import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { discoverDarwinApps, inspectDarwinApp } from "./discovery-darwin.js";
import {
	hasLinuxElectronEvidence,
	inspectWin32Executable,
	resolveRealPath,
} from "./discovery-evidence.js";
import { discoverLinuxApps } from "./discovery-linux.js";
import {
	ELECTRON_DISCOVERY_DEFAULT_MAX_RESULTS,
	ELECTRON_DISCOVERY_MAX_RESULTS,
	type DiscoverElectronAppsOptions,
	type ElectronAppDiscovery,
	type ElectronAppSensitivity,
	type ElectronDiscoveryPlatform,
	type ElectronDiscoveryResult,
	type ElectronDiscoveryScanLocations,
	type ResolvedElectronDiscoveryLocations,
} from "./discovery-types.js";

export type {
	DiscoverElectronAppsOptions,
	ElectronAppDiscovery,
	ElectronAppSensitivity,
	ElectronDiscoveryPlatform,
	ElectronDiscoveryResult,
	ElectronDiscoveryScanLocations,
} from "./discovery-types.js";
export { inspectDarwinApp } from "./discovery-darwin.js";
export { hasLinuxElectronEvidence } from "./discovery-evidence.js";
export {
	ELECTRON_DISCOVERY_DEFAULT_MAX_RESULTS,
	ELECTRON_DISCOVERY_MAX_RESULTS,
} from "./discovery-types.js";

const SENSITIVE_APP_PATTERNS = [
	{ category: "notes", patterns: [/\bobsidian\b/i, /\bnotion\b/i, /\blogseq\b/i] },
	{
		category: "chat",
		patterns: [
			/\bslack\b/i,
			/\bdiscord\b/i,
			/\bteams\b/i,
			/\bsignal\b/i,
			/\btelegram\b/i,
			/\bwhatsapp\b/i,
		],
	},
	{
		category: "mail",
		patterns: [
			/\bmail\b/i,
			/\boutlook\b/i,
			/\bthunderbird\b/i,
			/\bspark\b/i,
			/\bproton[- ]?mail\b/i,
		],
	},
	{
		category: "developer-workspace",
		patterns: [
			/\bvisual studio code\b/i,
			/\bvs ?code\b/i,
			/\bcode - insiders\b/i,
			/^code$/i,
			/\bcursor\b/i,
			/\bwindsurf\b/i,
		],
	},
	{
		category: "passwords-auth",
		patterns: [
			/\b1password\b/i,
			/\bbitwarden\b/i,
			/\blastpass\b/i,
			/\bdashlane\b/i,
			/\bauthy\b/i,
			/\bauthenticator\b/i,
			/\bkeepass\b/i,
		],
	},
];
function normalizeSensitivityValue(value: string | undefined): string | undefined {
	const normalized = value
		?.trim()
		.replace(/[_./\\-]+/g, " ")
		.replace(/\s+/g, " ");
	return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
export function getElectronAppSensitivity(
	app: ElectronAppDiscovery,
): ElectronAppSensitivity | undefined {
	const values = [app.name, app.bundleId, app.desktopId, app.appPath, app.executablePath]
		.map(normalizeSensitivityValue)
		.filter((value): value is string => value !== undefined);
	const categories = SENSITIVE_APP_PATTERNS.filter(({ patterns }) =>
		values.some((value) => patterns.some((pattern) => pattern.test(value))),
	).map(({ category }) => category);
	if (categories.length === 0) {
		return undefined;
	}
	return {
		categories: [...new Set(categories)].sort((left, right) => {
			if (left === right) {
				return 0;
			}
			return left < right ? -1 : 1;
		}),
		level: "likely-sensitive",
		reason:
			"App name, bundle id, desktop id, or path matched common private-data app patterns; discovery still does not enforce policy.",
	};
}
function annotateElectronAppSensitivity(app: ElectronAppDiscovery): ElectronAppDiscovery {
	const sensitivity = getElectronAppSensitivity(app);
	return sensitivity ? { ...app, sensitivity } : app;
}
function normalizeMaxResults(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		return ELECTRON_DISCOVERY_DEFAULT_MAX_RESULTS;
	}
	return Math.min(value, ELECTRON_DISCOVERY_MAX_RESULTS);
}
function linuxDesktopDirectories(
	locations: ElectronDiscoveryScanLocations | undefined,
	homeDir: string,
): readonly string[] {
	return (
		locations?.linuxDesktopDirectories ?? [
			join(homeDir, ".local", "share", "applications"),
			"/usr/share/applications",
			"/var/lib/snapd/desktop/applications",
			join(homeDir, ".local", "share", "flatpak", "exports", "share", "applications"),
			"/var/lib/flatpak/exports/share/applications",
		]
	);
}
function resolvePackageLocations(
	locations: ElectronDiscoveryScanLocations | undefined,
	homeDir: string,
): Pick<
	ResolvedElectronDiscoveryLocations,
	| "flatpakSystemAppDirectory"
	| "flatpakUserAppDirectory"
	| "snapBinDirectory"
	| "snapMountDirectory"
> {
	return {
		flatpakSystemAppDirectory: locations?.flatpakSystemAppDirectory ?? "/var/lib/flatpak/app",
		flatpakUserAppDirectory:
			locations?.flatpakUserAppDirectory ?? join(homeDir, ".local", "share", "flatpak", "app"),
		snapBinDirectory: locations?.snapBinDirectory ?? "/snap/bin",
		snapMountDirectory: locations?.snapMountDirectory ?? "/snap",
	};
}
function resolveLocations(
	locations: ElectronDiscoveryScanLocations | undefined,
): ResolvedElectronDiscoveryLocations {
	const homeDir = locations?.homeDir ?? homedir();
	return {
		...resolvePackageLocations(locations, homeDir),
		homeDir,
		darwinApplicationDirectories: locations?.darwinApplicationDirectories ?? [
			"/Applications",
			join(homeDir, "Applications"),
		],
		linuxDesktopDirectories: linuxDesktopDirectories(locations, homeDir),
		pathEnv: locations?.pathEnv ?? process.env.PATH ?? "",
	};
}
function appMatchesQuery(app: ElectronAppDiscovery, query: string | undefined): boolean {
	if (query === undefined || query.length === 0) {
		return true;
	}
	const normalized = query.toLowerCase();
	return [
		app.name,
		app.bundleId,
		app.appPath,
		app.executablePath,
		app.comment,
		app.desktopId,
		app.icon,
		app.packageSource,
	]
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.some((value) => value.toLowerCase().includes(normalized));
}
function dedupeApps(apps: readonly ElectronAppDiscovery[]): ElectronAppDiscovery[] {
	const seen = new Set<string>();
	return apps.filter((app) => {
		const key = app.appPath ?? app.executablePath;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}
function sortApps(apps: readonly ElectronAppDiscovery[]): ElectronAppDiscovery[] {
	return [...apps].sort((left, right) => {
		const comparison = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
		return comparison === 0 ? left.executablePath.localeCompare(right.executablePath) : comparison;
	});
}
function findMacAppBundleAncestor(path: string): string | undefined {
	const parts = resolve(path).split(sep);
	const index = parts.findIndex((part) => part.endsWith(".app"));
	if (index < 0) {
		return undefined;
	}
	const ancestor = parts.slice(0, index + 1).join(sep);
	return ancestor.length > 0 ? ancestor : "/";
}
export async function inspectElectronExecutablePath(
	executablePath: string,
	platform: NodeJS.Platform | ElectronDiscoveryPlatform = process.platform,
): Promise<ElectronAppDiscovery | undefined> {
	const resolved = await resolveRealPath(executablePath);
	if (platform === "darwin") {
		const appPath = findMacAppBundleAncestor(resolved);
		return appPath === undefined ? undefined : inspectDarwinApp(appPath);
	}
	if (platform === "linux") {
		if (!(await hasLinuxElectronEvidence(resolved))) {
			return undefined;
		}
		return { executablePath: resolved, name: basename(resolved), platform: "linux" };
	}
	if (platform === "win32") {
		return inspectWin32Executable(resolved);
	}
	return undefined;
}
export async function inspectElectronAppPath(
	appPath: string,
	platform: NodeJS.Platform | ElectronDiscoveryPlatform = process.platform,
): Promise<ElectronAppDiscovery | undefined> {
	if (platform === "darwin" || appPath.endsWith(".app")) {
		return inspectDarwinApp(appPath);
	}
	return inspectElectronExecutablePath(appPath, platform);
}
export async function discoverElectronApps(
	options: DiscoverElectronAppsOptions = {},
): Promise<ElectronDiscoveryResult> {
	const platform = options.platform ?? process.platform;
	const query = normalizeDiscoveryQuery(options.query);
	const maxResults = normalizeMaxResults(options.maxResults);
	const locations = resolveLocations(options.locations);
	if (platform !== "darwin" && platform !== "linux") {
		return { apps: [], maxResults, omittedCount: 0, platform: "unsupported", query };
	}
	const discovered =
		platform === "darwin"
			? await discoverDarwinApps(locations.darwinApplicationDirectories)
			: await discoverLinuxApps(locations);
	const filtered = sortApps(
		dedupeApps(
			discovered.apps
				.map(annotateElectronAppSensitivity)
				.filter((app) => appMatchesQuery(app, query)),
		),
	);
	const apps = filtered.slice(0, maxResults);
	return {
		apps,
		maxResults,
		omittedCount: Math.max(0, filtered.length - apps.length),
		platform,
		query,
		skippedCount: discovered.skippedCount === 0 ? undefined : discovered.skippedCount,
	};
}
function normalizeDiscoveryQuery(value: string | undefined): string | undefined {
	const query = value?.trim();
	return query === undefined || query.length === 0 ? undefined : query;
}
