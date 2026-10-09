import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const DIRECT_IMPORT_BUDGET_MS = 250;

/**
 * One fresh Node import plus synchronous extension-factory registration.
 * CPU intervals enclose the wall clock; resource counters cover the child lifetime.
 * Hardware/load and artifact identity are collected after the timed registration.
 * @typedef {{
 *   events: number, importMs: number, tools: string[], totalMs: number,
 *   diagnostics: {
 *     pid: number, cpuMs: number, mainThreadCpuMs: number,
 *     resources: ReturnType<typeof process.resourceUsage>,
 *     hardware: { availableParallelism: number, logicalCpus: number, memoryBytes: number },
 *     loadAfter: number[], node: { executable: string, version: string, platform: string, arch: string }
 *   },
 *   identity: Awaited<ReturnType<typeof readStartupIdentity>> | { error: string }
 * }} StartupMeasurement
 */

async function fileIdentity(file) {
	return {
		path: String(file),
		sha256: createHash("sha256")
			.update(await readFile(file))
			.digest("hex"),
	};
}

async function readStartupIdentity(entrypoint, cwd) {
	const entrypointPath = resolve(cwd, entrypoint);
	const identity = {
		entrypoint: await fileIdentity(entrypointPath),
		measurementOwner: await fileIdentity(new URL(import.meta.url)),
	};
	let manifestPath;
	try {
		manifestPath = findPackageJSON(
			"@earendil-works/pi-coding-agent",
			pathToFileURL(entrypointPath),
		);
	} catch {
		// An absent optional SDK must not discard the measured source fingerprints.
		return identity;
	}
	if (!manifestPath) {
		return identity;
	}
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	if (
		manifest.name !== "@earendil-works/pi-coding-agent" ||
		typeof manifest.version !== "string" ||
		typeof manifest.bin?.pi !== "string"
	) {
		throw new Error("Invalid selected Pi manifest");
	}
	return {
		...identity,
		host: {
			version: manifest.version,
			manifest: await fileIdentity(manifestPath),
			sdk: await fileIdentity(resolve(dirname(manifestPath), "dist/index.js")),
			cli: await fileIdentity(resolve(dirname(manifestPath), manifest.bin.pi)),
		},
	};
}

/**
 * @param {string} entrypoint
 * @param {string} [cwd]
 * @returns {Promise<StartupMeasurement>}
 */
export async function measureColdStartup(entrypoint, cwd = process.cwd()) {
	const script = `
const cpuStart = process.cpuUsage();
const threadCpuStart = process.threadCpuUsage();
const start = performance.now();
const extension = await import(${JSON.stringify(entrypoint)});
const imported = performance.now();
const registeredEvents = [];
const pi = {
  events: { on(...args) { registeredEvents.push(args); } },
  tools: [],
  on(...args) { registeredEvents.push(args); },
  registerTool(tool) { this.tools.push(tool.name); }
};
extension.default(pi);
const registered = performance.now();
const cpu = process.cpuUsage(cpuStart);
const threadCpu = process.threadCpuUsage(threadCpuStart);
const resources = process.resourceUsage();
const os = process.getBuiltinModule("node:os");
console.log(JSON.stringify({
  events: registeredEvents.length,
  importMs: imported - start,
  tools: pi.tools,
  totalMs: registered - start,
  diagnostics: {
    pid: process.pid,
    cpuMs: (cpu.user + cpu.system) / 1000,
    mainThreadCpuMs: (threadCpu.user + threadCpu.system) / 1000,
    resources,
    hardware: {
      availableParallelism: os.availableParallelism(),
      logicalCpus: os.cpus().length,
      memoryBytes: os.totalmem()
    },
    loadAfter: os.loadavg(),
    node: { executable: process.execPath, version: process.version, platform: process.platform, arch: process.arch }
  }
}));
`;
	const result = await execFile(process.execPath, ["--input-type=module", "-e", script], {
		cwd,
		maxBuffer: 1024 * 1024,
		timeout: 10_000,
	});
	const measurement = JSON.parse(result.stdout.trim());
	try {
		measurement.identity = await readStartupIdentity(entrypoint, cwd);
	} catch (error) {
		// Identity is diagnostic, not an additional import/factory acceptance gate.
		measurement.identity = { error: error?.code ?? "unavailable" };
	}
	return measurement;
}
