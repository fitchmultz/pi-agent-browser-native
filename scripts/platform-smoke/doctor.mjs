/** Platform smoke doctor. Fails before target runs when Crabbox/platform setup is missing. */
import { accessSync, constants } from "node:fs";
import { DEFAULT_UBUNTU_IMAGE } from "../../platform-smoke.config.mjs";
import {
	checkAgentBrowserVersion,
	checkArtifactRoot,
	checkCrabboxProvider,
	checkForbiddenProjectFiles,
	commandPath,
	createReporter,
	env,
	isConfigObject,
	setting,
	shell,
	silent,
	versionAtLeast,
} from "./doctor-support.mjs";

/** @import { PlatformSmokeConfig } from "../../platform-smoke.config.mjs" */
/** @import { DoctorReport } from "./doctor-support.mjs" */
/** @typedef {Pick<PlatformSmokeConfig, "requiredTargets"> & Partial<PlatformSmokeConfig>} DoctorConfig */

/** @param {readonly unknown[]} providers */
function providerNames(providers) {
	return providers
		.map((provider) => {
			if (!isConfigObject(provider)) {
				return;
			}
			return provider.name ?? provider.id ?? provider.provider;
		})
		.filter((name) => typeof name === "string")
		.filter(Boolean);
}

/** @param {string} cbox */
function crabboxProviders(cbox) {
	const jsonOutput = silent(cbox, ["providers", "--json"]);
	if (jsonOutput !== null && jsonOutput.length > 0) {
		try {
			/** @type {unknown} */
			const parsed = JSON.parse(jsonOutput);
			if (Array.isArray(parsed)) {
				return providerNames(parsed);
			}
			if (isConfigObject(parsed)) {
				return Array.isArray(parsed.providers)
					? providerNames(parsed.providers)
					: Object.keys(parsed.providers ?? parsed);
			}
		} catch {
			// Fall through to text parsing for older or non-JSON provider output.
		}
	}
	const output = silent(cbox, ["providers"]);
	if (output === null || output.length === 0) {
		return [];
	}
	return output
		.split(/\r?\n/)
		.filter((line) => /^\S/.test(line))
		.map((line) => line.trim().split(/\s+/)[0])
		.filter((name) => name !== undefined && name.length > 0);
}

/** @param {string} cbox
 * @param {DoctorConfig} config
 * @param {DoctorReport} report
 */
function checkRequiredProviders(cbox, config, report) {
	const providers = crabboxProviders(cbox);
	if (providers.length === 0) {
		report.fail("could not read crabbox providers");
		return;
	}
	const providersByTarget = new Map([
		["macos", "ssh"],
		["ubuntu", "local-container"],
	]);
	for (const target of config.requiredTargets) {
		const provider = providersByTarget.get(target);
		if (provider !== undefined && providers.includes(provider)) {
			report.ok(`crabbox provider available: ${provider}`);
		} else {
			report.fail(`crabbox provider missing: ${String(provider)}`);
		}
	}
}

/** @param {string} cbox
 * @param {string | undefined} minimum
 * @param {DoctorReport} report
 */
function checkCrabboxVersion(cbox, minimum, report) {
	const version = silent(cbox, ["--version"]);
	if (version === null || version.length === 0) {
		report.fail("could not read Crabbox version");
		return;
	}
	const displayVersion = version.split(/\r?\n/, 1).join("");
	report.ok(`version: ${displayVersion}`);
	if (minimum !== undefined && minimum.length > 0) {
		if (versionAtLeast(displayVersion, minimum)) {
			report.ok(`version ${displayVersion} >= ${minimum}`);
		} else {
			report.fail(`Crabbox version ${displayVersion} < ${minimum}`);
		}
	}
}

/** @param {string} cbox
 * @param {Partial<PlatformSmokeConfig>} config
 * @param {DoctorReport} report
 */
