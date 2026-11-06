// Real native SDK workers: no model/provider, fake upstream, or fabricated ownership.
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { loadNativeSdk } from "./native-probe-modules.mjs";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { readBrowserToolResult, readToolArguments } from "./tool-result.mjs";
import { readDefined, readRecord, readString } from "./assertions.ts";
import { readNativeSessionInfo } from "./native-session-info.mjs";
/** @import {ChildProcess} from "node:child_process" */
/** @import {BrowserToolResult} from "./tool-result.mjs" */

const workerOptions = Type.Object({
	root: Type.String(),
	cwd: Type.String(),
	agentDir: Type.String(),
	sdkPath: Type.String(),
	extensionPath: Type.String(),
	journal: Type.Optional(Type.String()),
});
const workerRequest = Type.Union([
	Type.Object({ action: Type.Literal("call"), params: Type.Record(Type.String(), Type.Unknown()) }),
	Type.Object({ action: Type.Literal("branch"), params: Type.String() }),
	Type.Object({ action: Type.Literal("reload") }),
	Type.Object({ action: Type.Literal("dispose") }),
]);
const workerState = Type.Object({
	pid: Type.Number(),
	journal: Type.String(),
	leaf: Type.String(),
	branch: Type.Array(Type.String()),
	entries: Type.Array(Type.String()),
	result: Type.Optional(Type.Unknown()),
});
const workerResponse = Type.Union([Type.Object({ error: Type.String() }), workerState]);
/** @typedef {import("typebox").Static<typeof workerOptions>} WorkerOptions */
/** @typedef {import("typebox").Static<typeof workerRequest>} WorkerRequest */
/** @typedef {import("typebox").Static<typeof workerState>} WorkerState */
/** @typedef {{name: string, socketDir: string, namespace?: string}} NativeIdentity */

