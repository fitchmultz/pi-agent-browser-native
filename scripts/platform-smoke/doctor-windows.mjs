/** Disposable Windows/Parallels doctor probes with native lease cleanup receipts. */
import { execFileSync } from "node:child_process";
import { buildTargetBaseArgs, leaseIdFromWarmup } from "./crabbox-runner.mjs";
import {
	checkCrabboxProvider,
	commandPath,
	isConfigObject,
	setting,
	shell,
} from "./doctor-support.mjs";

/** @import { PlatformSmokeConfig } from "../../platform-smoke.config.mjs" */
/** @import { DoctorReport } from "./doctor-support.mjs" */

/** @param {unknown} error */
function failedCrabboxReceipt(error) {
	if (!(error instanceof Error)) {
		return { ok: false, stdout: "", stderr: String(error) };
	}
	const stdout = "stdout" in error ? error.stdout : undefined;
	const stderr = "stderr" in error ? error.stderr : undefined;
	const stdoutText = String(stdout);
	const stderrText = String(stderr);
	return {
		ok: false,
		stdout: stdout === null || stdout === undefined ? "" : stdoutText,
		stderr: stderr === null || stderr === undefined ? error.message : stderrText,
	};
}

/** @param {string} cbox
 * @param {readonly string[]} args
 * @param {number} [timeout]
 */
function crabbox(cbox, args, timeout = 300_000) {
	try {
		return {
			ok: true,
			stdout: execFileSync(cbox, args, {
				timeout,
				stdio: "pipe",
				env: { ...process.env, CRABBOX_SYNC_GIT_SEED: "false" },
			}).toString(),
			stderr: "",
		};
	} catch (error) {
		return failedCrabboxReceipt(error);
	}
}

const PROBE_SCRIPT = `$ErrorActionPreference = "Stop"
$cmd = Get-Command "agent-browser.cmd" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $cmd) { throw "agent-browser.cmd missing" }
$version = & $cmd.Source --version
Write-Output "PLATFORM_DOCTOR_AGENT_BROWSER_PATH=$($cmd.Source)"
Write-Output "PLATFORM_DOCTOR_AGENT_BROWSER_VERSION=$version"
$roots = @((Join-Path $env:USERPROFILE ".agent-browser\\browsers"), "C:\\WINDOWS\\system32\\config\\systemprofile\\.agent-browser\\browsers")
$chrome = Get-ChildItem -Path $roots -Recurse -Filter chrome.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $chrome) { throw "agent-browser browser cache missing chrome.exe" }
Write-Output "PLATFORM_DOCTOR_AGENT_BROWSER_CHROME=$($chrome.FullName)"`;

/** @param {Readonly<ReturnType<typeof crabbox>>} run
 * @param {string | undefined} expectedVersion
 */
function probeOutcome(run, expectedVersion) {
	if (!run.ok) {
		return {
			ok: false,
			message: `probe failed: ${(run.stderr.length > 0 ? run.stderr : run.stdout).slice(-700)}`,
		};
	}
	const output = run.stdout;
	/** @param {string} name */
	const marker = (name) =>
		output.match(new RegExp(`^PLATFORM_DOCTOR_AGENT_BROWSER_${name}=(.*)$`, "m"))?.[1]?.trim() ??
		"";
	const versionLine = marker("VERSION");
	const pathLine = marker("PATH");
	const chromeLine = marker("CHROME");
	if (versionLine !== `agent-browser ${String(expectedVersion)}`) {
		return {
			ok: false,
			message: `expected agent-browser ${String(expectedVersion)}, got ${versionLine.length > 0 ? versionLine : "missing version"}`,
		};
	}
	if (pathLine.length === 0 || chromeLine.length === 0) {
		return { ok: false, message: "agent-browser path or browser cache marker missing" };
	}
	return { ok: true, message: `${versionLine} | ${pathLine} | ${chromeLine}` };
}

/** @param {string} cbox
 * @param {Partial<PlatformSmokeConfig>} config
 * @param {string | undefined} expectedVersion
 */
export function disposableWindowsAgentBrowserProbe(cbox, config, expectedVersion) {
	const slug = "piab-doctor-agent-browser";
	const baseArgs = buildTargetBaseArgs("windows-native", config);
	const warm = crabbox(
		cbox,
		["warmup", ...baseArgs, "--slug", slug, "--keep", "--reclaim"],
		300_000,
	);
	const leaseId = leaseIdFromWarmup(warm, slug);
	if (!warm.ok) {
		return {
			ok: false,
			message: `warmup failed: ${(warm.stderr.length > 0 ? warm.stderr : warm.stdout).slice(-500)}`,
		};
	}
	let outcome;
	try {
		const probeCommand = `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(PROBE_SCRIPT, "utf16le").toString("base64")}`;
		outcome = probeOutcome(
			crabbox(
				cbox,
				["run", ...baseArgs, "--id", leaseId, "--no-sync", "--shell", probeCommand],
				180_000,
			),
			expectedVersion,
		);
	} finally {
		const stop = crabbox(cbox, ["stop", ...baseArgs, "--id", leaseId], 90_000);
		if (!stop.ok) {
			const prior = outcome?.ok === false ? `; prior result: ${outcome.message}` : "";
			outcome = {
				ok: false,
				message: `cleanup failed: ${(stop.stderr.length > 0 ? stop.stderr : stop.stdout).slice(-500)}${prior}`,
			};
		}
	}
	return outcome;
}