function checkCrabboxBinary(cbox, config, report) {
	console.log("\n── Crabbox binary ──");
	const override = env("PLATFORM_SMOKE_CRABBOX");
	const cboxPath = override.length > 0 ? override : commandPath("crabbox");
	if (cboxPath === null || cboxPath.length === 0) {
		report.fail("crabbox not found on PATH; install with Homebrew or set PLATFORM_SMOKE_CRABBOX");
		return cboxPath;
	}
	if (override.length > 0) {
		try {
			accessSync(cboxPath, constants.X_OK);
			report.ok(`binary: ${cboxPath}`);
		} catch {
			report.fail(`${cboxPath} is not executable`);
		}
	} else {
		report.ok(`binary: ${cboxPath}`);
	}
	checkCrabboxVersion(cbox, config.requiredCrabbox?.minVersion, report);
	return cboxPath;
}

/** @param {string | undefined} minimum
 * @param {DoctorReport} report
 */
function checkHostNodeVersion(minimum, report) {
	const localNode = shell("node --version");
	if (
		minimum !== undefined &&
		minimum.length > 0 &&
		localNode !== null &&
		localNode.length > 0 &&
		versionAtLeast(localNode, minimum)
	) {
		report.ok(`host Node ${localNode} >= ${minimum}`);
	} else {
		report.fail(
			`host Node ${localNode === null || localNode.length === 0 ? "unknown" : localNode} < ${minimum ?? "configured minimum"}`,
		);
	}
}

/** @param {Partial<PlatformSmokeConfig>} config
 * @param {DoctorReport} report
 */
function checkHostTools(config, report) {
	console.log("\n── Host tools ──");
	for (const [name, command] of Object.entries({
		node: "node --version",
		npm: "npm --version",
		git: "git --version",
		tar: "tar --version",
	})) {
		const output = shell(command);
		if (output === null || output.length === 0) {
			report.fail(`${name} not found`);
		} else {
			report.ok(`${name}: ${output.split(/\r?\n/, 1).join("")}`);
		}
	}
	checkHostNodeVersion(config.nodeValidationVersion, report);
	checkAgentBrowserVersion(config.agentBrowserVersion, report);
}

/** @param {Partial<PlatformSmokeConfig>} config
 * @param {string} packageName
 */
function macSettings(config, packageName) {
	const user = setting("PLATFORM_SMOKE_MAC_USER", undefined, env("USER"));
	return {
		user,
		host: setting("PLATFORM_SMOKE_MAC_HOST", config.macos?.host, "localhost"),
		port: String(setting("PLATFORM_SMOKE_MAC_PORT", config.macos?.port, 22)),
		workRoot: setting(
			"PLATFORM_SMOKE_MAC_WORK_ROOT",
			config.macos?.workRoot,
			`/Users/${user}/crabbox/${packageName}`,
		),
	};
}

/** @param {string} cbox
 * @param {DoctorConfig} config
 * @param {{readonly packageName: string; readonly ubuntuImage: string}} settings
 * @param {DoctorReport} report
 */
function checkProviders(cbox, config, settings, report) {
	checkRequiredProviders(cbox, config, report);
	if (config.requiredTargets.includes("ubuntu")) {
		checkCrabboxProvider(
			cbox,
			["--provider", "local-container", "--local-container-image", settings.ubuntuImage],
			"ubuntu local-container",
			report,
		);
	}
	if (!config.requiredTargets.includes("macos")) {
		return;
	}
	const mac = macSettings(config, settings.packageName);
	checkCrabboxProvider(
		cbox,
		[
			"--provider",
			"ssh",
			"--target",
			"macos",
			"--static-host",
			mac.host,
			"--static-user",
			mac.user,
			"--static-port",
			mac.port,
			"--static-work-root",
			mac.workRoot,
		],
		"macOS ssh",
		report,
	);
}

/** @param {string} ubuntuImage
 * @param {DoctorReport} report
 */
