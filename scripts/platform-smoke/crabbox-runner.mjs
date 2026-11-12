/** Thin Crabbox CLI wrapper for cross-platform smoke tests. */

import { spawn } from "node:child_process";

import { DEFAULT_UBUNTU_IMAGE } from "../../platform-smoke.config.mjs";

/** @typedef {import("../../platform-smoke.config.mjs").PlatformSmokeConfig} PlatformSmokeConfig */
/** @typedef {{readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string; readonly stderr: string}} ProcessResult */
/** @typedef {{readonly provider: "ssh"; readonly crabboxTarget: "macos"; readonly shell: "posix"; readonly workRoot: string; readonly args: readonly string[]}} MacTarget */
/** @typedef {{readonly provider: "local-container"; readonly crabboxTarget: "linux"; readonly shell: "posix"; readonly image: string; readonly workRoot: string; readonly args: readonly string[]}} UbuntuTarget */

/** @param {string} name */
export function env(name) {
	return process.env[name] ?? "";
}

export function crabboxBin() {
	const value = env("PLATFORM_SMOKE_CRABBOX");
	return value.length > 0 ? value : "crabbox";
}

/** @param {Partial<PlatformSmokeConfig>} [config] */
function packageSlug(config = {}) {
	return targetSetting(
		"PLATFORM_SMOKE_PACKAGE_SLUG",
		config.packageName,
		"pi-agent-browser-native",
	);
}

/** @template {string | number} Value
 * @param {string} name
 * @param {Value | undefined} configured
 * @param {Value} fallback
 * @returns {Value | string}
 */
export function targetSetting(name, configured, fallback) {
	const override = env(name);
	if (override.length > 0) {
		return override;
	}
	if (
		configured === undefined ||
		configured === "" ||
		configured === 0 ||
		Number.isNaN(configured)
	) {
		return fallback;
	}
	return configured;
}

/** @param {Partial<PlatformSmokeConfig>} config
 * @returns {MacTarget}
 */
function describeMacTarget(config) {
	const slug = packageSlug(config);
	const user = targetSetting("PLATFORM_SMOKE_MAC_USER", undefined, env("USER"));
	const host = targetSetting("PLATFORM_SMOKE_MAC_HOST", config.macos?.host, "localhost");
	const port = String(targetSetting("PLATFORM_SMOKE_MAC_PORT", config.macos?.port, 22));
	const workRoot = targetSetting(
		"PLATFORM_SMOKE_MAC_WORK_ROOT",
		config.macos?.workRoot,
		`/Users/${user}/crabbox/${slug}`,
	);
	return {
		provider: "ssh",
		crabboxTarget: "macos",
		shell: "posix",
		workRoot,
		args: [
			"--provider",
			"ssh",
			"--target",
			"macos",
			"--static-host",
			host,
			"--static-user",
			user,
			"--static-port",
			port,
			"--static-work-root",
			workRoot,
		],
	};
}

/** @param {Partial<PlatformSmokeConfig>} config
 * @returns {UbuntuTarget}
 */
function describeUbuntuTarget(config) {
	const image = targetSetting(
		"PLATFORM_SMOKE_UBUNTU_IMAGE",
		config.ubuntuContainerImage,
		DEFAULT_UBUNTU_IMAGE,
	);
	return {
		provider: "local-container",
		crabboxTarget: "linux",
		shell: "posix",
		image,
		workRoot:
			config.localContainer?.workRoot === undefined || config.localContainer.workRoot.length === 0
				? "/work/crabbox"
				: config.localContainer.workRoot,
		args: ["--provider", "local-container", "--target", "linux", "--local-container-image", image],
	};
}

/** @param {string} targetName
 * @param {Partial<PlatformSmokeConfig>} [config]
 */
export function describeTarget(targetName, config = {}) {
	switch (targetName) {
		case "macos":
			return describeMacTarget(config);
		case "ubuntu":
			return describeUbuntuTarget(config);
		default:
			throw new Error(`unknown platform smoke target: ${targetName}`);
	}
}

/** @param {string} targetName
 * @param {Partial<PlatformSmokeConfig>} [config]
 */
export function buildTargetBaseArgs(targetName, config = {}) {
	return describeTarget(targetName, config).args;
}

/** @param {string} targetName
 * @param {string} slug
 */
export function leaseIdFor(targetName, slug) {
	if (targetName === "macos") {
		return "static_localhost";
	}
	return slug;
}

/** @param {Pick<ProcessResult, "stdout" | "stderr">} warmup
 * @param {string} fallback
 */
export function leaseIdFromWarmup(warmup, fallback) {
	const text = `${warmup.stdout}\n${warmup.stderr}`;
	return text.match(/\bleased\s+(\S+)/)?.[1] ?? text.match(/\blease=(\S+)/)?.[1] ?? fallback;
}

