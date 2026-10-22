/** Platform smoke doctor. Fails before target runs when Crabbox/platform setup is missing. */
import { accessSync, constants } from "node:fs";
import { CAPABILITY_BASELINE } from "../agent-browser-capability-baseline.mjs";
import {
	checkAgentBrowserVersion,
	checkArtifactRoot,
	checkForbiddenProjectFiles,
	commandPath,
	createReporter,
	env,
	setting,
	shell,
	silent,
	versionAtLeast,
} from "./doctor-support.mjs";
import { checkWindows } from "./doctor-windows.mjs";
export { disposableWindowsAgentBrowserProbe } from "./doctor-windows.mjs";

const DEFAULT_UBUNTU_IMAGE = `pi-agent-browser-native-platform:node24-agent-browser${CAPABILITY_BASELINE.targetVersion}`;

function crabboxProviders(cbox) {
	const jsonOutput = silent(cbox, ["providers", "--json"]);
	if (jsonOutput) {
		try {
			const parsed = JSON.parse(jsonOutput);
			if (Array.isArray(parsed)) {
				return parsed
					.map((provider) => provider.name ?? provider.id ?? provider.provider)
					.filter(Boolean);
			}
			if (Array.isArray(parsed.providers)) {
				return parsed.providers
					.map((provider) => provider.name ?? provider.id ?? provider.provider)
					.filter(Boolean);
			}
			if (typeof parsed === "object" && parsed) {
				return Object.keys(parsed.providers ?? parsed);
			}
		} catch {
			// Fall through to text parsing for older or non-JSON provider output.
		}
	}
	const output = silent(cbox, ["providers"]);
	if (!output) {
		return [];
	}
	return output
		.split(/\r?\n/)
		.filter((line) => /^\S/.test(line))
		.map((line) => line.trim().split(/\s+/)[0])
		.filter(Boolean);
}

function checkRequiredProviders(cbox, config, report) {
	const providers = crabboxProviders(cbox);
	if (providers.length === 0) {
		report.fail("could not read crabbox providers");
		return;
	}
	const providersByTarget = {
		macos: "ssh",
		ubuntu: "local-container",
		"windows-native": "parallels",
	};
	for (const target of config.requiredTargets) {
		const provider = providersByTarget[target];
		if (providers.includes(provider)) {
			report.ok(`crabbox provider available: ${provider}`);
		} else {
			report.fail(`crabbox provider missing: ${provider}`);
		}
	}
}

function checkCrabboxProvider(cbox, args, label, report) {
	const output = silent(cbox, ["doctor", ...args, "--json"]);
	if (!output) {
		report.fail(`${label} crabbox doctor failed`);
		return;
	}
	try {
		const parsed = JSON.parse(output);
		if (parsed.ok) {
			report.ok(`${label} provider OK`);
		} else {
			report.fail(`${label} provider not ready: ${parsed.error ?? "unknown error"}`);
		}
	} catch {
		report.warn(`${label} provider returned non-JSON doctor output`);
	}
}

function checkCrabboxVersion(cbox, minimum, report) {
	const version = silent(cbox, ["--version"]);
	if (!version) {
		report.fail("could not read Crabbox version");
		return;
	}
	const displayVersion = version.split(/\r?\n/)[0];
	report.ok(`version: ${displayVersion}`);
	if (minimum) {
		if (versionAtLeast(displayVersion, minimum)) {
			report.ok(`version ${displayVersion} >= ${minimum}`);
		} else {
			report.fail(`Crabbox version ${displayVersion} < ${minimum}`);
		}
	}
}

function checkCrabboxBinary(cbox, config, report) {
	console.log("\n── Crabbox binary ──");
	const override = env("PLATFORM_SMOKE_CRABBOX");
	const cboxPath = override || commandPath("crabbox");
	if (!cboxPath) {
		report.fail("crabbox not found on PATH; install with Homebrew or set PLATFORM_SMOKE_CRABBOX");
		return cboxPath;
	}
	if (override) {
		try {
			accessSync(cboxPath, constants.X_OK);
			report.ok(`binary: ${cboxPath}`);
		} catch {
			report.fail(`${cboxPath} is not executable`);
		}
	} else {
		report.ok(`binary: ${cboxPath}`);
	}
	checkCrabboxVersion(cbox, config?.requiredCrabbox?.minVersion, report);
	return cboxPath;
}

