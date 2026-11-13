// Opt-in: real Pi AgentSession + native agent-browser. Uses only caller-owned test data.
// Native Unix REQUIRES a short, absolute, caller-owned PI_AGENT_BROWSER_SOCKET_DIR
// (mode 0700). With full UUIDs the default macOS path can be 109 bytes, exceeding 103;
// lib/process.ts:getAgentBrowserSocketPathValidationError enforces that existing limit.
// Shorten the private root, never the UUID or namespace mapping.
// Set PROBE_OUTPUT_DIR, PROBE_BROWSER_ENTRY (optional baseline), PROBE_PI_ROOT, and
// PROBE_AI_STREAM. Managed cases also require PROBE_ALLOW_MANAGED=1 (host test slot).
// Set PROBE_AMBIENT_NAMESPACE to a nonempty value to test post-reload ambient overrides.
// PROBE_REQUESTED_RECORDING=1 adds the requested-artifact close/stop control to
// managed-nongit or managed-optout; it also requires ffprobe on PATH.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadRecordingModules } from "../test/helpers/native-probe-modules.mjs";
import { readBrowserToolResult, readToolArguments } from "../test/helpers/tool-result.mjs";
import {
	readDefined,
	readRecord,
	readArray,
	readString,
	readNumber,
	hasErrorCode,
} from "../test/helpers/assertions.ts";
import { record, parseJsonl } from "./lifecycle-transcript.mjs";
/** @import {SessionManager as NativeSessionManager} from "@earendil-works/pi-coding-agent" */
/** @import {BrowserToolResult} from "../test/helpers/tool-result.mjs" */
/** @typedef {Awaited<ReturnType<typeof create>>} RecordingRun */
/** @typedef {readonly ["--namespace", string, "--session", string]} RecordingIdentity */
/** @typedef {{a: RecordingRun, closed: BrowserToolResult, identity: RecordingIdentity, requestedPrompt: string | undefined, video: string}} RequestedRecordingCase */

const mode = readDefined(process.argv[2]);
const output = readString(process.env.PROBE_OUTPUT_DIR);
assert.ok(
	output.length > 0 && path.isAbsolute(output),
	"PROBE_OUTPUT_DIR must be a private absolute evidence directory",
);
assert.ok(
	mode.length > 0,
	"Specify relative, active, active-two, active-partial, active-reload, tree, tree-no-fault, tree-phantom, tree-active, tree-reload, managed-nongit, managed-optout, or managed-git",
);
const requestedRecording = process.env.PROBE_REQUESTED_RECORDING === "1";
assert.ok(
	!requestedRecording || ["managed-nongit", "managed-optout"].includes(mode),
	"Requested-recording control requires managed-nongit or managed-optout",
);
fs.mkdirSync(output, { recursive: true });
const piRoot =
	process.env.PROBE_PI_ROOT ??
	fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent", import.meta.url));
const browserEntry =
	process.env.PROBE_BROWSER_ENTRY ??
	fileURLToPath(new URL("../dist/extensions/agent-browser/index.js", import.meta.url));