/** @param {readonly string[]} args
 * @param {{readonly env?: NodeJS.ProcessEnv; readonly timeout?: number}} [options]
 * @returns {Promise<ProcessResult>}
 */
export function execCrabbox(args, options = {}) {
	return new Promise((resolvePromise) => {
		const child = spawn(crabboxBin(), args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, CRABBOX_SYNC_GIT_SEED: "false", ...options.env },
		});
		/** @type {Buffer[]} */
		const stdout = [];
		/** @type {Buffer[]} */
		const stderr = [];
		/** @type {NodeJS.Timeout | undefined} */
		let timeout;
		/** @type {NodeJS.Timeout | undefined} */
		let killTimeout;
		const timeoutEnabled = Boolean(options.timeout);
		if (timeoutEnabled) {
			timeout = setTimeout(() => {
				stderr.push(
					Buffer.from(`\n[platform-smoke] crabbox timed out after ${String(options.timeout)}ms\n`),
				);
				try {
					child.kill("SIGTERM");
				} catch {
					// A concurrently exited child needs no signal; its close/error receipt settles the run.
				}
				killTimeout = setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						// A concurrently exited child needs no signal; its close/error receipt settles the run.
					}
				}, 10_000);
			}, options.timeout);
		}
		child.stdout.on("data", (/** @type {Buffer} */ chunk) => stdout.push(chunk));
		child.stderr.on("data", (/** @type {Buffer} */ chunk) => stderr.push(chunk));
		child.on("error", (error) => {
			if (timeout) {
				clearTimeout(timeout);
			}
			if (killTimeout) {
				clearTimeout(killTimeout);
			}
			resolvePromise({
				stdout: Buffer.concat(stdout).toString(),
				stderr: `${Buffer.concat(stderr).toString()}${error.message}\n`,
				code: 1,
				signal: null,
			});
		});
		child.on("close", (code, signal) => {
			if (timeout) {
				clearTimeout(timeout);
			}
			if (killTimeout) {
				clearTimeout(killTimeout);
			}
			resolvePromise({
				stdout: Buffer.concat(stdout).toString(),
				stderr: Buffer.concat(stderr).toString(),
				code: code ?? (signal === null ? 0 : 1),
				signal,
			});
		});
	});
}

/** @param {string} targetName
 * @param {string} slug
 * @param {Partial<PlatformSmokeConfig>} [config]
 */
export async function warmupLease(targetName, slug, config = {}) {
	const args = ["warmup", ...buildTargetBaseArgs(targetName, config), "--slug", slug, "--keep"];
	console.log(`  [crabbox] ${args.join(" ")}`);
	const result = await execCrabbox(args, { timeout: 300_000 });
	return {
		...result,
		ok: result.code === 0,
		leaseId: leaseIdFromWarmup(result, leaseIdFor(targetName, slug)),
	};
}

/** @param {string} targetName
 * @param {string} leaseId
 * @param {string} command
 * @param {{readonly config?: Partial<PlatformSmokeConfig>; readonly allowEnv?: readonly string[]; readonly sync?: boolean | undefined; readonly timeout?: number}} [options]
 */
export async function runOnLease(targetName, leaseId, command, options = {}) {
	const args = ["run", ...buildTargetBaseArgs(targetName, options.config ?? {}), "--id", leaseId];
	for (const name of options.allowEnv ?? []) {
		args.push("--allow-env", name);
	}
	if (options.sync === false) {
		args.push("--no-sync");
	} else {
		args.push("--fresh-sync");
	}
	args.push("--shell", command);
	console.log(
		`  [crabbox] run ${targetName} ${options.sync === false ? "--no-sync" : "--fresh-sync"}`,
	);
	return execCrabbox(args, { timeout: options.timeout ?? 900_000 });
}

/** @param {string} targetName
 * @param {string} leaseId
 * @param {Partial<PlatformSmokeConfig>} [config]
 */
export async function stopLease(targetName, leaseId, config = {}) {
	const args = ["stop", ...buildTargetBaseArgs(targetName, config), "--id", leaseId];
	console.log(`  [crabbox] ${args.join(" ")}`);
	return execCrabbox(args, { timeout: 90_000 });
}

/** @param {string} targetName
 * @param {Partial<PlatformSmokeConfig>} [config]
 */
export async function cleanupStaleTargetState(targetName, config = {}) {
	if (targetName === "macos") {
		return null;
	}
	const args = ["cleanup", ...buildTargetBaseArgs(targetName, config)];
	console.log(`  [crabbox] ${args.join(" ")}`);
	return execCrabbox(args, { timeout: 120_000 });
}
