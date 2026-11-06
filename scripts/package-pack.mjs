/** Native npm packing/extraction and task-owned tarball cleanup. */
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Check } from "typebox/value";

const execFile = promisify(execFileCallback);
export const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
export const npmExecOptions = process.platform === "win32" ? { shell: true } : {};
const tarCommand = process.platform === "win32" ? "tar.exe" : "tar";

// npm's pack result (lib/utils/tar.js); retain extra native metadata without projecting it away.
const packResultSchema = Type.Object({
	name: Type.String(),
	version: Type.String(),
	filename: Type.String(),
	integrity: Type.String(),
	files: Type.Array(Type.Object({ path: Type.String() })),
	entryCount: Type.Number(),
	size: Type.Number(),
	unpackedSize: Type.Number(),
});

/** @typedef {import("typebox").Static<typeof packResultSchema>} PackResult */

/** @param {string} stdout */
export function parseSinglePackResult(stdout, stderr = "") {
	/** @type {unknown} */
	const parsed = JSON.parse(stdout);
	/** @type {unknown[]} */
	let results = [];
	if (Array.isArray(parsed)) {
		results = parsed;
	} else if (parsed !== null && typeof parsed === "object") {
		results = Object.values(parsed);
	}
	const result = results[0];
	if (results.length !== 1 || !Check(packResultSchema, result)) {
		throw new Error(`Unexpected npm pack output.\nstdout:\n${stdout}\n\nstderr:\n${stderr}`);
	}
	return result;
}

/** @param {string} [cwd]
 * @param {string} [tarballPath]
 */
export async function getDryRunPackResult(cwd = process.cwd(), tarballPath) {
	const args = ["pack", "--json", "--dry-run"];
	if (tarballPath !== undefined) {
		args.push("--ignore-scripts", tarballPath);
	}
	const { stdout, stderr } = await execFile(npmCommand, args, {
		...npmExecOptions,
		cwd,
		maxBuffer: 5 * 1024 * 1024,
	});
	return parseSinglePackResult(stdout, stderr);
}

/** @param {string} [cwd]
 * @param {string} [candidatePath]
 */
export async function packToTemporaryPackageDir(cwd = process.cwd(), candidatePath) {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-package-"));
	let tarballPath;
	const cleanup = async () => {
		await rm(tempDir, { force: true, recursive: true });
	};
	try {
		let packResult;
		if (candidatePath !== undefined) {
			const candidate = await readFile(resolve(cwd, candidatePath));
			tarballPath = join(tempDir, basename(candidatePath));
			await writeFile(tarballPath, candidate);
			packResult = await getDryRunPackResult(cwd, tarballPath);
			const integrity = `sha512-${createHash("sha512").update(candidate).digest("base64")}`;
			if (packResult.integrity !== integrity) {
				throw new Error("npm metadata does not match the supplied candidate tarball.");
			}
		} else {
			const { stdout, stderr } = await execFile(
				npmCommand,
				["pack", "--json", "--pack-destination", tempDir, "--dry-run=false"],
				{ ...npmExecOptions, cwd, maxBuffer: 5 * 1024 * 1024 },
			);
			packResult = parseSinglePackResult(stdout, stderr);
			if (packResult.filename.length === 0) {
				throw new Error(
					`Unexpected npm pack result without a filename.\nstdout:\n${stdout}\n\nstderr:\n${stderr}`,
				);
			}
			tarballPath = resolve(tempDir, packResult.filename);
		}
		await execFile(tarCommand, ["-xzf", basename(tarballPath)], {
			cwd: tempDir,
			maxBuffer: 5 * 1024 * 1024,
		});
		return { cleanup, packageDir: join(tempDir, "package"), packResult, tarballPath };
	} catch (error) {
		await cleanup();
		throw error;
	}
}
