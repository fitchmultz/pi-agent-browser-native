/** Thin Crabbox CLI wrapper for cross-platform smoke tests. */

import { spawn } from "node:child_process";

import { CAPABILITY_BASELINE } from "../agent-browser-capability-baseline.mjs";

const DEFAULT_UBUNTU_IMAGE = `pi-agent-browser-native-platform:node24-agent-browser${CAPABILITY_BASELINE.targetVersion}`;

function env(name) {
	return process.env[name] ?? "";
}

export function crabboxBin() {
	return process.env.PLATFORM_SMOKE_CRABBOX || "crabbox";
}

function packageSlug(config = {}) {
	return process.env.PLATFORM_SMOKE_PACKAGE_SLUG || config.packageName || "pi-agent-browser-native";
}

export function describeTarget(targetName, config = {}) {
	const slug = packageSlug(config);
	switch (targetName) {
		case "macos": {
			const user = env("PLATFORM_SMOKE_MAC_USER") || env("USER");
			const host = env("PLATFORM_SMOKE_MAC_HOST") || config.macos?.host || "localhost";
			const port = String(env("PLATFORM_SMOKE_MAC_PORT") || config.macos?.port || 22);
			const workRoot = env("PLATFORM_SMOKE_MAC_WORK_ROOT") || config.macos?.workRoot || `/Users/${user}/crabbox/${slug}`;
			return {
				provider: "ssh",
				crabboxTarget: "macos",
				shell: "posix",
				workRoot,
				args: [
					"--provider", "ssh",
					"--target", "macos",
					"--static-host", host,
					"--static-user", user,
					"--static-port", port,
					"--static-work-root", workRoot,
				],
			};
		}
		case "ubuntu": {
			const image = env("PLATFORM_SMOKE_UBUNTU_IMAGE") || config.ubuntuContainerImage || DEFAULT_UBUNTU_IMAGE;
			return {
				provider: "local-container",
				crabboxTarget: "linux",
				shell: "posix",
				image,
				workRoot: config.localContainer?.workRoot || "/work/crabbox",
				args: [
					"--provider", "local-container",
					"--target", "linux",
					"--local-container-image", image,
				],
			};
		}
		case "windows-native": {
			const vm = env("PLATFORM_SMOKE_WINDOWS_VM") || config.windowsParallels?.sourceVm || "pi-extension-windows-template";
			const snapshot = env("PLATFORM_SMOKE_WINDOWS_SNAPSHOT") || config.windowsParallels?.snapshot || "crabbox-ready";
			const user = env("PLATFORM_SMOKE_WINDOWS_USER") || config.windowsParallels?.user || env("USER");
			const workRoot = env("PLATFORM_SMOKE_WINDOWS_WORK_ROOT") || config.windowsParallels?.workRoot || `C:\\crabbox\\${slug}`;
			return {
				provider: "parallels",
				crabboxTarget: "windows",
				shell: "powershell",
				workRoot,
				windowsMode: "normal",
				sourceVm: vm,
				snapshot,
				args: [
					"--provider", "parallels",
					"--target", "windows",
					"--windows-mode", "normal",
					"--parallels-source", vm,
					"--parallels-source-snapshot", snapshot,
					"--parallels-user", user,
					"--parallels-work-root", workRoot,
				],
			};
		}
		default:
			throw new Error(`unknown platform smoke target: ${targetName}`);
	}
}

export function buildTargetBaseArgs(targetName, config = {}) {
	return describeTarget(targetName, config).args;
}

export function leaseIdFor(targetName, slug) {
	if (targetName === "macos") return "static_localhost";
	return slug;
}

function parseLeaseId(text) {
	return text.match(/\bleased\s+(\S+)/)?.[1]
		?? text.match(/\blease=(\S+)/)?.[1]
		?? null;
}

export function execCrabbox(args, options = {}) {
	return new Promise((resolvePromise) => {
		const child = spawn(crabboxBin(), args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, CRABBOX_SYNC_GIT_SEED: "false", ...options.env },
		});
		const stdout = [];
		const stderr = [];
		let timeout;
		let killTimeout;
		if (options.timeout) {
			timeout = setTimeout(() => {
				stderr.push(Buffer.from(`\n[platform-smoke] crabbox timed out after ${options.timeout}ms\n`));
				try { child.kill("SIGTERM"); } catch {}
				killTimeout = setTimeout(() => {
					try { child.kill("SIGKILL"); } catch {}
				}, 10_000);
			}, options.timeout);
		}
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.on("error", (error) => {
			if (timeout) clearTimeout(timeout);
			if (killTimeout) clearTimeout(killTimeout);
			resolvePromise({ stdout: Buffer.concat(stdout).toString(), stderr: `${Buffer.concat(stderr).toString()}${error.message}\n`, code: 1, signal: null });
		});
		child.on("close", (code, signal) => {
			if (timeout) clearTimeout(timeout);
			if (killTimeout) clearTimeout(killTimeout);
			resolvePromise({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), code: code ?? (signal ? 1 : 0), signal });
		});
	});
}

function isRetryableWarmupFailure(targetName, result) {
	if (targetName !== "windows-native" || result.code === 0) return false;
	return /Could not create a linked clone of the virtual hard disk|due to an internal error|context canceled|timed out after 300000ms/i.test(`${result.stdout}\n${result.stderr}`);
}

export async function warmupLease(targetName, slug, config = {}) {
	const args = ["warmup", ...buildTargetBaseArgs(targetName, config), "--slug", slug, "--keep"];
	let result;
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		console.log(`  [crabbox] ${args.join(" ")}${attempt > 1 ? ` (retry ${attempt})` : ""}`);
		result = await execCrabbox(args, { timeout: 300_000 });
		if (!isRetryableWarmupFailure(targetName, result)) break;
		await cleanupStaleTargetState(targetName, config);
	}
	return {
		...result,
		ok: result.code === 0,
		leaseId: parseLeaseId(`${result.stdout}\n${result.stderr}`) ?? leaseIdFor(targetName, slug),
	};
}

export async function runOnLease(targetName, leaseId, command, options = {}) {
	const args = ["run", ...buildTargetBaseArgs(targetName, options.config ?? {}), "--id", leaseId];
	for (const name of options.allowEnv ?? []) {
		args.push("--allow-env", name);
	}
	if (options.sync === false) args.push("--no-sync");
	else args.push("--fresh-sync");
	args.push("--shell", command);
	console.log(`  [crabbox] run ${targetName} ${options.sync === false ? "--no-sync" : "--fresh-sync"}`);
	return execCrabbox(args, { timeout: options.timeout ?? 900_000 });
}

export async function stopLease(targetName, leaseId, config = {}) {
	const args = ["stop", ...buildTargetBaseArgs(targetName, config), "--id", leaseId];
	console.log(`  [crabbox] ${args.join(" ")}`);
	return execCrabbox(args, { timeout: 90_000 });
}

export async function cleanupStaleTargetState(targetName, config = {}) {
	if (targetName === "macos") return null;
	const args = ["cleanup", ...buildTargetBaseArgs(targetName, config)];
	console.log(`  [crabbox] ${args.join(" ")}`);
	return execCrabbox(args, { timeout: 120_000 });
}
