import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

export async function executableExistsOnPath(command: string): Promise<boolean> {
	const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
	for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
		for (const extension of extensions) {
			try {
				const candidate = join(directory, `${command}${extension}`);
				await access(candidate, fsConstants.X_OK);
				if ((await stat(candidate)).isFile()) return true;
			} catch {
				// Try the next PATH candidate.
			}
		}
	}
	return false;
}
