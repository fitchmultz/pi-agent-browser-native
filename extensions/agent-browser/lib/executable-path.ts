import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * First PATH/PATHEXT candidate for `command` as an existing regular file, or
 * `undefined` when none is found. Mirrors `executableExistsOnPath` but returns
 * the resolved path so callers can spawn a discovered launchable directly
 * instead of re-deriving it.
 */
export function resolveExecutableOnPathSync(command: string, pathEnv: string | undefined = process.env.PATH): string | undefined {
	const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
	for (const directory of (pathEnv ?? "").split(delimiter).filter(Boolean)) {
		for (const extension of extensions) {
			try {
				const candidate = join(directory, `${command}${extension}`);
				accessSync(candidate, fsConstants.X_OK);
				if (statSync(candidate).isFile()) return candidate;
			} catch {
				// Try the next PATH candidate.
			}
		}
	}
	return undefined;
}

export async function executableExistsOnPath(command: string): Promise<boolean> {
	return resolveExecutableOnPathSync(command) !== undefined;
}
