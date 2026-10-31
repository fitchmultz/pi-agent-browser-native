/** Read-only host/process inspection and platform-doctor report ownership. */
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function env(name) {
	return process.env[name] ?? "";
}
export function setting(name, configured, fallback) {
	return env(name) || configured || fallback;
}

export function createReporter() {
	let count = 0;
	return {
		ok(label) {
			console.log(`  ✓ ${label}`);
		},
		warn(label) {
			console.log(`  ⚠ ${label}`);
		},
		fail(label) {
			console.error(`  ✗ ${label}`);
			count += 1;
		},
		get count() {
			return count;
		},
	};
}

export function silent(cmd, args, options = {}) {
	try {
		return execFileSync(cmd, args, { timeout: 20_000, stdio: "pipe", ...options })
			.toString()
			.trim();
	} catch {
		return null;
	}
}
export function shell(command, options = {}) {
	try {
		return execSync(command, { timeout: 20_000, stdio: "pipe", ...options })
			.toString()
			.trim();
	} catch {
		return null;
	}
}
export function commandPath(name) {
	return silent("which", [name]);
}

function parseVersion(version) {
	const match = String(version).match(/\d+(?:\.\d+){0,2}/);
	return match ? match[0].split(".").map((part) => Number(part)) : null;
}
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
function npmPackFiles() {
	const output = silent("npm", ["pack", "--dry-run", "--json"], { timeout: 0 });
	if (!output) {
		return null;
	}
	try {
		const parsed = JSON.parse(output);
		const packages = Array.isArray(parsed) ? parsed : Object.values(parsed);
		if (packages.length !== 1 || !Array.isArray(packages[0]?.files)) {
			return null;
		}
		return packages[0].files.map((file) => file.path);
	} catch {
		return null;
	}
}

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
		report.fail(`artifact root not writable: ${error.message}`);
	}
}

export function checkAgentBrowserVersion(expectedVersion, report, command = "agent-browser") {
	const version = shell(`${command} --version`);
	if (!version) {
		report.fail(`${command} not found or did not report a version`);
		return;
	}
	const firstLine = version.split(/\r?\n/)[0];
	if (!expectedVersion || firstLine.includes(expectedVersion)) {
		report.ok(`${command}: ${firstLine}`);
	} else {
		report.fail(`${command} version ${firstLine} does not match expected ${expectedVersion}`);
	}
}
