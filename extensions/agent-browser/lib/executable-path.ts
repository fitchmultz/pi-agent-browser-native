import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

async function isExecutableFile(candidate: string): Promise<boolean> {
	try {
		await access(candidate, fsConstants.X_OK);
		return (await stat(candidate)).isFile();
	} catch {
		return false;
	}
}

export async function executableExistsOnPath(command: string): Promise<boolean> {
	const extensions =
		process.platform === "win32"
			? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
			: [""];
	const candidates = (process.env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)
		.flatMap((directory) =>
			extensions.map((extension) => join(directory, `${command}${extension}`)),
		);
	for (const candidate of candidates) {
		// Respect PATH/PATHEXT precedence and stop probing after the first executable.
		if (await isExecutableFile(candidate)) {
			return true;
		}
	}
	return false;
}