const {
	sdk: { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime },
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	browserExtension,
	restoreRecordingReservationStateFromBranch,
	getLatestUserMessage,
	getMessageText,
} = await loadRecordingModules({
	sdkRoot: piRoot,
	browserEntry,
	streamPath: process.env.PROBE_AI_STREAM,
});
const ENTRY = "agent-browser-recording-reservation";
/** @satisfies {import("@earendil-works/pi-ai").Model<"offline-recording-check">} */
const model = {
	id: "offline-recording-check",
	name: "Offline recording check",
	provider: "offline-check",
	api: "offline-recording-check",
	baseUrl: "http://127.0.0.1:1",
	input: ["text"],
	reasoning: false,
	contextWindow: 100000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
let serial = 0;
const NAMESPACE = randomUUID();
const explicit = (name = "A") => ["--namespace", NAMESPACE, "--session", name];
/** @param {string} file */
const readDisk = (file) => parseJsonl(fs.readFileSync(file, "utf8")).map(readRecord);
/** @param {NativeSessionManager} sm */
const reservationRows = (sm) =>
	sm.getBranch().filter((entry) => entry.type === "custom" && entry.customType === ENTRY);
/** @param {unknown} result */
const protectedResult = (result) => /reserved by an active recording/.test(JSON.stringify(result));

/** @param {unknown} details */
function manifestEntries(details) {
	const entries = record(record(details)?.artifactManifest)?.entries;
	return entries === undefined ? [] : readArray(entries).map(readRecord);
}

/** @param {BrowserToolResult} result */
function nextActions(result) {
	const actions = result.details.nextActions;
	return actions === undefined ? [] : readArray(actions).map(readRecord);
}
/** @param {string} type @param {object} data */
function log(type, data = {}) {
	const line = JSON.stringify({ type, ...data });
	console.log(line);
	fs.appendFileSync(path.join(output, "events.jsonl"), `${line}\n`);
}

/** @param {string} name @param {string} [reopenFile] @param {string} [cwd] */
async function create(name, reopenFile, cwd = output) {
	const agentDir = path.join(output, `${name}-agent`);
	fs.mkdirSync(agentDir, { recursive: true });
	const sm =
		reopenFile === undefined || reopenFile === ""
			? SessionManager.create(cwd, path.join(output, `${name}-sessions`))
			: SessionManager.open(reopenFile);
	const settings = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		packages: [],
		extensions: [],
	});
	/** @type {import("@earendil-works/pi-ai").JsonObject | undefined} */
	let nextArgs;
	const faux = fauxProvider({ api: model.api, provider: model.provider });
	const response = () => {
		const message = nextArgs
			? fauxAssistantMessage(fauxToolCall("agent_browser", nextArgs, { id: `check-${++serial}` }), {
					stopReason: "toolUse",
				})
			: fauxAssistantMessage("Offline check completed.");
		nextArgs = undefined;
		faux.appendResponses([response]);
		return message;
	};
	faux.setResponses([response]);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: settings,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			browserExtension,
			(pi) => {
				pi.registerProvider(model.provider, {
					api: model.api,
					baseUrl: model.baseUrl,
					apiKey: "offline-fixture",
					models: [model],
					streamSimple: faux.provider.streamSimple.bind(faux.provider),
				});
				pi.on("session_start", (data) => log(`${name}:native-lifecycle`, data));
				pi.on("session_tree", (data) => log(`${name}:native-lifecycle`, data));
				pi.on("session_shutdown", (data) => log(`${name}:native-lifecycle`, data));
			},
		],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const runtime = await ModelRuntime.create({
		authPath: path.join(agentDir, "no-auth.json"),
		modelsPath: null,
		modelsStorePath: path.join(agentDir, "models.json"),
		refreshOnCreate: false,
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		resourceLoader: loader,
		settingsManager: settings,
		sessionManager: sm,
		modelRuntime: runtime,
		model,
		tools: ["agent_browser"],
	});
	await session.bindExtensions({
		onError: (event) => log(`${name}:extension-error`, { error: event.error, event: event.event }),
	});
	/** @param {Record<string, unknown>} params @param {string} [prompt] */
	async function call(params, prompt) {
		nextArgs = readToolArguments(params);
		await session.prompt(prompt ?? "Execute the offline recording check.");
		await session.waitForIdle();
		const result = session.agent.state.messages.findLast(
			(message) => message.role === "toolResult",
		);
		const receipt = readBrowserToolResult(result);
		log(`${name}:result`, { params, prompt, result });
		if (prompt !== undefined) {
			const branchPrompt = getMessageText(getLatestUserMessage(sm)?.content);
			const journal = sm.getSessionFile();
			assert.ok(journal !== undefined && journal !== "", "Expected a persisted recording session");
			const persistedPrompt = getMessageText(
				getLatestUserMessage(SessionManager.open(journal))?.content,
			);
			log(`${name}:user-prompt`, {
				prompt,
				branchPrompt,
				persistedPrompt,
				sessionFile: sm.getSessionFile(),
			});
			assert.equal(branchPrompt, prompt);
			assert.equal(persistedPrompt, prompt);
		}
		return receipt;
	}
	/** @param {string} destination */
	async function probe(destination) {
		const controller = new AbortController();
		// Reservation protection is the observed boundary. A pre-aborted signal would stop
		// at queue admission before validation and cannot test destination protection.
		const tool = session.agent.state.tools.find((entry) => entry.name === "agent_browser");
		assert.ok(tool, "Expected the real registered browser tool");
		const result = await tool
			.execute(
				`reservation-${++serial}`,
				{ args: [...explicit(), "screenshot", destination] },
				controller.signal,
				() => {
					// Reservation protection is checked from the final receipt, not intermediate updates.
				},
			)
			.catch((/** @type {unknown} */ error) => ({
				thrown: {
					name: error instanceof Error ? error.name : undefined,
					message: error instanceof Error ? error.message : String(error),
				},
			}));
		log(`${name}:destination-probe`, { destination, result });
		return result;
	}
	// Invoke Pi's real _persist against an actual directory at our journal path. Its
	// in-memory append has already happened; no fabricated session-tree/shutdown events.
	/** @param {string} state @param {string} [sessionName] */
	function faultOnce(state, sessionName) {
		const original = sm._persist.bind(sm);
		let count = 0;
		sm._persist = (entry) => {
			if (
				count > 0 ||
				entry.type !== "custom" ||
				entry.customType !== ENTRY ||
				record(entry.data)?.state !== state ||
				(sessionName !== undefined &&
					sessionName !== "" &&
					record(entry.data)?.sessionName !== sessionName)
			) {
				original(entry);
				return;
			}
			count++;
			const file = readDefined(sm.getSessionFile());
			fs.renameSync(file, `${file}.backup`);
			fs.mkdirSync(file);
			try {
				original(entry);
			} catch (error) {
				assert.ok(hasErrorCode(error, "EISDIR"));
				assert.equal(
					readDisk(`${file}.backup`).some((row) => row.id === entry.id),
					false,
					"The injected write must fail before the entry reaches disk",
				);
				log("real-journal-EISDIR", {
					state,
					sessionName: record(entry.data)?.sessionName,
					failedEntryId: entry.id,
				});
				throw error;
			} finally {
				fs.rmdirSync(file);
				fs.renameSync(`${file}.backup`, file);
			}
		};
		return () => {
			sm._persist = original;
			return count;
		};
	}

	return { session, sm, call, probe, faultOnce };
}

