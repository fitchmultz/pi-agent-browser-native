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
import { fileURLToPath, pathToFileURL } from "node:url";

const mode = process.argv[2];
const output = process.env.PROBE_OUTPUT_DIR;
assert.ok(output && path.isAbsolute(output), "PROBE_OUTPUT_DIR must be a private absolute evidence directory");
assert.ok(mode, "Specify relative, active, active-two, active-partial, active-reload, tree, tree-no-fault, tree-phantom, tree-active, tree-reload, managed-nongit, managed-optout, or managed-git");
const requestedRecording = process.env.PROBE_REQUESTED_RECORDING === "1";
assert.ok(!requestedRecording || ["managed-nongit", "managed-optout"].includes(mode), "Requested-recording control requires managed-nongit or managed-optout");
fs.mkdirSync(output, { recursive: true });
const piRoot = process.env.PROBE_PI_ROOT ?? fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent", import.meta.url));
const [{ createAgentSession }, { DefaultResourceLoader }, { SessionManager }, { SettingsManager }, { ModelRuntime }] = await Promise.all(
	["sdk", "resource-loader", "session-manager", "settings-manager", "model-runtime"].map((name) => import(pathToFileURL(`${piRoot}/dist/core/${name}.js`))),
);
const { AssistantMessageEventStream } = await import(process.env.PROBE_AI_STREAM
	? pathToFileURL(process.env.PROBE_AI_STREAM).href : "@earendil-works/pi-ai");
const browserEntry = process.env.PROBE_BROWSER_ENTRY ?? fileURLToPath(new URL("../dist/extensions/agent-browser/index.js", import.meta.url));
const { default: browserExtension } = await import(pathToFileURL(browserEntry));
const { restoreRecordingReservationStateFromBranch } = await import(pathToFileURL(path.join(path.dirname(browserEntry), "lib/recording-reservations.js")));
const { getLatestUserPrompt } = await import(pathToFileURL(path.join(path.dirname(browserEntry), "lib/prompt-policy.js")));
const ENTRY = "agent-browser-recording-reservation";
const model = { id: "offline-recording-check", name: "Offline recording check", provider: "offline-check", api: "openai-completions", baseUrl: "http://127.0.0.1:1", input: ["text"], reasoning: false, contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
let serial = 0;
const NAMESPACE = randomUUID();
const explicit = (name = "A") => ["--namespace", NAMESPACE, "--session", name];
const readDisk = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const reservationRows = (sm) => sm.getBranch().filter((entry) => entry.type === "custom" && entry.customType === ENTRY);
const protectedResult = (result) => /reserved by an active recording/.test(JSON.stringify(result));
function log(type, data = {}) {
	const line = JSON.stringify({ type, ...data });
	console.log(line);
	fs.appendFileSync(path.join(output, "events.jsonl"), `${line}\n`);
}

async function create(name, reopenFile, cwd = output) {
	const agentDir = path.join(output, `${name}-agent`);
	fs.mkdirSync(agentDir, { recursive: true });
	const sm = reopenFile ? SessionManager.open(reopenFile) : SessionManager.create(cwd, path.join(output, `${name}-sessions`));
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, packages: [], extensions: [] });
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [browserExtension, (pi) => {
		for (const event of ["session_start", "session_tree", "session_shutdown"]) pi.on(event, (data) => log(`${name}:native-lifecycle`, data));
	}] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "no-auth.json"), modelsPath: null, modelsStorePath: path.join(agentDir, "models.json"), refreshOnCreate: false });
	const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager: settings, sessionManager: sm, modelRuntime: runtime, model, tools: ["agent_browser"] });
	await session.bindExtensions({ onError: (event) => log(`${name}:extension-error`, { error: String(event.error), event: event.event }) });
	let nextArgs;
	session.agent.streamFunction = () => {
		const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: nextArgs ? [{ type: "toolCall", id: `check-${++serial}`, name: "agent_browser", arguments: nextArgs }] : [{ type: "text", text: "Offline check completed." }], stopReason: nextArgs ? "toolUse" : "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		nextArgs = undefined;
		const stream = new AssistantMessageEventStream();
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: message.stopReason, message });
		return stream;
	};
	async function call(params, prompt) {
		nextArgs = params;
		await session.agent.prompt(prompt ?? "Execute the offline recording check.");
		await session.waitForIdle();
		const result = session.agent.state.messages.findLast((message) => message.role === "toolResult");
		assert.ok(result);
		log(`${name}:result`, { params, prompt, result });
		if (prompt !== undefined) {
			const branchPrompt = getLatestUserPrompt(sm.getBranch());
			const persistedPrompt = getLatestUserPrompt(readDisk(sm.getSessionFile()));
			log(`${name}:user-prompt`, { prompt, branchPrompt, persistedPrompt, sessionFile: sm.getSessionFile() });
			assert.equal(branchPrompt, prompt);
			assert.equal(persistedPrompt, prompt);
		}
		return result;
	}
	async function probe(destination) {
		const controller = new AbortController();
		controller.abort();
		const tool = session.agent.state.tools.find((entry) => entry.name === "agent_browser");
		const result = await tool.execute(`abort-${++serial}`, { args: [...explicit(), "screenshot", destination] }, controller.signal, () => {}).catch((error) => ({ thrown: { name: error.name, message: error.message } }));
		log(`${name}:destination-probe`, { destination, result });
		return result;
	}
	return { session, sm, call, probe };
}

