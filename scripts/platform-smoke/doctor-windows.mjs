/** Disposable Windows/Parallels doctor probes with native lease cleanup receipts. */
import { execFileSync } from "node:child_process";
import { buildTargetBaseArgs } from "./crabbox-runner.mjs";
import { commandPath, setting, shell } from "./doctor-support.mjs";

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
		return {
			ok: false,
			stdout: error.stdout?.toString?.() ?? "",
			stderr: error.stderr?.toString?.() ?? error.message,
		};
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

function probeOutcome(run, expectedVersion) {
	if (!run.ok) {
		return { ok: false, message: `probe failed: ${(run.stderr || run.stdout).slice(-700)}` };
	}
	const output = run.stdout;
	const marker = (name) =>
		output.match(new RegExp(`^PLATFORM_DOCTOR_AGENT_BROWSER_${name}=(.*)$`, "m"))?.[1]?.trim() ??
		"";
	const versionLine = marker("VERSION");
	const pathLine = marker("PATH");
	const chromeLine = marker("CHROME");
	if (versionLine !== `agent-browser ${expectedVersion}`) {
		return {
			ok: false,
			message: `expected agent-browser ${expectedVersion}, got ${versionLine || "missing version"}`,
		};
	}
	if (!pathLine || !chromeLine) {
		return { ok: false, message: "agent-browser path or browser cache marker missing" };
	}
	return { ok: true, message: `${versionLine} | ${pathLine} | ${chromeLine}` };
}

function leaseIdFromWarmup(warm, fallback) {
	const text = `${warm.stdout}\n${warm.stderr}`;
	return text.match(/\bleased\s+(\S+)/)?.[1] ?? text.match(/\blease=(\S+)/)?.[1] ?? fallback;
}

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
		return { ok: false, message: `warmup failed: ${(warm.stderr || warm.stdout).slice(-500)}` };
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
				message: `cleanup failed: ${(stop.stderr || stop.stdout).slice(-500)}${prior}`,
			};
		}
	}
	return outcome;
}

function checkSnapshot(vmName, snapshot, report) {
	const snapshotsJson = shell(
		`prlctl snapshot-list "${vmName.replace(/"/g, '\\"')}" -j 2>/dev/null`,
	);
	let snapshotMatch = null;
	try {
		const snapshots = JSON.parse(snapshotsJson ?? "{}");
		snapshotMatch = Object.entries(snapshots).find(
			([id, data]) => id === snapshot || data?.name === snapshot,
		);
	} catch {
		// Invalid native snapshot output falls through to the explicit failure below.
	}
	if (!snapshotMatch) {
		report.fail(`snapshot ${snapshot} not found on ${vmName}`);
		return;
	}
	report.ok(`snapshot ${snapshot} found`);
	const snapshotState = snapshotMatch[1]?.state ?? "unknown";
	if (snapshotState === "poweroff") {
		report.ok(`snapshot ${snapshot} state is poweroff`);
	} else {
		report.fail(`snapshot ${snapshot} must be poweroff; current snapshot state: ${snapshotState}`);
	}
}

function windowsSettings(config, packageName) {
	return {
		sourceVm: setting(
			"PLATFORM_SMOKE_WINDOWS_VM",
			config?.windowsParallels?.sourceVm,
			"pi-extension-windows-template",
		),
		snapshot: setting(
			"PLATFORM_SMOKE_WINDOWS_SNAPSHOT",
			config?.windowsParallels?.snapshot,
			"crabbox-ready",
		),
		user: setting(
			"PLATFORM_SMOKE_WINDOWS_USER",
			config?.windowsParallels?.user,
			process.env.USER ?? "",
		),
		workRoot: setting(
			"PLATFORM_SMOKE_WINDOWS_WORK_ROOT",
			config?.windowsParallels?.workRoot,
			`C:\\crabbox\\${packageName}`,
		),
	};
}

function checkWindowsTemplate(windows, report) {
	const vmName = windows.sourceVm;
	const list = shell("prlctl list -a --no-header 2>/dev/null");
	if (!list) {
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

export function checkWindows({
	cbox,
	config,
	packageName,
	agentBrowserVersion,
	report,
	checkCrabboxProvider,
}) {
	console.log("\n── Windows native / Parallels ──");
	if (!(config?.requiredTargets ?? []).includes("windows-native")) {
		report.warn("windows-native not selected (best-effort); setup not checked, not a pass");
		return;
	}
	if (!commandPath("prlctl")) {
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
		{ ...config, windowsParallels: { ...config?.windowsParallels, ...windows } },
		agentBrowserVersion,
	);
	if (probe.ok) {
		report.ok(`Windows disposable agent-browser: ${probe.message}`);
	} else {
		report.fail(`Windows disposable agent-browser probe failed: ${probe.message}`);
	}
}