function checkHostTools(config, report) {
	console.log("\n── Host tools ──");
	for (const [name, command] of [
		["node", "node --version"],
		["npm", "npm --version"],
		["git", "git --version"],
		["tar", "tar --version"],
	]) {
		const output = shell(command);
		if (!output) {
			report.fail(`${name} not found`);
		} else {
			report.ok(`${name}: ${output.split(/\r?\n/)[0]}`);
		}
	}
	const localNode = shell("node --version");
	const nodeVersion = config?.nodeValidationVersion;
	if (nodeVersion && localNode && versionAtLeast(localNode, nodeVersion)) {
		report.ok(`host Node ${localNode} >= ${nodeVersion}`);
	} else {
		report.fail(`host Node ${localNode || "unknown"} < ${nodeVersion ?? "configured minimum"}`);
	}
	checkAgentBrowserVersion(config?.agentBrowserVersion, report);
}

function macSettings(config, packageName) {
	const user = env("PLATFORM_SMOKE_MAC_USER") || env("USER");
	return {
		user,
		host: setting("PLATFORM_SMOKE_MAC_HOST", config?.macos?.host, "localhost"),
		port: String(setting("PLATFORM_SMOKE_MAC_PORT", config?.macos?.port, 22)),
		workRoot: setting(
			"PLATFORM_SMOKE_MAC_WORK_ROOT",
			config?.macos?.workRoot,
			`/Users/${user}/crabbox/${packageName}`,
		),
	};
}

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

function checkDocker(ubuntuImage, report) {
	console.log("\n── Docker / Ubuntu ──");
	const dockerVersion = shell("docker info --format '{{.ServerVersion}}'");
	if (dockerVersion) {
		report.ok(`Docker ${dockerVersion}`);
	} else {
		report.fail("Docker is not available or not running");
	}
	report.ok(`Ubuntu image: ${ubuntuImage}`);
}

function checkMacSsh(config, packageName, report) {
	console.log("\n── macOS SSH ──");
	const mac = macSettings(config, packageName);
	const probe = shell(
		`ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no -p ${mac.port} ${mac.user}@${mac.host} 'node --version && npm --version && git --version && agent-browser --version'`,
	);
	if (!probe) {
		report.fail(`SSH probe failed for ${mac.user}@${mac.host}`);
		return;
	}
	report.ok(`SSH ${mac.user}@${mac.host}: ${probe.split(/\r?\n/).join(" | ")}`);
	const expectedVersion = config?.agentBrowserVersion;
	if (expectedVersion && !probe.includes(expectedVersion)) {
		report.fail(`macOS SSH agent-browser does not match expected ${expectedVersion}`);
	}
}

function doctorSettings(config) {
	return {
		packageName: config?.packageName ?? "pi-agent-browser-native",
		artifactRoot: config?.artifactRoot ?? ".artifacts/platform-smoke",
		targets: (config?.requiredTargets ?? []).join(", "),
		suites: (config?.requiredSuites ?? []).join(", "),
		agentBrowserVersion: config?.agentBrowserVersion,
	};
}

export async function runDoctor(config) {
	const report = createReporter();
	const settings = doctorSettings(config);
	const { packageName, artifactRoot } = settings;
	console.log("\n── Platform smoke config ──");
	report.ok(`package: ${packageName}`);
	report.ok(`targets: ${settings.targets}`);
	report.ok(`suites: ${settings.suites}`);
	report.ok(`agent-browser baseline: ${settings.agentBrowserVersion ?? "not configured"}`);
	const cbox = env("PLATFORM_SMOKE_CRABBOX") || "crabbox";
	const cboxPath = checkCrabboxBinary(cbox, config, report);
	checkHostTools(config, report);
	console.log("\n── Crabbox providers ──");
	const ubuntuImage = setting(
		"PLATFORM_SMOKE_UBUNTU_IMAGE",
		config?.ubuntuContainerImage,
		DEFAULT_UBUNTU_IMAGE,
	);
	if (cboxPath) {
		checkProviders(cbox, config, { packageName, ubuntuImage }, report);
	}
	if (config.requiredTargets.includes("ubuntu")) {
		checkDocker(ubuntuImage, report);
	}
	if (config.requiredTargets.includes("macos")) {
		checkMacSsh(config, packageName, report);
	}
	checkWindows({
		cbox,
		config,
		packageName,
		agentBrowserVersion: settings.agentBrowserVersion,
		report,
		checkCrabboxProvider,
	});
	checkArtifactRoot(artifactRoot, report);
	console.log("\n── Repository hygiene ──");
	const status = shell("git status --short");
	if (status) {
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
