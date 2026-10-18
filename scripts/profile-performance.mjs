#!/usr/bin/env node
/**
 * Purpose: Measure fixed CPU/scaling workloads through compiled production owners.
 * Responsibilities: Warm the owners, consume and validate outputs, report raw wall/CPU/memory samples and input identity.
 * Scope: Opt-in warm-path diagnostics, not startup profiling or a timing acceptance gate.
 * Usage: Build the target first, then `node --expose-gc scripts/profile-performance.mjs --root <repo> --samples 5 > report.json`.
 * Invariants/Assumptions: No browser, network, Pi, npm, or subprocess work; fixtures and validation are outside timed regions.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { cpus, loadavg, totalmem } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WARMUPS = 2;
const MANIFEST_LIMIT = 100;
const JOURNAL_FIELDS = [
	["type"],
	["id"],
	["parentId"],
	["timestamp"],
	["version"],
	["customType"],
	["data", "event", "version"],
	["data", "snapshot", "id"],
	["message", "toolName"],
	["message", "details", "browserEventVersion"],
	["message", "details", "sessionName"],
	["message", "details", "artifactManifest", "version"],
	["message", "details", "electron", "action"],
];

function options() {
	const { values } = parseArgs({
		options: {
			samples: { type: "string", default: "5" },
			root: { type: "string", default: DEFAULT_ROOT },
			help: { type: "boolean", default: false },
		},
	});
	if (
		!/^[0-9]+$/.test(values.samples) ||
		!Number.isSafeInteger(Number(values.samples)) ||
		Number(values.samples) < 1
	) {
		throw new Error("--samples requires a positive safe integer.");
	}
	return { root: values.root, samples: Number(values.samples), help: values.help };
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

async function treeIdentity(directory) {
	const entries = await readdir(directory, { recursive: true, withFileTypes: true });
	const files = entries
		.filter((entry) => entry.isFile() && /\.(?:ts|js|json)$/.test(entry.name))
		.map((entry) => resolve(entry.parentPath, entry.name))
		.sort();
	const digest = createHash("sha256");
	for (const file of files) {
		digest.update(relative(directory, file).replaceAll("\\", "/")).update("\0");
		// Sequential reads bound memory and give the digest a deterministic file order.
		// oxlint-disable-next-line no-await-in-loop
		digest.update(await readFile(file)).update("\0");
	}
	return { directory, fileCount: files.length, sha256: digest.digest("hex") };
}

function fixtureIdentity(value) {
	const serialized = typeof value === "string" ? value : JSON.stringify(value);
	return { sha256: sha256(serialized), utf8Bytes: Buffer.byteLength(serialized) };
}

function redactionWorkload(redactSensitiveText) {
	const bytes = 1024 * 1024;
	const phrase = "Ordinary documentation with helpful words and numbers 1234.\n";
	const prose = phrase.repeat(Math.ceil(bytes / phrase.length)).slice(0, bytes);
	const input = `${prose}Payload: {"label":"harmless","apiKey":"synthetic-credential"}`;
	const expected = `${prose}Payload: {"label":"harmless","apiKey":"[REDACTED]"}`;
	return {
		name: "redact-prose-1mib",
		fixture: { proseBytes: bytes, ...fixtureIdentity(input) },
		run: () => redactSensitiveText(input),
		verify(output) {
			assert.equal(output, expected);
			return { outputChars: output.length, prosePreserved: true, credentialRedacted: true };
		},
	};
}

function snapshotWorkload(formatSnapshotSummary) {
	const count = 20_000;
	const refs = Object.fromEntries(
		Array.from({ length: count }, (_, index) => [
			`e${count - index}`,
			{ role: index % 5 === 0 ? "button" : "link", name: `Visible control ${count - index}` },
		]),
	);
	const snapshot = Array.from(
		{ length: count },
		(_, index) =>
			`- ${index % 5 === 0 ? "button" : "link"} "Visible control ${count - index}" [ref=e${count - index}]`,
	).join("\n");
	const input = { origin: "https://docs.example.test/", snapshot, refs };
	return {
		name: "snapshot-summary-20k-refs",
		fixture: { refs: count, ...fixtureIdentity(input) },
		run: () => formatSnapshotSummary(input),
		verify(output) {
			assert.equal(output, `Snapshot: ${count} refs on https://docs.example.test/`);
			return { summary: output };
		},
	};
}

function observationWorkload(projectAgentBrowserObservation) {
	const count = 10_000;
	const recovery = {
		id: "refresh-interactive-refs",
		tool: "agent_browser",
		params: { args: ["--session", "benchmark", "snapshot", "-i"] },
		reason: "Refresh interactive refs before another action.",
		safety: "Read-only.",
	};
	const input = {
		batchSteps: [
			{
				index: 0,
				success: true,
				data: Array.from({ length: count }, (_, index) => ({
					title: `Result ${index}`,
					body: `Visible documentation row ${index}.`,
					metadata: { count: index, token: "synthetic-row-credential" },
				})),
				warnings: ["password=synthetic-warning-credential"],
				nextActions: [recovery],
				summary: `Found ${count} entries`,
			},
		],
	};
	return {
		name: "batch-metadata-10k-rows",
		fixture: { batchSteps: 1, discardedRows: count, ...fixtureIdentity(input) },
		run: () => projectAgentBrowserObservation(input, true),
		verify(output) {
			assert.equal(output.success, true);
			assert.equal(output.resultCategory, "success");
			assert.equal(output.batchSteps.length, 1);
			const step = output.batchSteps[0];
			assert.equal(Object.hasOwn(step, "data"), false);
			assert.equal(step.index, 0);
			assert.deepEqual(step.warnings, ["password=[REDACTED]"]);
			assert.deepEqual(step.nextActions, [recovery]);
			assert.equal(step.summary, "Found 10000 entries");
			return {
				metadataSteps: 1,
				discardedRows: count,
				recoveryPreserved: true,
				warningsRedacted: true,
			};
		},
	};
}

function manifestWorkload(mergeSessionArtifactManifest) {
	const count = 10_000;
	const path = (index) => `benchmark-artifact-${index}.png`;
	const entries = Array.from({ length: count }, (_, index) => ({
		path: path(index),
		kind: "image",
		command: "screenshot",
		storageScope: "persistent-session",
		retentionState: "live",
		createdAtMs: index + 1,
	}));
	const expectedPaths = Array.from({ length: MANIFEST_LIMIT }, (_, index) =>
		path(count - index - 1),
	);
	return {
		name: "artifact-manifest-10k-entries",
		fixture: { inputEntries: count, retainedEntries: MANIFEST_LIMIT, ...fixtureIdentity(entries) },
		run: () => mergeSessionArtifactManifest({ entries, nowMs: 20_000 }),
		verify(output) {
			assert.equal(output.version, 1);
			assert.equal(output.updatedAtMs, 20_000);
			assert.equal(output.maxEntries, MANIFEST_LIMIT);
			assert.equal(output.liveCount, MANIFEST_LIMIT);
			assert.equal(output.evictedCount, 0);
			assert.deepEqual(
				output.entries.map((entry) => entry.path),
				expectedPaths,
			);
			return {
				retainedEntries: output.entries.length,
				orderedPathsSha256: fixtureIdentity(expectedPaths).sha256,
			};
		},
	};
}

async function* byteChunks(buffer, size = 65_536) {
	for (let offset = 0; offset < buffer.length; offset += size) {
		yield buffer.subarray(offset, offset + size);
	}
}

function journalWorkload(projectJson) {
	const count = 1000;
	const record = {
		type: "custom",
		customType: "agent-browser-transition",
		id: "r",
		parentId: "p",
		timestamp: "2026-10-12T00:00:00.000Z",
		data: {
			event: {
				version: 1,
				phase: "begin",
				operationId: "o",
				toolCallId: "t",
				commandIndex: 0,
				isError: false,
				state: { args: ["snapshot"] },
			},
		},
	};
	const buffer = Buffer.from(JSON.stringify(record));
	const expected = {
		type: "custom",
		customType: "agent-browser-transition",
		id: "r",
		parentId: "p",
		timestamp: "2026-10-12T00:00:00.000Z",
		data: { event: { version: 1 } },
	};
	return {
		name: "journal-project-1000-small-records",
		fixture: {
			records: count,
			recordBytes: buffer.length,
			totalBytes: buffer.length * count,
			chunkBytes: 65_536,
			selectedFields: JOURNAL_FIELDS,
			...fixtureIdentity(record),
		},
		async run() {
			const outputs = [];
			for (let index = 0; index < count; index++) {
				// Journal scanning is sequential; parallel calls would measure a different workload.
				// oxlint-disable-next-line no-await-in-loop
				outputs.push(await projectJson(byteChunks(buffer), JOURNAL_FIELDS));
			}
			return outputs;
		},
		verify(outputs) {
			assert.equal(outputs.length, count);
			for (const output of outputs) {
				assert.deepEqual(output, expected);
			}
			return { projectedRecords: outputs.length, selectedEventVersion: 1 };
		},
	};
}

async function validateControls(projectJson, mergeSessionArtifactManifest) {
	const utf8 = Buffer.from('{"id":"🧪é","rows":[{"label":"first","ignored":true},{"label":"終"}]}');
	assert.deepEqual(await projectJson(byteChunks(utf8, 1), [["id"], ["rows", "*", "label"]]), {
		id: "🧪é",
		rows: [{ label: "first" }, { label: "終" }],
	});
	await assert.rejects(
		projectJson(byteChunks(Buffer.from('{"ignored":[false,invalid],"id":"never"}')), [["id"]]),
	);
	const invalidUtf8 = Buffer.concat([
		Buffer.from('{"ignored":"'),
		Buffer.from([0xc3, 0x28]),
		Buffer.from('","id":"kept"}'),
	]);
	await assert.rejects(projectJson(byteChunks(invalidUtf8, 1), [["id"]]));
	const old = {
		path: "old.webm",
		kind: "video",
		command: "record",
		subcommand: "start",
		session: "benchmark",
		namespace: "one",
		retentionState: "live",
		storageScope: "persistent-session",
		createdAtMs: 1,
	};
	const newer = { ...old, path: "new.webm", createdAtMs: 2 };
	const other = { ...old, path: "other.webm", namespace: "two", createdAtMs: 0 };
	const manifest = mergeSessionArtifactManifest({ entries: [newer, old, other], nowMs: 3 });
	assert.deepEqual(
		manifest.entries.map((entry) => entry.path),
		["new.webm", "other.webm"],
	);
	return {
		splitUtf8AndWildcard: true,
		discardedGrammarRejected: true,
		invalidUtf8Rejected: true,
		recordingReplacement: true,
	};
}

async function measure(workload, sampleIndex) {
	global.gc();
	const before = process.memoryUsage();
	const cpu = process.cpuUsage();
	const start = performance.now();
	const output = await workload.run();
	const wallMs = performance.now() - start;
	const used = process.cpuUsage(cpu);
	const after = process.memoryUsage();
	const sample = {
		sampleIndex,
		wallMs,
		cpuUserMs: used.user / 1000,
		cpuSystemMs: used.system / 1000,
		cpuMs: (used.user + used.system) / 1000,
		heapUsedBeforeBytes: before.heapUsed,
		heapUsedAfterBytes: after.heapUsed,
		heapUsedDeltaBytes: after.heapUsed - before.heapUsed,
		rssBeforeBytes: before.rss,
		rssAfterBytes: after.rss,
		rssDeltaBytes: after.rss - before.rss,
		loadavg: loadavg(),
	};
	return { sample, verifiedOutput: workload.verify(output) };
}

function summarize(samples) {
	return Object.fromEntries(
		["wallMs", "cpuMs", "heapUsedDeltaBytes", "rssDeltaBytes"].map((key) => {
			const values = samples.map((sample) => sample[key]).sort((a, b) => a - b);
			const middle = Math.floor(values.length / 2);
			const median =
				values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle];
			return [key, { min: values[0], median, max: values.at(-1) }];
		}),
	);
}

async function runWorkload(workload, sampleCount) {
	for (let index = 0; index < WARMUPS; index++) {
		// Warmups and samples must not compete for CPU or retain each other's output.
		// oxlint-disable-next-line no-await-in-loop
		workload.verify(await workload.run());
	}
	const samples = [];
	let verifiedOutput;
	for (let index = 0; index < sampleCount; index++) {
		// Each sample owns a GC boundary and runs without competing samples.
		// oxlint-disable-next-line no-await-in-loop
		const measured = await measure(workload, index + 1);
		samples.push(measured.sample);
		verifiedOutput = measured.verifiedOutput;
	}
	return {
		name: workload.name,
		fixture: workload.fixture,
		verifiedOutput,
		samples,
		summary: summarize(samples),
	};
}

async function loadWorkloads(root) {
	const owner = (path) =>
		import(pathToFileURL(resolve(root, "dist/extensions/agent-browser/lib", path)).href);
	const [
		{ redactSensitiveText },
		{ formatSnapshotSummary },
		{ projectAgentBrowserObservation },
		{ mergeSessionArtifactManifest },
		{ projectJson },
	] = await Promise.all([
		owner("runtime-redaction.js"),
		owner("results/snapshot-content.js"),
		owner("results/presentation/content.js"),
		owner("results/artifact-manifest.js"),
		owner("browser-journal-projection.js"),
	]);
	// Fix native retention policy so inherited operator settings cannot change this fixture.
	process.env.PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES = String(MANIFEST_LIMIT);
	const controls = await validateControls(projectJson, mergeSessionArtifactManifest);
	const workloads = [
		redactionWorkload(redactSensitiveText),
		snapshotWorkload(formatSnapshotSummary),
		observationWorkload(projectAgentBrowserObservation),
		manifestWorkload(mergeSessionArtifactManifest),
		journalWorkload(projectJson),
	];
	return { controls, workloads };
}

async function sourceIdentity(root) {
	const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
	return {
		root,
		packageVersion: packageJson.version,
		sourceTree: await treeIdentity(resolve(root, "extensions/agent-browser")),
		compiledTree: await treeIdentity(resolve(root, "dist/extensions/agent-browser")),
		lockfileSha256: sha256(await readFile(resolve(root, "package-lock.json"))),
		benchmarkSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
	};
}

async function main() {
	const parsed = options();
	if (parsed.help) {
		console.log(`Usage: node --expose-gc scripts/profile-performance.mjs [--samples <positive integer>] [--root <built repo>] [--help]

Prints JSON for five fixed production workloads (default: 5 samples after 2 warmups).
Build the target separately with npm run build. --root defaults to this script's repo.
Imports compiled dist owners; no startup measurement, build, network or subprocess work.
Heap deltas are transient heapUsed changes, not total allocations or peak memory.
RSS is process-wide; CPU is process user + system time. No timing thresholds.
Redirect stdout to retain comparable reports; use the same Node, fixtures and host load.`);
		return;
	}
	assert.equal(typeof global.gc, "function", "Run with node --expose-gc.");
	const root = await realpath(parsed.root);
	const source = await sourceIdentity(root);
	const { controls, workloads } = await loadWorkloads(root);
	const environment = {
		node: process.version,
		execPath: process.execPath,
		platform: process.platform,
		arch: process.arch,
		cpuModel: cpus()[0]?.model,
		logicalCpus: cpus().length,
		totalMemoryBytes: totalmem(),
		loadavgBefore: loadavg(),
	};
	const results = [];
	for (const workload of workloads) {
		// The benchmark intentionally measures one hotpath at a time on this process.
		// oxlint-disable-next-line no-await-in-loop
		results.push(await runWorkload(workload, parsed.samples));
	}
	console.log(
		JSON.stringify(
			{
				schemaVersion: 1,
				generatedAt: new Date().toISOString(),
				source,
				environment,
				protocol: {
					warmups: WARMUPS,
					samplesPerWorkload: parsed.samples,
					gcBeforeEachSample: true,
					wall: "One whole workload; imports, fixture creation, explicit GC and output assertions excluded.",
					cpu: "Process user + system CPU during the wall interval, including automatic GC.",
					heap: "Transient heapUsed after - before, with output alive; not allocation totals, retained heap or peak.",
					rss: "Process-wide before/after resident bytes, not workload allocation totals or peak.",
					maxRss:
						"process.resourceUsage().maxRSS in KiB; process-wide high-water mark including setup.",
					timingThresholds: false,
				},
				controls,
				workloads: results,
				loadavgAfter: loadavg(),
				maxRssKiB: process.resourceUsage().maxRSS,
			},
			null,
			2,
		),
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