function checkDocker(ubuntuImage, report) {
	console.log("\n── Docker / Ubuntu ──");
	const dockerVersion = shell("docker info --format '{{.ServerVersion}}'");
	if (dockerVersion !== null && dockerVersion.length > 0) {
		report.ok(`Docker ${dockerVersion}`);
	} else {
		report.fail("Docker is not available or not running");
	}
	report.ok(`Ubuntu image: ${ubuntuImage}`);
}

/** @param {Partial<PlatformSmokeConfig>} config
 * @param {string} packageName
 * @param {DoctorReport} report
 */
function checkMacSsh(config, packageName, report) {
	console.log("\n── macOS SSH ──");
	const mac = macSettings(config, packageName);
	const probe = shell(
		`ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no -p ${mac.port} ${mac.user}@${mac.host} 'node --version && npm --version && git --version && agent-browser --version'`,
	);
	if (probe === null || probe.length === 0) {
		report.fail(`SSH probe failed for ${mac.user}@${mac.host}`);
		return;
	}
	report.ok(`SSH ${mac.user}@${mac.host}: ${probe.split(/\r?\n/).join(" | ")}`);
	const expectedVersion = config.agentBrowserVersion;
	if (
		expectedVersion !== undefined &&
		expectedVersion.length > 0 &&
		!probe.includes(expectedVersion)
	) {
		report.fail(`macOS SSH agent-browser does not match expected ${expectedVersion}`);
	}
}

/** @param {Partial<PlatformSmokeConfig>} config */
function doctorSettings(config) {
	return {
		packageName: config.packageName ?? "pi-agent-browser-native",
		artifactRoot: config.artifactRoot ?? ".artifacts/platform-smoke",
		targets: (config.requiredTargets ?? []).join(", "),
		suites: (config.requiredSuites ?? []).join(", "),
		agentBrowserVersion: config.agentBrowserVersion,
	};
}

/** @param {DoctorConfig} config */
export async function runDoctor(config) {
	const report = createReporter();
	const settings = doctorSettings(config);
	const { packageName, artifactRoot } = settings;
	console.log("\n── Platform smoke config ──");
	report.ok(`package: ${packageName}`);
	report.ok(`targets: ${settings.targets}`);
	report.ok(`suites: ${settings.suites}`);
	report.ok(`agent-browser baseline: ${settings.agentBrowserVersion ?? "not configured"}`);
	const cbox = setting("PLATFORM_SMOKE_CRABBOX", undefined, "crabbox");
	const cboxPath = checkCrabboxBinary(cbox, config, report);
	checkHostTools(config, report);
	console.log("\n── Crabbox providers ──");
	const ubuntuImage = setting(
		"PLATFORM_SMOKE_UBUNTU_IMAGE",
		config.ubuntuContainerImage,
		DEFAULT_UBUNTU_IMAGE,
	);
	if (cboxPath !== null && cboxPath.length > 0) {
		checkProviders(cbox, config, { packageName, ubuntuImage }, report);
	}
	if (config.requiredTargets.includes("ubuntu")) {
		checkDocker(ubuntuImage, report);
	}
	if (config.requiredTargets.includes("macos")) {
		checkMacSsh(config, packageName, report);
	}
	checkArtifactRoot(artifactRoot, report);
	console.log("\n── Repository hygiene ──");
	const status = shell("git status --short");
	if (status !== null && status.length > 0) {
		report.warn(
			`${status.split(/\r?\n/).length} uncommitted change(s) recorded for smoke evidence`,
		);
	} else {
		report.ok("git status clean");
	}
	checkForbiddenProjectFiles(report);
	console.log(`\n=== Results: ${report.count} failure(s) ===`);
	if (report.count > 0) {
		console.log("Fix doctor failures before running smoke:platform:all.");
		process.exitCode = 1;
	} else {
		console.log("Platform smoke setup is ready.");
	}
}