async function relative() {
	const a = await create("relative");
	await a.session.prompt("Seed native journal.");
	await a.session.waitForIdle();
	const good = {
		version: 1,
		state: "active",
		namespace: NAMESPACE,
		sessionName: "valid",
		cwd: output,
		absolutePath: path.join(output, "valid.webm"),
		path: "relative-display.webm",
	};
	a.sm.appendCustomEntry(ENTRY, good);
	for (const [index, invalid] of [
		{ cwd: "." },
		{ cwd: "" },
		{ absolutePath: "bad.webm" },
		{ absolutePath: "" },
	].entries()) {
		a.sm.appendCustomEntry(ENTRY, { ...good, ...invalid, sessionName: `malformed-${index}` });
	}
	const file = readDefined(a.sm.getSessionFile());
	a.session.dispose();
	const b = await create("relative-reopen", file);
	try {
		const restoredActive = [
			...restoreRecordingReservationStateFromBranch(b.sm.getBranch()).active.values(),
		];
		const goodProtected = protectedResult(await b.probe(good.absolutePath));
		const badProtected = protectedResult(await b.probe(path.join(output, "bad.webm")));
		log("relative-summary", { active: restoredActive, goodProtected, badProtected });
		assert.deepEqual(restoredActive, [
			{
				absolutePath: good.absolutePath,
				cwd: output,
				namespace: good.namespace,
				path: good.path,
				sessionName: good.sessionName,
			},
		]);
		assert.equal(goodProtected, true);
		assert.equal(badProtected, false);
	} finally {
		try {
			// The unreserved negative control may have launched this private explicit browser.
			await b.call({ args: [...explicit(), "close"] });
		} finally {
			b.session.dispose();
		}
	}
}

