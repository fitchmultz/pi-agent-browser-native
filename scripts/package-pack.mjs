/** Native npm packing/extraction and task-owned tarball cleanup. */
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
export const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
export const npmExecOptions = process.platform === "win32" ? { shell: true } : {};
const tarCommand = process.platform === "win32" ? "tar.exe" : "tar";

function parseSinglePackResult(stdout, stderr) {
	const parsed = JSON.parse(stdout);
	let results = [];
	if (Array.isArray(parsed)) {
		results = parsed;
	} else if (parsed && typeof parsed === "object") {
		results = Object.values(parsed);
	}
	if (results.length !== 1 || typeof results[0] !== "object" || results[0] === null) {
		throw new Error(`Unexpected npm pack output.\nstdout:\n${stdout}\n\nstderr:\n${stderr}`);
	}
	return results[0];
}

export async function getDryRunPackResult(cwd = process.cwd()) {
	const { stdout, stderr } = await execFile(npmCommand, ["pack", "--json", "--dry-run"], {
		...npmExecOptions,
		cwd,
		maxBuffer: 5 * 1024 * 1024,
	});
	return parseSinglePackResult(stdout, stderr);
}

export async function packToTemporaryPackageDir(cwd = process.cwd()) {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-package-"));
	let tarballPath;
	const cleanup = async () => {
		const evidenceDir = process.env.PI_COMPAT_EVIDENCE_DIR;
		if (evidenceDir && existsSync(tempDir)) {
			await mkdir(evidenceDir, { recursive: true });
			await cp(tempDir, join(evidenceDir, basename(tempDir)), { recursive: true });
		}
		await rm(tempDir, { force: true, recursive: true });
		if (tarballPath) {
			await rm(tarballPath, { force: true });
		}
	};
	try {
		const { stdout, stderr } = await execFile(
			npmCommand,
			["pack", "--json", "--pack-destination", tempDir, "--dry-run=false"],
			{ ...npmExecOptions, cwd, maxBuffer: 5 * 1024 * 1024 },
		);
		const packResult = parseSinglePackResult(stdout, stderr);
		if (typeof packResult.filename !== "string" || packResult.filename.length === 0) {
			throw new Error(
				`Unexpected npm pack result without a filename.\nstdout:\n${stdout}\n\nstderr:\n${stderr}`,
			);
		}
		tarballPath = resolve(tempDir, packResult.filename);
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