/** @param {WorkerOptions} options */
async function worker(options) {
	const send = readDefined(process.send?.bind(process));
	const sdk = await loadNativeSdk(options.sdkPath);
	const { cwd, agentDir } = options;
	const settingsManager = sdk.SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const modelRuntime = await sdk.ModelRuntime.create({
		allowModelNetwork: false,
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-store.json"),
	});
	/** @type {BrowserToolResult | undefined} */
	let result;
	let callId = 0;
	const sm =
		options.journal === undefined || options.journal === ""
			? sdk.SessionManager.create(cwd, join(options.root, "crash-sessions"))
			: sdk.SessionManager.open(options.journal);
	const loader = new sdk.DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noContextFiles: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		additionalExtensionPaths: [options.extensionPath],
		extensionFactories: [
			(pi) =>
				pi.registerCommand("offbranch-test", {
					description: "Model-free real tool dispatch",
					handler: async (args) => {
						const id = `offbranch-${++callId}`;
						const tool = readDefined(
							session.agent.state.tools.find((candidate) => candidate.name === "agent_browser"),
						);
						result = readBrowserToolResult(
							await tool.execute(id, readToolArguments(JSON.parse(args))),
						);
						// Persist only the actual executed tool's result.
						sm.appendMessage({
							role: "toolResult",
							toolCallId: id,
							toolName: "agent_browser",
							content: result.content,
							details: readToolArguments(JSON.parse(JSON.stringify(result.details))),
							isError: result.isError === true,
							timestamp: Date.now(),
						});
					},
				}),
		],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({
		cwd,
		agentDir,
		settingsManager,
		modelRuntime,
		resourceLoader: loader,
		sessionManager: sm,
		noTools: "builtin",
	});
	await session.bindExtensions({
		onError: (e) => {
			throw new Error(e.error);
		},
	});
	if (options.journal === undefined || options.journal === "") {
		// Journal materialization only; this marker contains no browser ownership.
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Model-free crash fixture." }],
			api: "openai-completions",
			provider: "fixture",
			model: "fixture",
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
	}
	const state = () => ({
		pid: process.pid,
		journal: readString(sm.getSessionFile()),
		leaf: readString(sm.getLeafId()),
		branch: sm.getBranch().map((e) => e.id),
		entries: sm.getEntries().map((e) => e.id),
	});
	/** @param {unknown} value */
	async function handleMessage(value) {
		assert.ok(Check(workerRequest, value), "Invalid native worker request");
		switch (value.action) {
			case "call":
				await session.prompt(`/offbranch-test ${JSON.stringify(value.params)}`);
				send({ result, ...state() });
				break;
			case "branch":
				assert.equal(
					(await session.navigateTree(value.params, { summarize: false })).cancelled,
					false,
				);
				sm.appendMessage({
					role: "user",
					content: "Branch B without browser work",
					timestamp: Date.now(),
				});
				send(state());
				break;
			case "reload":
				await session.reload();
				send(state());
				break;
			case "dispose":
				session.dispose();
				send(state());
				process.disconnect();
				break;
		}
	}
	process.on("message", (value) => {
		handleMessage(value).catch((/** @type {unknown} */ error) => {
			send({ error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
		});
	});
	send(state());
}

/** @param {Omit<WorkerOptions, "journal"> & {receipts: Record<string, unknown>[]}} options */
export async function qualifyOffbranchRouting(options) {
	const ambient = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "p-")); // Short enough for namespaced stock sockets.
	const uid = process.getuid?.();
	assert.ok(uid !== undefined, "Native socket-root qualification needs a Unix user identity");
	const owned = `${process.platform === "darwin" ? "/private/tmp" : "/tmp"}/piab-${uid}`;
	/** @type {NodeJS.ProcessEnv} */
	const env = { ...process.env, AGENT_BROWSER_SOCKET_DIR: ambient };
	delete env.PI_AGENT_BROWSER_SOCKET_DIR;
	/** @type {ChildProcess[]} */
	const children = [];
	/** @type {NativeIdentity[]} */
	const identities = [];
	/** @param {ChildProcess} child @param {WorkerRequest} [outbound] @returns {Promise<WorkerState>} */
	const receive = (child, outbound) =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => finish({ error: new Error("native fixture worker timed out") }),
				30_000,
			);
			/** @param {number | null} code @param {NodeJS.Signals | null} signal */
			const exited = (code, signal) =>
				finish({
					error: new Error(`native fixture worker exited: ${String(code)}/${String(signal)}`),
				});
			/** @param {unknown} value */
			const message = (value) => {
				if (!Check(workerResponse, value)) {
					finish({ error: new Error("Invalid native fixture worker response") });
				} else if ("error" in value) {
					finish({ error: new Error(value.error) });
				} else {
					finish({ value });
				}
			};
			/** @param {{error: Error} | {value: WorkerState}} completion */
			function finish(completion) {
				clearTimeout(timer);
				child.off("exit", exited);
				child.off("message", message);
				if ("error" in completion) {
					reject(completion.error);
				} else {
					resolve(completion.value);
				}
			}
			child.once("exit", exited);
			child.once("message", message);
			if (outbound !== undefined) {
				child.send(outbound, (error) => {
					if (error) {
						finish({ error });
					}
				});
			}
		});
	/** @param {string} [journal] */
	const start = async (journal) => {
		const child = fork(
			fileURLToPath(import.meta.url),
			["worker", JSON.stringify({ ...options, receipts: undefined, journal })],
			{ env, stdio: ["ignore", "inherit", "inherit", "ipc"] },
		);
		children.push(child);
		return { child, state: await receive(child) };
	};
	/** @param {ChildProcess} child @param {Record<string, unknown>} params */
	const call = async (child, params) => {
		const value = await receive(child, { action: "call", params });
		const result = readBrowserToolResult(value.result);
		assert.notEqual(result.isError, true, JSON.stringify(value));
		return { ...value, result };
	};
	/** @param {NativeIdentity} identity @param {readonly string[]} args */
	const native = (identity, args) =>
		readRecord(
			readRecord(
				JSON.parse(
					execFileSync(
						"agent-browser",
						[
							"--json",
							"--namespace",
							identity.namespace ?? "",
							"--session",
							identity.name,
							...args,
						],
						{
							encoding: "utf8",
							timeout: 10_000,
							env: { ...env, AGENT_BROWSER_SOCKET_DIR: identity.socketDir },
						},
					),
				),
			).data,
		);
	/** @param {NativeIdentity} identity */
	const status = (identity) => {
		const value = native(identity, ["session", "info"]);
		return readNativeSessionInfo(value);
	};
	/** @param {NativeIdentity} identity */
	const close = async (identity) => {
		native(identity, ["close"]);
		for (let i = 0; i < 100 && status(identity).active; i++) {
			// Poll only after the previous native close status check and delay.
			await delay(50);
		}
		assert.equal(status(identity).active, false);
	};
	try {
		const first = await start();
		const opened = await call(first.child, { args: ["open", "about:blank"], sessionMode: "fresh" });
		const fresh = { name: readString(opened.result.details.sessionName), socketDir: owned };
		identities.push(fresh);
		const live = status(fresh);
		assert.equal(live.active, true);
		assert.ok(live.runtime);
		assert.equal(live.runtime.browserLaunched, true);
		assert.equal(live.runtime.pageCount, 1);
		assert.equal(status({ ...fresh, socketDir: ambient }).active, false);
		const branch = await receive(first.child, { action: "branch", params: first.state.leaf });
		assert.equal(branch.branch.includes(opened.leaf), false);
		assert.equal(branch.entries.includes(opened.leaf), true);
		assert.equal(status(fresh).pid, live.pid, "tree navigation must preserve the live daemon");
		const exited = once(first.child, "exit");
		first.child.kill("SIGKILL"); // Exact owned SDK PID only; never the daemon/process group.
		assert.deepEqual(await exited, [null, "SIGKILL"]);
		assert.equal(status(fresh).pid, live.pid);

		const second = await start(branch.journal);
		assert.notEqual(second.state.pid, first.state.pid);
		assert.equal(second.state.leaf, branch.leaf);
		assert.equal(second.state.branch.includes(opened.leaf), false);
		assert.equal(second.state.entries.includes(opened.leaf), true);
		options.receipts.push({
			label: "real crash/reopen provenance",
			firstPiPid: first.state.pid,
			secondPiPid: second.state.pid,
			live,
			ambient: status({ ...fresh, socketDir: ambient }),
			actualOpenDetails: opened.result.details,
		});
		assert.equal(status(fresh).pid, live.pid);
		await receive(second.child, { action: "reload" });
		assert.equal(
			status(fresh).pid,
			live.pid,
			"inspection must not acquire off-branch cleanup ownership",
		);

		// One namespace/name can identify two native daemons in different socket roots.
		const sameCaller = { ...fresh, socketDir: ambient };
		identities.push(sameCaller);
		const sameArgs = ["--namespace", "", "--session", fresh.name];
		const sameOpened = await call(second.child, {
			args: [...sameArgs, "open", "about:blank"],
			sessionMode: "fresh",
		});
		const sameLive = status(sameCaller);
		assert.equal(sameLive.active, true);
		assert.notEqual(sameLive.pid, live.pid);
		assert.equal(status(fresh).pid, live.pid);
		options.receipts.push({
			label: "same identity both roots live",
			owned: status(fresh),
			ambient: sameLive,
			callerLeaf: sameOpened.leaf,
			actualCallerDetails: sameOpened.result.details,
		});
		await receive(second.child, { action: "reload" });
		assert.equal(status(fresh).pid, live.pid);
		assert.equal(
			status(sameCaller).pid,
			sameLive.pid,
			"inspection must not acquire caller cleanup ownership",
		);
		await call(second.child, { args: [...sameArgs, "close"] });
		await close(sameCaller);
		assert.equal(status(fresh).pid, live.pid);
		options.receipts.push({
			label: "same identity caller closed only",
			owned: status(fresh),
			ambient: status(sameCaller),
		});
		await close(fresh);

		// Exact wrapper base/fresh pattern is not provenance. Explicit fresh is still caller-owned.
		// The exact historical identity and another namespace must retain ambient routing too.
		for (const identity of [
			{ name: fresh.name, socketDir: ambient },
			{ name: fresh.name.replace(/fresh-.+$/, "fresh-caller"), socketDir: ambient },
			{ name: fresh.name, namespace: "c", socketDir: ambient },
		]) {
			identities.push(identity);
			const args = ["--namespace", identity.namespace ?? "", "--session", identity.name];
			// Each provenance case owns one live session until its explicit close below.
			const callerOpened = await call(second.child, {
				args: [...args, "open", "about:blank"],
				sessionMode: "fresh",
			});
			const caller = status(identity);
			assert.equal(caller.active, true);
			assert.equal(status({ ...identity, socketDir: owned }).active, false);
			options.receipts.push({
				label: "explicit caller provenance",
				ambient: caller,
				owned: status({ ...identity, socketDir: owned }),
				callerLeaf: callerOpened.leaf,
				actualCallerDetails: callerOpened.result.details,
			});
			// Reload observes the live session from this iteration before its close.
			await receive(second.child, { action: "reload" });
			assert.equal(status(identity).pid, caller.pid);
			// Close this case before the next identity uses the same native socket root.
			await call(second.child, { args: [...args, "close"] });
			// Confirm daemon retirement before advancing to the next identity.
			await close(identity);
		}
		const done = once(second.child, "exit");
		await receive(second.child, { action: "dispose" });
		assert.deepEqual(await done, [0, null]);
	} finally {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) {
				const done = once(child, "exit");
				child.kill("SIGKILL");
				// Reap each owned SDK worker before closing its native daemon identities.
				await done;
			}
		}
		for (const identity of identities) {
			// Cleanup identities can share namespace/socket resources, so retire them in order.
			await close(identity);
		}
		await rm(ambient, { recursive: true, force: true });
	}
}

if (process.argv[2] === "worker") {
	/** @type {unknown} */
	const options = JSON.parse(readString(process.argv[3]));
	assert.ok(Check(workerOptions, options), "Invalid native worker options");
	await worker(options);
}