async function active() {
	const names = mode === "active" ? ["B"] : ["A", "B"];
	const a = await create("active");
	let current = a;
	const videos = names.map((name) => path.join(output, `${name}.webm`));
	/** @type {string | undefined} */
	let startWarning;
	/** @type {readonly unknown[] | undefined} */
	let jsonWarnings;
	try {
		if (mode === "active-partial") {
			await a.call({ args: [...explicit("C"), "open", "data:text/html,<title>closed</title>"] });
			await a.call({
				args: [...explicit("C"), "record", "start", path.join(output, "closed.webm")],
			});
			assert.equal((await a.call({ args: [...explicit("C"), "close"] })).isError, false);
		}
		for (const [index, name] of names.entries()) {
			// Launch each named browser before recording it; sessions share the native host resources.
			const opened = await a.call({
				args: [
					...explicit(name),
					"open",
					"data:text/html,<title>recording</title><h1>recording</h1>",
				],
			});
			assert.equal(opened.isError, false);
			const undo = name === "B" ? a.faultOnce("active", name) : () => 0;
			let started;
			try {
				// The per-session append fault must be restored before the next recording starts.
				started = await a.call({
					args: [...explicit(name), "--json", "record", "start", readDefined(videos[index])],
				});
			} finally {
				if (name === "B") {
					assert.equal(undo(), 1);
				}
			}
			assert.equal(started.isError, false);
			assert.equal(readRecord(readArray(started.details.artifacts)[0]).status, "pending");
			if (name === "B") {
				startWarning = readString(started.details.recordingPersistenceWarning);
				const content = readDefined(started.content[0]);
				assert.equal(content.type, "text");
				jsonWarnings = readArray(readRecord(JSON.parse(readString(content.text))).warnings);
				log("failed-start-warning", { warning: startWarning, jsonWarnings });
			}
		}
		const initialDisk = readDisk(readDefined(a.sm.getSessionFile()));
		log("reservation-after-failed-write", {
			persisted: initialDisk.filter(
				(row) => row.customType === ENTRY && record(row.data)?.sessionName === "B",
			),
		});
		assert.ok(
			initialDisk.some((row) =>
				manifestEntries(record(row.message)?.details).some(
					(entry) => entry.absolutePath === videos.at(-1),
				),
			),
		);
		let partial;
		let partialFaults;
		if (mode === "active-partial") {
			const undo = a.faultOnce("active", "B");
			try {
				partial = await a.call({ args: [...explicit("A"), "get", "title"] });
			} finally {
				partialFaults = undo();
			}
		}
		if (mode === "active-reload") {
			await a.session.reload();
		}
		const recovered = await a.call({ args: [...explicit(names[0]), "get", "title"] });
		const file = readDefined(a.sm.getSessionFile());
		fs.copyFileSync(file, path.join(output, "before-reopen.jsonl"));
		a.session.dispose(); // abrupt loss: no shutdown callback
		current = await create("active-reopen", file);
		const restoredState = restoreRecordingReservationStateFromBranch(current.sm.getBranch());
		const restored = [...restoredState.active.values()].map((row) => row.sessionName).sort();
		const closed = [...restoredState.terminal.values()].map((row) => row.sessionName);
		const closedProtected =
			mode === "active-partial" &&
			protectedResult(await current.probe(path.join(output, "closed.webm")));
		const protection = [];
		for (const video of videos) {
			// Probe destinations serially on one reopened Pi/browser session.
			protection.push(protectedResult(await current.probe(video)));
		}
		const stops = [];
		for (const name of names) {
			// Finish and verify one native encoder before stopping the next owned recording.
			stops.push(await current.call({ args: [...explicit(name), "record", "stop"] }));
		}
		log("active-summary", {
			mode,
			restored,
			closed,
			closedProtected,
			protection,
			partialFaults,
			partialWarning: partial?.details.recordingPersistenceWarning,
			recoveredWarning: recovered.details.recordingPersistenceWarning,
			verified: stops.map((stop) => record(stop.details.artifactVerification)?.verified),
		});
		assert.deepEqual(restored, [...names].sort());
		assert.ok(protection.every(Boolean));
		assert.ok(
			stops.every(
				(stop) =>
					stop.isError === false && record(stop.details.artifactVerification)?.verified === true,
			),
		);
		assert.equal(recovered.details.recordingPersistenceWarning, undefined);
		assert.match(readString(startWarning), /not yet durable/);
		assert.ok(readDefined(jsonWarnings).includes(startWarning));
		if (mode === "active-partial") {
			assert.deepEqual(closed, ["C"]);
			assert.equal(closedProtected, false);
			assert.equal(partialFaults, 1);
			assert.match(
				readString(readDefined(partial).details.recordingPersistenceWarning),
				/not yet durable/,
			);
		}
	} finally {
		for (const name of names) {
			// Close each owned session in order before disposing the shared Pi runtime.
			await current.call({ args: [...explicit(name), "close"] });
		}
		current.session.dispose();
	}
}