/** @param {string} vmName
 * @param {string} snapshot
 * @param {DoctorReport} report
 */
function checkSnapshot(vmName, snapshot, report) {
	const snapshotsJson = shell(
		`prlctl snapshot-list "${vmName.replace(/"/g, '\\"')}" -j 2>/dev/null`,
	);
	/** @type {[string, unknown] | undefined} */
	let snapshotMatch;
	try {
		/** @type {unknown} */
		const snapshots = JSON.parse(snapshotsJson ?? "{}");
		/** @type {[string, unknown][]} */
		const entries = Object.entries(snapshots ?? {});
		snapshotMatch = entries.find(
			([id, data]) => id === snapshot || (isConfigObject(data) && data.name === snapshot),
		);
	} catch {
		// Invalid native snapshot output falls through to the explicit failure below.
	}
	if (!snapshotMatch) {
		report.fail(`snapshot ${snapshot} not found on ${vmName}`);
		return;
	}
	report.ok(`snapshot ${snapshot} found`);
	const data = snapshotMatch[1];
	const snapshotState = isConfigObject(data) ? data.state : undefined;
	const stateText = String(snapshotState);
	if (snapshotState === "poweroff") {
		report.ok(`snapshot ${snapshot} state is poweroff`);
	} else {
		report.fail(
			`snapshot ${snapshot} must be poweroff; current snapshot state: ${snapshotState === null || snapshotState === undefined ? "unknown" : stateText}`,
		);
	}
}

/** @param {Partial<PlatformSmokeConfig>} config
 * @param {string} packageName
 */
function windowsSettings(config, packageName) {
	return {
		sourceVm: setting(
			"PLATFORM_SMOKE_WINDOWS_VM",
			config.windowsParallels?.sourceVm,
			"pi-extension-windows-template",
		),
		snapshot: setting(
			"PLATFORM_SMOKE_WINDOWS_SNAPSHOT",
			config.windowsParallels?.snapshot,
			"crabbox-ready",
		),
		user: setting(
			"PLATFORM_SMOKE_WINDOWS_USER",
			config.windowsParallels?.user,
			process.env.USER ?? "",
		),
		workRoot: setting(
			"PLATFORM_SMOKE_WINDOWS_WORK_ROOT",
			config.windowsParallels?.workRoot,
			`C:\\crabbox\\${packageName}`,
		),
	};
}

/** @param {Readonly<ReturnType<typeof windowsSettings>>} windows
 * @param {DoctorReport} report
 */
function checkWindowsTemplate(windows, report) {
	const vmName = windows.sourceVm;
	const list = shell("prlctl list -a --no-header 2>/dev/null");
	if (list === null || list.length === 0) {
		report.fail("prlctl list returned no VMs");
		return false;
	}
	if (!list.includes(vmName)) {
		report.fail(`Windows VM ${vmName} not found`);
		return false;
	}
	report.ok(`Windows VM ${vmName} found`);
	const status = shell(`prlctl status "${vmName.replace(/"/g, '\\"')}" 2>/dev/null`);
	if (/\bstopped\b/i.test(status ?? "")) {
		report.ok(`Windows source VM ${vmName} is stopped`);
	} else {
		report.fail(
			`Windows source VM ${vmName} must be stopped for forkable snapshot use; current status: ${status ?? "unknown"}`,
		);
	}
	checkSnapshot(vmName, windows.snapshot, report);
	return true;
}

/** @param {{readonly cbox: string; readonly config: Partial<PlatformSmokeConfig>; readonly packageName: string; readonly agentBrowserVersion: string | undefined; readonly report: DoctorReport}} options */
export function checkWindows({ cbox, config, packageName, agentBrowserVersion, report }) {
	console.log("\n── Windows native / Parallels ──");
	if (!(config.requiredTargets ?? []).includes("windows-native")) {
		report.warn("windows-native not selected (best-effort); setup not checked, not a pass");
		return;
	}
	const prlctl = commandPath("prlctl");
	if (prlctl === null || prlctl.length === 0) {
		report.fail("prlctl not found");
		return;
	}
	report.ok("prlctl found");
	const windows = windowsSettings(config, packageName);
	const vmName = windows.sourceVm;
	if (!checkWindowsTemplate(windows, report)) {
		return;
	}
	checkCrabboxProvider(
		cbox,
		[
			"--provider",
			"parallels",
			"--target",
			"windows",
			"--windows-mode",
			"normal",
			"--parallels-source",
			vmName,
			"--parallels-source-snapshot",
			windows.snapshot,
			"--parallels-user",
			windows.user,
			"--parallels-work-root",
			windows.workRoot,
		],
		"windows parallels",
		report,
	);
	const probe = disposableWindowsAgentBrowserProbe(
		cbox,
		{ ...config, windowsParallels: { ...config.windowsParallels, ...windows } },
		agentBrowserVersion,
	);
	if (probe.ok) {
		report.ok(`Windows disposable agent-browser: ${probe.message}`);
	} else {
		report.fail(`Windows disposable agent-browser probe failed: ${probe.message}`);
	}
}
