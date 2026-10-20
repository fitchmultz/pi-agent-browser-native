import { constants as fsConstants } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { pathExists } from "../fs-utils.js";
import type { ElectronAppDiscovery } from "./discovery-types.js";

export async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}
export async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}
export async function isExecutableFile(path: string): Promise<boolean> {
	try {
		if (!(await stat(path)).isFile()) {
			return false;
		}
		await access(path, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}
export async function resolveRealPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return path;
	}
}
export async function directoryContainsChromePak(directory: string): Promise<boolean> {
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		return entries.some((entry) => entry.isFile() && /^chrome_.*\.pak$/i.test(entry.name));
	} catch {
		return false;
	}
}
export async function hasElectronAppPayload(resourcesDirectory: string): Promise<boolean> {
	return (
		(await pathExists(join(resourcesDirectory, "app.asar"))) ||
		(await pathExists(join(resourcesDirectory, "default_app.asar"))) ||
		(await isDirectory(join(resourcesDirectory, "app")))
	);
}
export async function hasLinuxElectronEvidence(executablePath: string): Promise<boolean> {
	const resolved = await resolveRealPath(executablePath);
	if (!(await isExecutableFile(resolved))) {
		return false;
	}
	const directory = dirname(resolved);
	if (!(await directoryContainsChromePak(directory))) {
		return false;
	}
	for (const base of [directory, dirname(directory)]) {
		// Ordered evidence checks avoid unnecessary filesystem work after the first match.
		// oxlint-disable-next-line no-await-in-loop
		if (await hasElectronAppPayload(join(base, "resources"))) {
			return true;
		}
	}
	return false;
}
export async function inspectWin32Executable(
	executablePath: string,
): Promise<ElectronAppDiscovery | undefined> {
	const resolved = await resolveRealPath(executablePath);
	if (!(await isExecutableFile(resolved))) {
		return undefined;
	}
	const directory = dirname(resolved);
	const hasAppPayload = await hasElectronAppPayload(join(directory, "resources"));
	const hasPak =
		(await directoryContainsChromePak(directory)) ||
		(await pathExists(join(directory, "resources.pak")));
	if (!hasAppPayload || !hasPak) {
		return undefined;
	}
	return {
		executablePath: resolved,
		name: basename(resolved, extname(resolved)),
		platform: "win32",
	};
}
