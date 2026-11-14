import { execFile as execFileCallback } from "node:child_process";
import { hash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Check } from "typebox/value";

const execFile = promisify(execFileCallback);

export const DIRECT_IMPORT_BUDGET_MS = 250;

/** @satisfies {Record<keyof ReturnType<typeof process.resourceUsage>, import("typebox").TNumber>} */
const resourceProperties = {
	fsRead: Type.Number(),
	fsWrite: Type.Number(),
	involuntaryContextSwitches: Type.Number(),
	ipcReceived: Type.Number(),
	ipcSent: Type.Number(),
	majorPageFault: Type.Number(),
	maxRSS: Type.Number(),
	minorPageFault: Type.Number(),
	sharedMemorySize: Type.Number(),
	signalsCount: Type.Number(),
	swappedOut: Type.Number(),
	systemCPUTime: Type.Number(),
	unsharedDataSize: Type.Number(),
	unsharedStackSize: Type.Number(),
	userCPUTime: Type.Number(),
	voluntaryContextSwitches: Type.Number(),
};
const measurementSchema = Type.Object({
	events: Type.Number(),
	importMs: Type.Number(),
	tools: Type.Array(Type.String()),
	totalMs: Type.Number(),
	diagnostics: Type.Object({
		pid: Type.Number(),
		cpuMs: Type.Number(),
		mainThreadCpuMs: Type.Number(),
		resources: Type.Object(resourceProperties),
		hardware: Type.Object({
			availableParallelism: Type.Number(),
			logicalCpus: Type.Number(),
			memoryBytes: Type.Number(),
		}),
		loadAfter: Type.Array(Type.Number()),
		node: Type.Object({
			executable: Type.String(),
			version: Type.String(),
			platform: Type.String(),
			arch: Type.String(),
		}),
	}),
});
/**
 * Fresh Node import and synchronous factory registration. Identity is collected after timing.
 * @typedef {import("typebox").Static<typeof measurementSchema> & { identity: Awaited<ReturnType<typeof readStartupIdentity>> | { error: string } }} StartupMeasurement
 */

/** @param {string | URL} file */
async function fileIdentity(file) {
	return {
		path: String(file),
		sha256: hash("sha256", await readFile(file), "hex"),
	};
}

/** @param {string} entrypoint
 * @param {string} cwd
 */
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
	if (manifestPath === undefined || manifestPath.length === 0) {
		return identity;
	}
	/** @type {unknown} */
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	if (
		!Check(
			Type.Object({
				name: Type.Literal("@earendil-works/pi-coding-agent"),
				version: Type.String(),
				bin: Type.Object({ pi: Type.String() }),
			}),
			manifest,
		)
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
	/** @type {unknown} */
	const measurement = JSON.parse(result.stdout.trim());
	if (!Check(measurementSchema, measurement)) {
		throw new Error("Invalid startup measurement output.");
	}
	let identity;
	try {
		identity = await readStartupIdentity(entrypoint, cwd);
	} catch (error) {
		// Identity is diagnostic, not an additional import/factory acceptance gate.
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		const diagnosticCode = String(code);
		identity = { error: code === null || code === undefined ? "unavailable" : diagnosticCode };
	}
	return { ...measurement, identity };
}