async function tree() {
	const a = await create("tree");
	let current = a;
	const video = path.join(output, "tree.webm");
	try {
		await a.call({
			args: [...explicit(), "open", "data:text/html,<title>tree</title><h1>tree</h1>"],
		});
		if (mode === "tree-active") {
			await a.call({ args: [...explicit(), "record", "start", path.join(output, "older.webm")] });
			assert.equal(
				readRecord(
					(await a.call({ args: [...explicit(), "record", "stop"] })).details.artifactVerification,
				).verified,
				true,
			);
		}
		const beforeRecording = a.sm.getLeafId();
		assert.equal(
			(await a.call({ args: [...explicit(), "record", "start", video] })).isError,
			false,
		);
		const activeTarget = a.sm.getLeafId();
		let phantom;
		/** @type {Record<string, unknown> | undefined} */
		let closeReceipt;
		if (mode !== "tree-active") {
			const undo = mode === "tree-no-fault" ? () => 0 : a.faultOnce("closed");
			try {
				const closed = await a.call({ args: [...explicit(), "close"] });
				assert.equal(closed.isError, false);
				closeReceipt = readDefined(
					manifestEntries(closed.details).find((entry) => entry.absolutePath === video),
				);
				assert.equal(closeReceipt.subcommand, "close-abandoned");
			} finally {
				if (mode !== "tree-no-fault") {
					assert.equal(undo(), 1);
				}
			}
			phantom = readDefined(reservationRows(a.sm).at(-1)).id;
		}
		if (mode === "tree-reload") {
			await a.session.reload();
		} else {
			/** @type {string | null | undefined} */
			let target = activeTarget;
			if (mode === "tree-active") {
				target = beforeRecording;
			} else if (mode === "tree-phantom") {
				target = phantom;
			}
			await a.session.navigateTree(readString(target), { summarize: false });
		}
		a.sm.appendCustomEntry("native-checkpoint", { tree: true });
		const file = readDefined(a.sm.getSessionFile());
		fs.copyFileSync(file, path.join(output, "before-reopen.jsonl"));
		a.session.dispose();
		current = await create("tree-reopen", file);
		await current.call({ args: [...explicit(), "session", "info"] });
		if (mode !== "tree-active") {
			const opened = await current.call({
				args: [...explicit(), "open", "data:text/html,<title>destination probe</title>"],
			});
			assert.equal(opened.isError, false);
		}
		const probeResult = readBrowserToolResult(await current.probe(video));
		const protectedAfterReopen = protectedResult(probeResult);
		const restored = restoreRecordingReservationStateFromBranch(current.sm.getBranch());
		log("tree-summary", {
			mode,
			protectedAfterReopen,
			activeCount: restored.active.size,
			terminalCount: restored.terminal.size,
			closeReceipt,
		});
		assert.equal(protectedAfterReopen, mode === "tree-active");
		assert.equal(
			probeResult.isError,
			mode === "tree-active",
			"The unreserved destination must actually be writable, not blocked by another guard",
		);
		if (mode !== "tree-active") {
			assert.equal(restored.active.size, 0);
			assert.equal(restored.terminal.size, 1);
			assert.deepEqual(
				[...restored.terminal.values()].map(({ namespace, sessionName }) => ({
					namespace,
					sessionName,
				})),
				[{ namespace: NAMESPACE, sessionName: "A" }],
			);
		} else {
			assert.equal(
				readRecord(
					(await current.call({ args: [...explicit(), "record", "stop"] })).details
						.artifactVerification,
				).verified,
				true,
			);
		}
	} finally {
		await current.call({ args: [...explicit(), "close"] });
		current.session.dispose();
	}
}

