/** Read-only host/process inspection and platform-doctor report ownership. */
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfigPolicyModule } from "../config-policy-loader.mjs";
export { env, targetSetting as setting } from "./crabbox-runner.mjs";
export const { isConfigObject } = await loadConfigPolicyModule();

/** @typedef {ReturnType<typeof createReporter>} DoctorReport */

export function createReporter() {
	let count = 0;
	return {
		/** @param {string} label */
		ok(label) {
			console.log(`  ✓ ${label}`);
		},
		/** @param {string} label */
		warn(label) {
			console.log(`  ⚠ ${label}`);
		},
		/** @param {string} label */
		fail(label) {
			console.error(`  ✗ ${label}`);
			count += 1;
		},
		get count() {
			return count;
		},
	};
}

/** @param {string} cmd
 * @param {readonly string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [options]
 */
export function silent(cmd, args, options = {}) {
	try {
		return execFileSync(cmd, args, { timeout: 20_000, stdio: "pipe", ...options })
			.toString()
			.trim();
	} catch {
		return null;
	}
}
/** @param {string} command
 * @param {import("node:child_process").ExecSyncOptions} [options]
 */
export function shell(command, options = {}) {
	try {
		return execSync(command, { timeout: 20_000, stdio: "pipe", ...options })
			.toString()
			.trim();
	} catch {
		return null;
	}
}
/** @param {string} name */
export function commandPath(name) {
	return silent("which", [name]);
}

/** @param {string} version */
function parseVersion(version) {
	const match = version.match(/\d+(?:\.\d+){0,2}/);
	return match ? match[0].split(".").map((part) => Number(part)) : null;
}
/** @param {string} cbox
 * @param {readonly string[]} args
 * @param {string} label
 * @param {DoctorReport} report
 */
export function checkCrabboxProvider(cbox, args, label, report) {
	const output = silent(cbox, ["doctor", ...args, "--json"]);
	if (output === null || output.length === 0) {
		report.fail(`${label} crabbox doctor failed`);
		return;
	}
	try {
		/** @type {unknown} */
		const parsed = JSON.parse(output);
		const status = isConfigObject(parsed) ? parsed : {};
		const ready = Boolean(status.ok);
		if (ready) {
			report.ok(`${label} provider OK`);
		} else {
			const message = String(status.error);
			report.fail(
				`${label} provider not ready: ${status.error === null || status.error === undefined ? "unknown error" : message}`,
			);
		}
	} catch {
		report.warn(`${label} provider returned non-JSON doctor output`);
	}
}

/** @param {string} actual
 * @param {string} minimum
 */
export function versionAtLeast(actual, minimum) {
	const a = parseVersion(actual);
	const b = parseVersion(minimum);
	if (!a || !b) {
		return false;
	}
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const left = a[index] ?? 0;
		const right = b[index] ?? 0;
		if (left > right) {
			return true;
		}
		if (left < right) {
			return false;
		}
	}
	return true;
}

/** @param {string} path */
function isForbiddenProjectPath(path) {
	return (
		/(^|\/)\.env(?:\..*)?$/.test(path) ||
		/(^|\/)[^/]+\.tgz$/.test(path) ||
		/(^|\/)\.artifacts(?:\/|$)/.test(path) ||
		/(^|\/)\.crabbox(?:\/|$)/.test(path) ||
		/(^|\/)\.debug(?:\/|$)/.test(path) ||
		/(^|\/)\.platform-smoke-runs(?:\/|$)/.test(path)
	);
}
/** @param {unknown} parsed */
function packFilePaths(parsed) {
	/** @type {readonly unknown[]} */
	const packages = Array.isArray(parsed) ? parsed : Object.values(parsed ?? {});
	const [pack] = packages;
	if (packages.length !== 1 || !isConfigObject(pack) || !Array.isArray(pack.files)) {
		return null;
	}
	const paths = pack.files.map((/** @type {unknown} */ file) =>
		isConfigObject(file) ? file.path : undefined,
	);
	return paths.every((path) => typeof path === "string") ? paths : null;
}

function npmPackFiles() {
	const windows = process.platform === "win32";
	const output = silent(windows ? "npm.cmd" : "npm", ["pack", "--dry-run", "--json"], {
		timeout: 0,
		shell: windows,
	});
	if (output === null || output.length === 0) {
		return null;
	}
	try {
		return packFilePaths(JSON.parse(output));
	} catch {
		return null;
	}
}

/** @param {Pick<DoctorReport, "ok" | "fail">} report */
export function checkForbiddenProjectFiles(report) {
	const tracked = shell("git ls-files")?.split(/\r?\n/).filter(Boolean) ?? [];
	const trackedForbidden = tracked.filter(isForbiddenProjectPath);
	if (trackedForbidden.length === 0) {
		report.ok("tracked source files exclude forbidden local artifacts");
	} else {
		report.fail(`forbidden tracked source path(s): ${trackedForbidden.join(", ")}`);
	}
	const localForbidden =
		shell(
			"find . -maxdepth 2 \\( -name '.env' -o -name '.env.*' -o -name '*.tgz' \\) -not -path './node_modules/*' 2>/dev/null",
		)
			?.split(/\r?\n/)
			.filter(Boolean) ?? [];
	if (localForbidden.length === 0) {
		report.ok("no local .env or package tarball artifacts at repo top level");
	} else {
		report.fail(`forbidden local artifact(s): ${localForbidden.join(", ")}`);
	}
	const packFiles = npmPackFiles();
	if (!packFiles) {
		report.fail("could not inspect npm pack contents");
		return;
	}
	const packedForbidden = packFiles.filter(isForbiddenProjectPath);
	if (packedForbidden.length === 0) {
		report.ok("npm package excludes forbidden local artifacts");
	} else {
		report.fail(`forbidden npm package path(s): ${packedForbidden.join(", ")}`);
	}
}

/** @param {string} artifactRoot
 * @param {Pick<DoctorReport, "ok" | "fail">} report
 */
export function checkArtifactRoot(artifactRoot, report) {
	console.log("\n── Artifact root ──");
	const artRoot = resolve(process.cwd(), artifactRoot);
	try {
		mkdirSync(artRoot, { recursive: true });
		const probe = resolve(artRoot, ".doctor-write-test");
		writeFileSync(probe, "ok");
		unlinkSync(probe);
		report.ok(`writable: ${artRoot}`);
	} catch (error) {
		report.fail(
			`artifact root not writable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** @param {string | undefined} expectedVersion
 * @param {Pick<DoctorReport, "ok" | "fail">} report
 * @param {string} [command]
 */
export function checkAgentBrowserVersion(expectedVersion, report, command = "agent-browser") {
	const version = shell(`${command} --version`);
	if (version === null || version.length === 0) {
		report.fail(`${command} not found or did not report a version`);
		return;
	}
	const firstLine = version.split(/\r?\n/, 1).join("");
	if (
		expectedVersion === undefined ||
		expectedVersion.length === 0 ||
		firstLine.includes(expectedVersion)
	) {
		report.ok(`${command}: ${firstLine}`);
	} else {
		report.fail(`${command} version ${firstLine} does not match expected ${expectedVersion}`);
	}
}