// Invoke Pi's real _persist against an actual directory at our journal path. Its
// in-memory append has already happened; no fabricated session-tree/shutdown events.
function faultOnce(sm, state, sessionName) {
	const original = sm._persist.bind(sm);
	let count = 0;
	sm._persist = (entry) => {
		if (count || entry.type !== "custom" || entry.customType !== ENTRY || entry.data.state !== state || (sessionName && entry.data.sessionName !== sessionName)) return original(entry);
		count++;
		const file = sm.getSessionFile();
		fs.renameSync(file, `${file}.backup`);
		fs.mkdirSync(file);
		try { return original(entry); }
		catch (error) {
			assert.equal(error.code, "EISDIR");
			log("real-journal-EISDIR", { state, sessionName: entry.data.sessionName, phantomEntryId: entry.id });
			throw error;
		} finally {
			fs.rmdirSync(file);
			fs.renameSync(`${file}.backup`, file);
		}
	};
	return () => { sm._persist = original; return count; };
}

async function relative() {
	const a = await create("relative");
	await a.session.agent.prompt("Seed native journal.");
	await a.session.waitForIdle();
	const good = { version: 1, state: "active", namespace: NAMESPACE, sessionName: "valid", cwd: output, absolutePath: path.join(output, "valid.webm"), path: "relative-display.webm" };
	a.sm.appendCustomEntry(ENTRY, good);
	for (const [index, invalid] of [{ cwd: "." }, { cwd: "" }, { absolutePath: "bad.webm" }, { absolutePath: "" }].entries()) a.sm.appendCustomEntry(ENTRY, { ...good, ...invalid, sessionName: `malformed-${index}` });
	const file = a.sm.getSessionFile();
	a.session.dispose();
	const b = await create("relative-reopen", file);
	try {
		const active = [...restoreRecordingReservationStateFromBranch(b.sm.getBranch()).active.values()];
		const goodProtected = protectedResult(await b.probe(good.absolutePath));
		const badProtected = protectedResult(await b.probe(path.resolve("bad.webm")));
		log("relative-summary", { active, goodProtected, badProtected });
		assert.deepEqual(active, [{ absolutePath: good.absolutePath, cwd: output, namespace: good.namespace, path: good.path, sessionName: good.sessionName }]);
		assert.equal(goodProtected, true);
		assert.equal(badProtected, false);
	} finally { b.session.dispose(); }
}