/** @param {readonly BrowserToolResult[]} failures @param {readonly (Record<string, unknown> | undefined)[]} actions @param {BrowserToolResult} start @param {RecordingIdentity} identity */
function assertCleanupFailures(failures, actions, start, identity) {
	for (const [index, result] of failures.entries()) {
		assert.equal(result.isError, true);
		assert.equal(
			result.details.managedSessionCleanupOnlyReason,
			"restore-disabled-daemon-without-provenance",
		);
		assert.equal(result.details.sessionName, start.details.sessionName);
		assert.equal(result.details.namespace, identity[1]);
		assert.deepEqual(actions[index]?.params, { args: [...identity, "close"] });
		assert.ok(!nextActions(result).some((action) => action.id === "stop-pending-recording"));
		assert.match(readString(readDefined(actions[index]).safety), /abandoned\/unverified/);
	}
}

/** @param {RequestedRecordingCase} options */
async function verifyRequestedRecording({ a, closed, identity, requestedPrompt, video }) {
	assert.equal(closed.isError, true);
	const guard = readRecord(closed.details.promptGuard);
	assert.equal(guard.reason, "requested-artifacts-missing-before-close");
	assert.ok(
		readArray(guard.missingArtifacts)
			.map(readRecord)
			.some(
				(artifact) =>
					artifact.kind === "recording" && artifact.path === video && artifact.required === true,
			),
	);
	const permittedStop = nextActions(closed).find(
		(action) => action.id === "stop-pending-recording",
	);
	assert.ok(
		permittedStop?.params !== undefined,
		"The guarded close must return the now-permitted stop action",
	);
	const stopped = await a.call(readRecord(permittedStop.params), requestedPrompt);
	assert.equal(stopped.isError, false, JSON.stringify(stopped));
	assert.equal(stopped.details.sessionName, identity[3]);
	assert.equal(stopped.details.namespace ?? "", identity[1]);
	const verification = readRecord(stopped.details.artifactVerification);
	assert.equal(verification.verified, true);
	const artifact = readArray(verification.artifacts)
		.map(readRecord)
		.find((entry) => entry.absolutePath === video);
	assert.equal(artifact?.state, "verified");
	assert.ok(readNumber(readDefined(artifact).sizeBytes) > 0);
	const ffprobe = readRecord(
		JSON.parse(
			execFileSync(
				"ffprobe",
				["-v", "error", "-show_entries", "format=format_name,duration,size", "-of", "json", video],
				{ encoding: "utf8" },
			),
		),
	);
	fs.writeFileSync(
		path.join(output, "requested-recording.ffprobe.json"),
		`${JSON.stringify(ffprobe, null, 2)}\n`,
	);
	const format = readRecord(ffprobe.format);
	assert.ok(readString(format.format_name).split(",").includes("webm"));
	assert.equal(Number(format.size), readDefined(artifact).sizeBytes);
	const finalClose = await a.call({ args: [...identity, "close"] }, requestedPrompt);
	assert.equal(finalClose.isError, false, JSON.stringify(finalClose));
	log("requested-recording-summary", {
		mode,
		identity,
		prompt: requestedPrompt,
		video,
		closeGuard: closed.details.promptGuard,
		permittedStop,
		verification: stopped.details.artifactVerification,
		ffprobe,
		finalCloseIsError: finalClose.isError,
	});
}

/** @param {Omit<RequestedRecordingCase, "closed"> & {start: BrowserToolResult, stopAction: Record<string, unknown>, sameStop: BrowserToolResult}} options */
async function verifyManagedAbandonment({
	a,
	start,
	stopAction,
	identity,
	requestedPrompt,
	video,
	sameStop,
}) {
	assert.equal(start.details.managedSessionRestoreDisabled, true);
	const implicit = await a.call({ args: ["snapshot", "-i"] }, requestedPrompt);
	const failedStop = await a.call(readRecord(stopAction.params), requestedPrompt);
	const explicitNamespaceStop = await a.call(
		{ args: [...identity, "record", "stop"] },
		requestedPrompt,
	);
	const failures = [implicit, failedStop, explicitNamespaceStop];
	const actions = failures.map((result) =>
		nextActions(result).find((action) => action.id === "close-pending-recording"),
	);
	if (requestedRecording) {
		assert.ok(
			actions[0]?.params !== undefined,
			"The requested-recording control must use the returned close action",
		);
	}
	const closed = await a.call(
		readRecord(actions[0]?.params ?? { args: [...identity, "close"] }),
		requestedPrompt,
	);
	const manifestRow = manifestEntries(closed.details).find((entry) => entry.absolutePath === video);
	log("managed-summary", {
		mode,
		requestedRecording,
		identity,
		sameInstanceVerified: readRecord(sameStop.details.artifactVerification).verified,
		actions,
		closed: closed.isError !== true,
		manifestRow,
	});
	assertCleanupFailures(failures, actions, start, identity);
	if (requestedRecording) {
		await verifyRequestedRecording({ a, closed, identity, requestedPrompt, video });
	} else {
		assert.equal(closed.isError, false);
		assert.notEqual(record(closed.details.artifactVerification)?.verified, true);
		assert.equal(readDefined(manifestRow).subcommand, "close-abandoned");
	}
}

