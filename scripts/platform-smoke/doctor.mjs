/** Platform smoke doctor. Fails before target runs when Crabbox/platform setup is missing. */

import { execFileSync, execSync } from "node:child_process";
import { accessSync, constants, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { CAPABILITY_BASELINE } from "../agent-browser-capability-baseline.mjs";

const DEFAULT_UBUNTU_IMAGE = `pi-agent-browser-native-platform:node24-agent-browser${CAPABILITY_BASELINE.targetVersion}`;

function env(name) {
	return process.env[name] ?? "";
}

function ok(label) {
	console.log(`  ✓ ${label}`);
}

function warn(label) {
	console.log(`  ⚠ ${label}`);
}

function fail(label, failures) {
	console.error(`  ✗ ${label}`);
	failures.count += 1;
}

function silent(cmd, args, options = {}) {
	try {
		return execFileSync(cmd, args, { timeout: 20_000, stdio: "pipe", ...options }).toString().trim();
	} catch {
		return null;
	}
}

function shell(command, options = {}) {
	try {
		return execSync(command, { timeout: 20_000, stdio: "pipe", ...options }).toString().trim();
	} catch {
		return null;
	}
}

function hasCommand(name) {
	return silent("which", [name]) !== null;
}

function commandPath(name) {
	return silent("which", [name]);
}

function parseVersion(version) {
	const match = String(version).match(/\d+(?:\.\d+){0,2}/);
	return match ? match[0].split(".").map((part) => Number(part)) : null;
}

function versionAtLeast(actual, minimum) {
	const parsedActual = parseVersion(actual);
	const parsedMinimum = parseVersion(minimum);
	if (!parsedActual || !parsedMinimum) return false;
	for (let index = 0; index < Math.max(parsedActual.length, parsedMinimum.length); index += 1) {
		const a = parsedActual[index] ?? 0;
		const b = parsedMinimum[index] ?? 0;
		if (a > b) return true;
		if (a < b) return false;
	}
	return true;
}

function isForbiddenProjectPath(path) {
	return /(^|\/)\.env(?:\..*)?$/.test(path)
		|| /(^|\/)[^/]+\.tgz$/.test(path)
		|| /(^|\/)\.artifacts(?:\/|$)/.test(path)
		|| /(^|\/)\.crabbox(?:\/|$)/.test(path)
		|| /(^|\/)\.debug(?:\/|$)/.test(path)
		|| /(^|\/)\.platform-smoke-runs(?:\/|$)/.test(path);
}

function npmPackFiles() {
	const output = silent("npm", ["pack", "--dry-run", "--json"]);
	if (!output) return null;
	try {
		const parsed = JSON.parse(output);
		return parsed[0]?.files?.map((file) => file.path) ?? [];
	} catch {
		return null;
	}
}

function checkForbiddenProjectFiles(failures) {
	const tracked = shell("git ls-files")?.split(/\r?\n/).filter(Boolean) ?? [];
	const trackedForbidden = tracked.filter(isForbiddenProjectPath);
	if (trackedForbidden.length === 0) ok("tracked source files exclude forbidden local artifacts");
	else fail(`forbidden tracked source path(s): ${trackedForbidden.join(", ")}`, failures);

	const localForbidden = shell("find . -maxdepth 2 \\( -name '.env' -o -name '.env.*' -o -name '*.tgz' \\) -not -path './node_modules/*' 2>/dev/null")
		?.split(/\r?\n/).filter(Boolean) ?? [];
	if (localForbidden.length === 0) ok("no local .env or package tarball artifacts at repo top level");
	else fail(`forbidden local artifact(s): ${localForbidden.join(", ")}`, failures);

	const packFiles = npmPackFiles();
	if (!packFiles) {
		fail("could not inspect npm pack contents", failures);
		return;
	}
	const packedForbidden = packFiles.filter(isForbiddenProjectPath);
	if (packedForbidden.length === 0) ok("npm package excludes forbidden local artifacts");
	else fail(`forbidden npm package path(s): ${packedForbidden.join(", ")}`, failures);
}

function crabboxProviders(cbox) {
	const jsonOutput = silent(cbox, ["providers", "--json"]);
	if (jsonOutput) {
		try {
			const parsed = JSON.parse(jsonOutput);
			if (Array.isArray(parsed)) return parsed.map((provider) => provider.name ?? provider.id ?? provider.provider).filter(Boolean);
			if (Array.isArray(parsed.providers)) return parsed.providers.map((provider) => provider.name ?? provider.id ?? provider.provider).filter(Boolean);
			if (typeof parsed === "object" && parsed) return Object.keys(parsed.providers ?? parsed);
		} catch {
			// Fall through to text parsing for older or non-JSON provider output.
		}
	}
	const output = silent(cbox, ["providers"]);
	if (!output) return [];
	return output.split(/\r?\n/)
		.filter((line) => /^\S/.test(line))
		.map((line) => line.trim().split(/\s+/)[0])
		.filter(Boolean);
}

function checkRequiredProviders(cbox, failures) {
	const providers = crabboxProviders(cbox);
	if (providers.length === 0) {
		fail("could not read crabbox providers", failures);
		return;
	}
	for (const provider of ["ssh", "local-container", "parallels"]) {
		if (providers.includes(provider)) ok(`crabbox provider available: ${provider}`);
		else fail(`crabbox provider missing: ${provider}`, failures);
	}
}

function checkCrabboxProvider(cbox, args, label, failures) {
	const output = silent(cbox, ["doctor", ...args, "--json"]);
	if (!output) {
		fail(`${label} crabbox doctor failed`, failures);
		return;
	}
	try {
		const parsed = JSON.parse(output);
		if (parsed.ok) ok(`${label} provider OK`);
		else fail(`${label} provider not ready: ${parsed.error ?? "unknown error"}`, failures);
	} catch {
		warn(`${label} provider returned non-JSON doctor output`);
	}
}

function checkAgentBrowserVersion(expectedVersion, failures, command = "agent-browser") {
	const version = shell(`${command} --version`);
	if (!version) {
		fail(`${command} not found or did not report a version`, failures);
		return;
	}
	const firstLine = version.split(/\r?\n/)[0];
	if (!expectedVersion || firstLine.includes(expectedVersion)) ok(`${command}: ${firstLine}`);
	else fail(`${command} version ${firstLine} does not match expected ${expectedVersion}`, failures);
}

export async function runDoctor(config) {
	const failures = { count: 0 };
	const packageName = config?.packageName ?? "pi-agent-browser-native";
	const artifactRoot = config?.artifactRoot ?? ".artifacts/platform-smoke";
	const nodeMajor = config?.nodeValidationMajor ?? 22;
	const agentBrowserVersion = config?.agentBrowserVersion;

	console.log("\n── Platform smoke config ──");
	ok(`package: ${packageName}`);
	ok(`targets: ${(config?.requiredTargets ?? []).join(", ")}`);
	ok(`suites: ${(config?.requiredSuites ?? []).join(", ")}`);
	ok(`agent-browser baseline: ${agentBrowserVersion ?? "not configured"}`);

	console.log("\n── Crabbox binary ──");
	const cbox = env("PLATFORM_SMOKE_CRABBOX") || "crabbox";
	const cboxPath = env("PLATFORM_SMOKE_CRABBOX") || commandPath("crabbox");
	if (!cboxPath) {
		fail("crabbox not found on PATH; install with Homebrew or set PLATFORM_SMOKE_CRABBOX", failures);
	} else {
		if (env("PLATFORM_SMOKE_CRABBOX")) {
			try {
				accessSync(cboxPath, constants.X_OK);
				ok(`binary: ${cboxPath}`);
			} catch {
				fail(`${cboxPath} is not executable`, failures);
			}
		} else {
			ok(`binary: ${cboxPath}`);
		}
		const version = silent(cbox, ["--version"]);
		if (version) {
			const displayVersion = version.split(/\r?\n/)[0];
			ok(`version: ${displayVersion}`);
			const minVersion = config?.requiredCrabbox?.minVersion;
			if (minVersion) {
				if (versionAtLeast(displayVersion, minVersion)) ok(`version ${displayVersion} >= ${minVersion}`);
				else fail(`Crabbox version ${displayVersion} < ${minVersion}`, failures);
			}
		} else {
			fail("could not read Crabbox version", failures);
		}
	}

	console.log("\n── Host tools ──");
	for (const [name, command] of [["node", "node --version"], ["npm", "npm --version"], ["git", "git --version"], ["tar", "tar --version"]]) {
		const output = shell(command);
		if (!output) fail(`${name} not found`, failures);
		else ok(`${name}: ${output.split(/\r?\n/)[0]}`);
	}
	const localNode = shell("node --version");
	const localNodeMajor = Number(localNode?.replace(/^v/, "").split(".")[0] ?? 0);
	if (localNodeMajor >= nodeMajor) ok(`host Node major ${localNodeMajor} >= ${nodeMajor}`);
	else fail(`host Node major ${localNodeMajor || "unknown"} < ${nodeMajor}`, failures);
	checkAgentBrowserVersion(agentBrowserVersion, failures);

	console.log("\n── Crabbox providers ──");
	if (cboxPath) {
		checkRequiredProviders(cbox, failures);
		const ubuntuImage = env("PLATFORM_SMOKE_UBUNTU_IMAGE") || config?.ubuntuContainerImage || DEFAULT_UBUNTU_IMAGE;
		checkCrabboxProvider(cbox, ["--provider", "local-container", "--local-container-image", ubuntuImage], "ubuntu local-container", failures);
		const macUser = env("PLATFORM_SMOKE_MAC_USER") || env("USER");
		const macHost = env("PLATFORM_SMOKE_MAC_HOST") || config?.macos?.host || "localhost";
		const macPort = String(env("PLATFORM_SMOKE_MAC_PORT") || config?.macos?.port || 22);
		const macRoot = env("PLATFORM_SMOKE_MAC_WORK_ROOT") || config?.macos?.workRoot || `/Users/${macUser}/crabbox/${packageName}`;
		checkCrabboxProvider(cbox, ["--provider", "ssh", "--target", "macos", "--static-host", macHost, "--static-user", macUser, "--static-port", macPort, "--static-work-root", macRoot], "macOS ssh", failures);
	}

	console.log("\n── Docker / Ubuntu ──");
	const dockerVersion = shell("docker info --format '{{.ServerVersion}}'");
	if (dockerVersion) ok(`Docker ${dockerVersion}`);
	else fail("Docker is not available or not running", failures);
	const ubuntuImage = env("PLATFORM_SMOKE_UBUNTU_IMAGE") || config?.ubuntuContainerImage || DEFAULT_UBUNTU_IMAGE;
	ok(`Ubuntu image: ${ubuntuImage}`);

	console.log("\n── macOS SSH ──");
	const sshUser = env("PLATFORM_SMOKE_MAC_USER") || env("USER");
	const sshHost = env("PLATFORM_SMOKE_MAC_HOST") || config?.macos?.host || "localhost";
	const sshPort = String(env("PLATFORM_SMOKE_MAC_PORT") || config?.macos?.port || 22);
	const sshProbe = shell(`ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no -p ${sshPort} ${sshUser}@${sshHost} 'node --version && npm --version && git --version && agent-browser --version'`);
	if (sshProbe) {
		ok(`SSH ${sshUser}@${sshHost}: ${sshProbe.split(/\r?\n/).join(" | ")}`);
		if (agentBrowserVersion && !sshProbe.includes(agentBrowserVersion)) fail(`macOS SSH agent-browser does not match expected ${agentBrowserVersion}`, failures);
	} else {
		fail(`SSH probe failed for ${sshUser}@${sshHost}`, failures);
	}

	if ((config?.requiredTargets ?? []).includes("windows-native")) {
		console.log("\n── Windows native / Parallels ──");
		if (!hasCommand("prlctl")) {
			fail("prlctl not found", failures);
		} else {
			ok("prlctl found");
			const vmName = env("PLATFORM_SMOKE_WINDOWS_VM") || config?.windowsParallels?.sourceVm || "pi-extension-windows-template";
			const snapshot = env("PLATFORM_SMOKE_WINDOWS_SNAPSHOT") || config?.windowsParallels?.snapshot || "crabbox-ready";
			const user = env("PLATFORM_SMOKE_WINDOWS_USER") || config?.windowsParallels?.user || env("USER");
			const workRoot = env("PLATFORM_SMOKE_WINDOWS_WORK_ROOT") || config?.windowsParallels?.workRoot || `C:\\crabbox\\${packageName}`;
			const list = shell("prlctl list -a --no-header 2>/dev/null");
			if (!list) {
				fail("prlctl list returned no VMs", failures);
			} else if (!list.includes(vmName)) {
				fail(`Windows VM ${vmName} not found`, failures);
			} else {
				ok(`Windows VM ${vmName} found`);
				const status = shell(`prlctl status "${vmName.replace(/"/g, "\\\"")}" 2>/dev/null`);
				if (/\bstopped\b/i.test(status ?? "")) ok(`Windows source VM ${vmName} is stopped`);
				else fail(`Windows source VM ${vmName} must be stopped for forkable snapshot use; current status: ${status ?? "unknown"}`, failures);
				const snapshotsJson = shell(`prlctl snapshot-list "${vmName.replace(/"/g, "\\\"")}" -j 2>/dev/null`);
				let snapshotMatch = null;
				try {
					const snapshots = JSON.parse(snapshotsJson ?? "{}");
					snapshotMatch = Object.entries(snapshots).find(([id, data]) => id === snapshot || data?.name === snapshot);
				} catch {
					// Fall through to the failure below.
				}
				if (snapshotMatch) {
					ok(`snapshot ${snapshot} found`);
					const snapshotState = snapshotMatch[1]?.state ?? "unknown";
					if (snapshotState === "poweroff") ok(`snapshot ${snapshot} state is poweroff`);
					else fail(`snapshot ${snapshot} must be poweroff; current snapshot state: ${snapshotState}`, failures);
				} else {
					fail(`snapshot ${snapshot} not found on ${vmName}`, failures);
				}
				checkCrabboxProvider(cbox, ["--provider", "parallels", "--target", "windows", "--windows-mode", "normal", "--parallels-source", vmName, "--parallels-source-snapshot", snapshot, "--parallels-user", user, "--parallels-work-root", workRoot], "windows parallels", failures);
			}
		}
	} else {
		console.log("\n── Windows native / Parallels ──");
		warn("windows-native is not listed in requiredTargets for this configuration");
	}

	console.log("\n── Artifact root ──");
	const artRoot = resolve(process.cwd(), artifactRoot);
	try {
		mkdirSync(artRoot, { recursive: true });
		const probe = resolve(artRoot, ".doctor-write-test");
		writeFileSync(probe, "ok");
		unlinkSync(probe);
		ok(`writable: ${artRoot}`);
	} catch (error) {
		fail(`artifact root not writable: ${error.message}`, failures);
	}

	console.log("\n── Repository hygiene ──");
	const status = shell("git status --short");
	if (status) warn(`${status.split(/\r?\n/).length} uncommitted change(s) recorded for smoke evidence`);
	else ok("git status clean");
	checkForbiddenProjectFiles(failures);

	console.log(`\n=== Results: ${failures.count} failure(s) ===`);
	if (failures.count > 0) {
		console.log("Fix doctor failures before running smoke:platform:all.");
		process.exitCode = 1;
	} else {
		console.log("Platform smoke setup is ready.");
	}
}