async function active() {
	const names = mode === "active" ? ["B"] : ["A", "B"];
	const a = await create("active");
	let current = a;
	const videos = names.map((name) => path.join(output, `${name}.webm`));
	let startWarning;
	let jsonWarnings;
	try {
		if (mode === "active-partial") {
			await a.call({ args: [...explicit("C"), "open", "data:text/html,<title>closed</title>"] });
			await a.call({ args: [...explicit("C"), "record", "start", path.join(output, "closed.webm")] });
			assert.equal((await a.call({ args: [...explicit("C"), "close"] })).isError, false);
		}
		for (const [index, name] of names.entries()) {
			assert.equal((await a.call({ args: [...explicit(name), "open", "data:text/html,<title>recording</title><h1>recording</h1>"] })).isError, false);
			const undo = name === "B" ? faultOnce(a.sm, "active", name) : () => 0;
			let started;
			try { started = await a.call({ args: [...explicit(name), "--json", "record", "start", videos[index]] }); }
			finally { if (name === "B") assert.equal(undo(), 1); }
			assert.equal(started.isError, false);
			assert.equal(started.details.artifacts[0].status, "pending");
			if (name === "B") {
				startWarning = started.details.recordingPersistenceWarning;
				jsonWarnings = JSON.parse(started.content[0].text).warnings;
				log("failed-start-warning", { warning: startWarning, jsonWarnings });
			}
		}
		const initialDisk = readDisk(a.sm.getSessionFile());
		assert.equal(initialDisk.filter((row) => row.customType === ENTRY && row.data.sessionName === "B").length, 0);
		assert.ok(initialDisk.some((row) => row.message?.details?.artifactManifest?.entries.some((entry) => entry.absolutePath === videos.at(-1))));
		let partial;
		let partialFaults;
		if (mode === "active-partial") {
			const undo = faultOnce(a.sm, "active", "B");
			try { partial = await a.call({ args: [...explicit("A"), "get", "title"] }); }
			finally { partialFaults = undo(); }
		}
		if (mode === "active-reload") await a.session.reload();
		const recovered = await a.call({ args: [...explicit(names[0]), "get", "title"] });
		const file = a.sm.getSessionFile();
		fs.copyFileSync(file, path.join(output, "before-reopen.jsonl"));
		a.session.dispose(); // abrupt loss: no shutdown callback
		current = await create("active-reopen", file);
		const restoredState = restoreRecordingReservationStateFromBranch(current.sm.getBranch());
		const restored = [...restoredState.active.values()].map((row) => row.sessionName).sort();
		const closed = [...restoredState.terminal.values()].map((row) => row.sessionName);
		const closedProtected = mode === "active-partial" && protectedResult(await current.probe(path.join(output, "closed.webm")));
		const protection = [];
		for (const video of videos) protection.push(protectedResult(await current.probe(video)));
		const stops = [];
		for (const name of names) stops.push(await current.call({ args: [...explicit(name), "record", "stop"] }));
		log("active-summary", { mode, restored, closed, closedProtected, protection, partialFaults, partialWarning: partial?.details.recordingPersistenceWarning, recoveredWarning: recovered.details.recordingPersistenceWarning, verified: stops.map((stop) => stop.details.artifactVerification?.verified) });
		assert.deepEqual(restored, [...names].sort());
		assert.ok(protection.every(Boolean));
		assert.ok(stops.every((stop) => stop.isError === false && stop.details.artifactVerification?.verified === true));
		assert.equal(recovered.details.recordingPersistenceWarning, undefined);
		assert.match(startWarning, /not yet durable/);
		assert.ok(jsonWarnings.includes(startWarning));
		if (mode === "active-partial") {
			assert.deepEqual(closed, ["C"]);
			assert.equal(closedProtected, false);
			assert.equal(partialFaults, 1);
			assert.match(partial.details.recordingPersistenceWarning, /not yet durable/);
		}
	} finally {
		for (const name of names) await current.call({ args: [...explicit(name), "close"] });
		current.session.dispose();
	}
}