async function managed() {
	assert.equal(
		process.env.PROBE_ALLOW_MANAGED,
		"1",
		"Managed cases require an exclusive host slot or own Ubuntu container",
	);
	delete process.env.AGENT_BROWSER_EXECUTABLE_PATH;
	if (mode === "managed-optout") {
		process.env.PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE = "0";
	}
	const cwd = path.join(output, "cwd");
	fs.mkdirSync(cwd, { recursive: true });
	if (mode !== "managed-nongit") {
		execFileSync("git", ["init", "--quiet", cwd]);
	}
	const video = path.join(cwd, "reload.webm");
	const requestedPrompt = requestedRecording ? `Save a recording to ${video}` : undefined;
	const a = await create(mode, undefined, cwd);
	/** @type {RecordingIdentity | undefined} */
	let identity;
	try {
		const namespace = mode === "managed-optout" ? ["--namespace", NAMESPACE] : [];
		const opened = await a.call({
			args: [...namespace, "open", "data:text/html,<title>reload</title><h1>reload</h1>"],
			sessionMode: "fresh",
		});
		assert.equal(opened.isError, false);
		identity = [
			"--namespace",
			readString(opened.details.namespace ?? ""),
			"--session",
			readString(opened.details.sessionName),
		];
		const sameStart = await a.call({
			args: ["record", "start", path.join(cwd, "same-instance.webm")],
		});
		const sameStop = await a.call(
			readRecord(
				readDefined(nextActions(sameStart).find((action) => action.id === "stop-pending-recording"))
					.params,
			),
		);
		assert.equal(readRecord(sameStop.details.artifactVerification).verified, true);
		const start = await a.call({ args: ["record", "start", video] }, requestedPrompt);
		assert.equal(start.isError, false);
		const stopAction = readDefined(
			nextActions(start).find((action) => action.id === "stop-pending-recording"),
		);
		await a.session.reload();
		const ambientNamespace = process.env.PROBE_AMBIENT_NAMESPACE;
		if (ambientNamespace !== undefined && ambientNamespace !== "") {
			process.env.AGENT_BROWSER_NAMESPACE = ambientNamespace;
		}
		if (mode === "managed-git") {
			assert.notEqual(start.details.managedSessionRestoreDisabled, true);
			const stopped = await a.call(readRecord(stopAction.params));
			log("managed-summary", {
				mode,
				sameInstanceVerified: readRecord(sameStop.details.artifactVerification).verified,
				reloadVerified: record(stopped.details.artifactVerification)?.verified,
			});
			assert.equal(stopped.isError, false);
			assert.equal(readRecord(stopped.details.artifactVerification).verified, true);
		} else {
			await verifyManagedAbandonment({
				a,
				start,
				stopAction,
				identity,
				requestedPrompt,
				video,
				sameStop,
			});
		}
	} finally {
		if (identity) {
			await a.call({ args: [...identity, "close"] }, requestedPrompt);
		}
		a.session.dispose();
	}
}

log("environment", {
	mode,
	requestedRecording,
	namespace: NAMESPACE,
	ambientNamespace: process.env.PROBE_AMBIENT_NAMESPACE,
	platform: process.platform,
	node: process.version,
	browserEntry,
	piRoot,
});
if (mode === "relative") {
	await relative();
} else if (["active", "active-two", "active-partial", "active-reload"].includes(mode)) {
	await active();
} else if (["tree", "tree-no-fault", "tree-phantom", "tree-active", "tree-reload"].includes(mode)) {
	await tree();
} else if (["managed-nongit", "managed-optout", "managed-git"].includes(mode)) {
	await managed();
} else {
	throw new Error(`Unknown check ${mode}`);
}
log("PASS", { mode });