async function tree() {
	const a = await create("tree");
	let current = a;
	const video = path.join(output, "tree.webm");
	try {
		await a.call({ args: [...explicit(), "open", "data:text/html,<title>tree</title><h1>tree</h1>"] });
		if (mode === "tree-active") {
			await a.call({ args: [...explicit(), "record", "start", path.join(output, "older.webm")] });
			assert.equal((await a.call({ args: [...explicit(), "record", "stop"] })).details.artifactVerification.verified, true);
		}
		const beforeRecording = a.sm.getLeafId();
		assert.equal((await a.call({ args: [...explicit(), "record", "start", video] })).isError, false);
		const activeTarget = a.sm.getLeafId();
		let phantom;
		if (mode !== "tree-active") {
			const undo = mode === "tree-no-fault" ? () => 0 : faultOnce(a.sm, "closed");
			try { assert.equal((await a.call({ args: [...explicit(), "close"] })).isError, false); }
			finally { if (mode !== "tree-no-fault") assert.equal(undo(), 1); }
			phantom = reservationRows(a.sm).at(-1).id;
		}
		if (mode === "tree-reload") await a.session.reload();
		else await a.session.navigateTree(mode === "tree-active" ? beforeRecording : mode === "tree-phantom" ? phantom : activeTarget, { summarize: false });
		a.sm.appendCustomEntry("native-checkpoint", { tree: true });
		const file = a.sm.getSessionFile();
		fs.copyFileSync(file, path.join(output, "before-reopen.jsonl"));
		a.session.dispose();
		current = await create("tree-reopen", file);
		const protectedAfterReopen = protectedResult(await current.probe(video));
		const restored = restoreRecordingReservationStateFromBranch(current.sm.getBranch());
		const status = await current.call({ args: [...explicit(), "session", "info"] });
		const manifestRow = status.details.artifactManifest?.entries.find((entry) => entry.absolutePath === video);
		log("tree-summary", { mode, protectedAfterReopen, activeCount: restored.active.size, terminalCount: restored.terminal.size, manifestRow });
		assert.equal(protectedAfterReopen, mode === "tree-active");
		if (mode !== "tree-active") {
			assert.equal(restored.active.size, 0);
			assert.equal(restored.terminal.size, 1);
			// A phantom parent cuts off older tool results too. The repair republishes
			// recording protection, not Pi's unrelated message/manifest history.
			if (mode !== "tree-phantom" || manifestRow) assert.equal(manifestRow.subcommand, "close-abandoned");
		} else assert.equal((await current.call({ args: [...explicit(), "record", "stop"] })).details.artifactVerification.verified, true);
	} finally {
		await current.call({ args: [...explicit(), "close"] });
		current.session.dispose();
	}
}

async function managed() {
	assert.equal(process.env.PROBE_ALLOW_MANAGED, "1", "Managed cases require an exclusive host slot or own Ubuntu container");
	delete process.env.AGENT_BROWSER_EXECUTABLE_PATH;
	if (mode === "managed-optout") process.env.PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE = "0";
	const cwd = path.join(output, "cwd");
	fs.mkdirSync(cwd, { recursive: true });
	if (mode !== "managed-nongit") execFileSync("git", ["init", "--quiet", cwd]);
	const video = path.join(cwd, "reload.webm");
	const requestedPrompt = requestedRecording ? `Save a recording to ${video}` : undefined;
	const a = await create(mode, undefined, cwd);
	let identity;
	try {
		const namespace = mode === "managed-optout" ? ["--namespace", NAMESPACE] : [];
		const opened = await a.call({ args: [...namespace, "open", "data:text/html,<title>reload</title><h1>reload</h1>"] });
		assert.equal(opened.isError, false);
		identity = ["--namespace", opened.details.namespace ?? "", "--session", opened.details.sessionName];
		const sameStart = await a.call({ args: ["record", "start", path.join(cwd, "same-instance.webm")] });
		const sameStop = await a.call(sameStart.details.nextActions.find((action) => action.id === "stop-pending-recording").params);
		assert.equal(sameStop.details.artifactVerification.verified, true);
		const start = await a.call({ args: ["record", "start", video] }, requestedPrompt);
		assert.equal(start.isError, false);
		const stopAction = start.details.nextActions.find((action) => action.id === "stop-pending-recording");
		await a.session.reload();
		if (process.env.PROBE_AMBIENT_NAMESPACE) process.env.AGENT_BROWSER_NAMESPACE = process.env.PROBE_AMBIENT_NAMESPACE;
		if (mode === "managed-git") {
			assert.notEqual(start.details.managedSessionRestoreDisabled, true);
			const stopped = await a.call(stopAction.params);
			log("managed-summary", { mode, sameInstanceVerified: sameStop.details.artifactVerification.verified, reloadVerified: stopped.details.artifactVerification?.verified });
			assert.equal(stopped.isError, false);
			assert.equal(stopped.details.artifactVerification.verified, true);
		} else {
			assert.equal(start.details.managedSessionRestoreDisabled, true);
			const implicit = await a.call({ args: ["snapshot", "-i"] }, requestedPrompt);
			const failedStop = await a.call(stopAction.params, requestedPrompt);
			const explicitNamespaceStop = await a.call({ args: [...identity, "record", "stop"] }, requestedPrompt);
			const failures = [implicit, failedStop, explicitNamespaceStop];
			const actions = failures.map((result) => result.details.nextActions?.find((action) => action.id === "close-pending-recording"));
			if (requestedRecording) assert.ok(actions[0]?.params, "The requested-recording control must use the returned close action");
			const closed = await a.call(actions[0]?.params ?? { args: [...identity, "close"] }, requestedPrompt);
			const manifestRow = closed.details.artifactManifest?.entries.find((entry) => entry.absolutePath === video);
			log("managed-summary", { mode, requestedRecording, identity, sameInstanceVerified: sameStop.details.artifactVerification.verified, actions, closed: !closed.isError, manifestRow });
			for (const [index, result] of failures.entries()) {
				assert.equal(result.isError, true);
				assert.equal(result.details.managedSessionCleanupOnlyReason, "restore-disabled-daemon-without-provenance");
				assert.equal(result.details.sessionName, start.details.sessionName);
				assert.equal(result.details.namespace, identity[1]);
				assert.deepEqual(actions[index]?.params, { args: [...identity, "close"] });
				assert.ok(!result.details.nextActions.some((action) => action.id === "stop-pending-recording"));
				assert.match(actions[index].safety, /abandoned\/unverified/);
			}
			if (requestedRecording) {
				assert.equal(closed.isError, true);
				assert.equal(closed.details.promptGuard?.reason, "requested-artifacts-missing-before-close");
				assert.ok(closed.details.promptGuard.missingArtifacts.some((artifact) => artifact.kind === "recording" && artifact.path === video && artifact.required === true));
				const permittedStop = closed.details.nextActions?.find((action) => action.id === "stop-pending-recording");
				assert.ok(permittedStop?.params, "The guarded close must return the now-permitted stop action");
				const stopped = await a.call(permittedStop.params, requestedPrompt);
				assert.equal(stopped.isError, false, JSON.stringify(stopped));
				assert.equal(stopped.details.sessionName, identity[3]);
				assert.equal(stopped.details.namespace ?? "", identity[1]);
				assert.equal(stopped.details.artifactVerification?.verified, true);
				const artifact = stopped.details.artifactVerification.artifacts.find((entry) => entry.absolutePath === video);
				assert.equal(artifact?.state, "verified");
				assert.ok(artifact.sizeBytes > 0);
				const ffprobe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=format_name,duration,size", "-of", "json", video], { encoding: "utf8" }));
				fs.writeFileSync(path.join(output, "requested-recording.ffprobe.json"), `${JSON.stringify(ffprobe, null, 2)}\n`);
				assert.ok(ffprobe.format.format_name.split(",").includes("webm"));
				assert.equal(Number(ffprobe.format.size), artifact.sizeBytes);
				const finalClose = await a.call({ args: [...identity, "close"] }, requestedPrompt);
				assert.equal(finalClose.isError, false, JSON.stringify(finalClose));
				log("requested-recording-summary", { mode, identity, prompt: requestedPrompt, video, closeGuard: closed.details.promptGuard, permittedStop, verification: stopped.details.artifactVerification, ffprobe, finalCloseIsError: finalClose.isError });
			} else {
				assert.equal(closed.isError, false);
				assert.notEqual(closed.details.artifactVerification?.verified, true);
				assert.equal(manifestRow.subcommand, "close-abandoned");
			}
		}
	} finally {
		if (identity) await a.call({ args: [...identity, "close"] }, requestedPrompt);
		a.session.dispose();
	}
}

log("environment", { mode, requestedRecording, namespace: NAMESPACE, ambientNamespace: process.env.PROBE_AMBIENT_NAMESPACE, platform: process.platform, node: process.version, browserEntry, piRoot });
if (mode === "relative") await relative();
else if (["active", "active-two", "active-partial", "active-reload"].includes(mode)) await active();
else if (["tree", "tree-no-fault", "tree-phantom", "tree-active", "tree-reload"].includes(mode)) await tree();
else if (["managed-nongit", "managed-optout", "managed-git"].includes(mode)) await managed();
else throw new Error(`Unknown check ${mode}`);
log("PASS", { mode });
