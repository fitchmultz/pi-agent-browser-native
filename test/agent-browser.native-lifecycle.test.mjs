// Opt-in, model-free integration with the public Pi SDK and
// stock agent-browser. Run in an isolated HOME (empty browser profiles only).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { qualifyOffbranchRouting } from "./helpers/lifecycle-offbranch-native.mjs";

const sdkPath = process.env.PI_NATIVE_LIFECYCLE_SDK;
const required = process.env.PI_NATIVE_LIFECYCLE_REQUIRED === "1";
const extensionPath = resolve(process.env.PI_NATIVE_LIFECYCLE_EXTENSION ?? ".");

test(
	"native public SDK lifecycle, ordering, cancellation, and stable root restore",
	{ skip: !sdkPath && !required, timeout: 240_000 },
	async (t) => {
		if (required) {
			// Exhaustive fixture variant (required): this selected path must satisfy its own contract.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.ok(sdkPath, "PI_NATIVE_LIFECYCLE_REQUIRED=1 requires PI_NATIVE_LIFECYCLE_SDK");
			// Exhaustive fixture variant (required): this selected path must satisfy its own contract.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.notEqual(
				process.getuid?.(),
				0,
				"Required qualification must run non-root for EACCES fault injection",
			);
		}
		const sdk = await import(pathToFileURL(sdkPath).href);
		assert.equal(typeof sdk.createAgentSession, "function");
		assert.ok(
			process.env.PI_NATIVE_LIFECYCLE_BROWSER_DIR,
			"Supply an installed stock Chrome-for-Testing directory (binaries only)",
		);
		const browserDir = resolve(process.env.PI_NATIVE_LIFECYCLE_BROWSER_DIR);
		const originalEnv = { ...process.env };
		const root = await mkdtemp(join(tmpdir(), "piab-lc-"));
		const artifactsDir = resolve(
			process.env.PI_NATIVE_LIFECYCLE_ARTIFACT_DIR ?? `${root}-transcripts`,
		);
		let session, sm, result, callController, beforeResult, rootName;
		const nativeSessions = new Map();
		const receipts = [];
		const server = createServer((_req, res) => {
			res.setHeader("content-type", "text/html");
			res.end("<!doctype html><title>Lifecycle fixture</title><h1>Empty-profile fixture</h1>");
		});
		t.after(async () => {
			try {
				const journal = sm?.getSessionFile();
				if (journal) {
					await chmod(journal, 0o600).catch(() => {
						// A journal fault must not prevent independent native-session cleanup.
					});
				}
				beforeResult = undefined;
				callController?.abort();
				if (rootName) {
					await call({ args: ["--session", rootName, "close"] }).catch(() => {
						// Replay failure is tolerated here; every recorded identity is closed natively below.
					});
				}
				await session?.reload().catch(() => {
					// Faulted reload cannot own cleanup; native identities are independently closed below.
				});
				session?.dispose();
				// Cleanup must not depend on extension replay succeeding after a journal fault.
				for (const { name, socketDir, namespace } of nativeSessions.values()) {
					const env = { ...process.env, AGENT_BROWSER_SOCKET_DIR: socketDir };
					const args = ["--json", "--namespace", namespace, "--session", name];
					execFileSync("agent-browser", [...args, "close"], { env, timeout: 5000 });
					let status;
					for (let i = 0; i < 100; i++) {
						status = JSON.parse(
							execFileSync("agent-browser", [...args, "session", "info"], {
								env,
								encoding: "utf8",
								timeout: 5000,
							}),
						);
						if (status.data.active === false) {
							break;
						}
						await delay(50);
					}
					// Exhaustive fixture variant (nativeSessions.values()): this selected path must satisfy its own contract.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(status.data.active, false, JSON.stringify(status));
				}
			} finally {
				try {
					await new Promise((done) => server.close(done));
					console.log(JSON.stringify({ receipts }));
					// Preserve the real Pi journals, including abnormal-restart evidence, before cleanup.
					await mkdir(artifactsDir, { recursive: true });
					for (const name of ["sessions", "restore-sessions", "crash-sessions", "fault-sessions"]) {
						await cp(join(root, name), join(artifactsDir, name), { recursive: true }).catch(
							(error) => {
								if (error.code !== "ENOENT") {
									throw error;
								}
							},
						);
					}
					await writeFile(
						join(artifactsDir, "receipts.json"),
						JSON.stringify({ receipts }, null, 2),
					);
					console.log(`Native lifecycle transcripts: ${artifactsDir}`);
				} finally {
					await rm(root, { recursive: true, force: true }).finally(() => {
						for (const key of Object.keys(process.env)) {
							if (!(key in originalEnv)) {
								delete process.env[key];
							}
						}
						Object.assign(process.env, originalEnv);
					});
				}
			}
		});
		for (const key of Object.keys(process.env)) {
			if (
				/^(AGENT_BROWSER_|PI_AGENT_BROWSER_|PI_SUBAGENT_|EXA_API_KEY$|BRAVE_API_KEY$)/i.test(key) ||
				/^(https?|all|no)_proxy$/i.test(key)
			) {
				delete process.env[key];
			}
		}
		process.env.HOME = join(root, "home");
		process.env.PI_AGENT_BROWSER_SOCKET_DIR = join(root, "sockets");
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
		process.env.PI_OFFLINE = "1";
		await mkdir(join(process.env.HOME, ".agent-browser", "browsers"), { recursive: true });
		await cp(
			browserDir,
			join(process.env.HOME, ".agent-browser", "browsers", browserDir.split(/[\\/]/).at(-1)),
			{ recursive: true },
		);
		const cwd = join(root, "checkout");
		const agentDir = join(root, "agent");
		await mkdir(join(cwd, ".git"), { recursive: true });
		await mkdir(agentDir);
		await new Promise((done) => server.listen(0, "127.0.0.1", done));
		const url = `http://127.0.0.1:${server.address().port}/fixture`;
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
		let callId = 0;
		const createLoader = () =>
			new sdk.DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				noExtensions: true,
				noContextFiles: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				additionalExtensionPaths: [extensionPath],
				extensionFactories: [
					(pi) =>
						pi.registerCommand("lifecycle-browser-test", {
							description: "Model-free test dispatch",
							handler: async (args) => {
								const params = JSON.parse(args);
								const toolName = params.code === undefined ? "agent_browser" : "agent_browser_code";
								const tool = session.agent.state.tools.find(
									(candidate) => candidate.name === toolName,
								);
								assert.ok(tool);
								const id = `lifecycle-call-${++callId}`;
								result = await tool.execute(id, params, callController?.signal);
								if (result.details?.sessionName) {
									const identity = {
										name: result.details.sessionName,
										socketDir:
											result.details.managedSessionSocketDir ??
											process.env.PI_AGENT_BROWSER_SOCKET_DIR ??
											process.env.AGENT_BROWSER_SOCKET_DIR,
										namespace: params.args?.includes("--namespace")
											? params.args[params.args.indexOf("--namespace") + 1]
											: "",
									};
									nativeSessions.set(JSON.stringify(identity), identity);
								}
								await beforeResult?.();
								// Real native entries from real tool results, without a model/provider call.
								sm.appendMessage({
									role: "toolResult",
									toolCallId: id,
									toolName,
									content: result.content,
									details: result.details,
									isError: result.isError === true,
									timestamp: Date.now(),
								});
							},
						}),
				],
			});
		let loader = createLoader();
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		sm = sdk.SessionManager.create(cwd, join(root, "sessions"));
		({ session } = await sdk.createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			resourceLoader: loader,
			settingsManager,
			sessionManager: sm,
			noTools: "builtin",
		}));
		await session.bindExtensions({
			onError: (e) => {
				throw new Error(e.error);
			},
		});
		// Materialize the synthetic native journal without invoking a provider.
		const publishFixture = () =>
			sm.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "Synthetic lifecycle fixture." }],
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
		publishFixture();
		const call = async (params) => {
			await session.prompt(`/lifecycle-browser-test ${JSON.stringify(params)}`);
			return result;
		};
		const ok = async (params) => {
			const value = await call(params);
			assert.notEqual(value.isError, true, JSON.stringify(value));
			// Native close can acknowledge before its daemon finishes exiting (macOS).
			// Observe that exit independently before reusing or deleting its socket root.
			if (params.args?.at(-1) === "close") {
				const name = value.details.sessionName;
				// Exhaustive fixture variant (params.args?.at(-1) === "close"): this selected path must satisfy its own contract.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.ok(name);
				let status;
				for (let i = 0; i < 100; i++) {
					status = JSON.parse(
						execFileSync(
							"agent-browser",
							["--json", "--namespace", "", "--session", name, "session", "info"],
							{
								encoding: "utf8",
								timeout: 5000,
								env: {
									...process.env,
									AGENT_BROWSER_SOCKET_DIR: process.env.PI_AGENT_BROWSER_SOCKET_DIR,
								},
							},
						),
					);
					if (status.data.active === false) {
						break;
					}
					await delay(50);
				}
				// Exhaustive fixture variant (params.args?.at(-1) === "close"): this selected path must satisfy its own contract.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(status.data.active, false, JSON.stringify(status));
			}
			return value;
		};
		const waitFor = async (predicate) => {
			for (let i = 0; i < 200; i++) {
				if (predicate()) {
					return;
				}
				await delay(25);
			}
			throw new Error("fixture did not reach expected state");
		};
		await t.test("idle help and native reload remain usable", async () => {
			const version = await ok({ args: ["--version"] });
			await session.reload();
			const reloaded = await ok({ args: ["--version"] });
			assert.deepEqual(reloaded.content, version.content);
		});
		await t.test("detached SDK code cancels and releases its execution lease", async () => {
			const controller = new AbortController();
			const tool = session.agent.state.tools.find(
				(candidate) => candidate.name === "agent_browser_code",
			);
			const running = tool.execute(
				"detached-code",
				{ code: "await new Promise(() => {});", timeoutMs: 10_000 },
				controller.signal,
			);
			let cancelled;
			try {
				await delay(200);
			} finally {
				controller.abort();
				cancelled = await running;
			}
			assert.equal(cancelled.isError, true);
			assert.equal(cancelled.details.failureCategory, "aborted");
			await ok({ code: 'emit("lease released");' });
		});
		await t.test(
			"root browser survives branch navigation and reload with routes and traces",
			async () => {
				const beforeBrowser = sm.getLeafId();
				const opened = await ok({ args: ["open", url] });
				rootName = opened.details.sessionName;
				assert.match(rootName, /^pi-root-/);
				const live = await ok({ args: ["--session", rootName, "session", "info"] });
				assert.equal(live.details.data.active, true);
				await session.navigateTree(beforeBrowser, { summarize: false });
				await session.reload();
				const reloaded = await ok({ args: ["--session", rootName, "session", "info"] });
				assert.equal(reloaded.details.data.pid, live.details.data.pid);
				assert.equal(
					(await ok({ args: ["--session", rootName, "get", "url"] })).details.data.url,
					url,
				);
				await ok({ args: ["network", "route", "**/unused-fixture", "--abort"] });
				await session.reload();
				const blocked = await ok({
					args: ["eval", "--stdin"],
					stdin:
						'(async () => { try { await fetch("/unused-fixture"); return false; } catch { return true; } })()',
				});
				assert.equal(blocked.details.data.result, true, "native route must survive reload");
				await ok({ args: ["network", "unroute", "**/unused-fixture"] });
				const unblocked = await ok({
					args: ["eval", "--stdin"],
					stdin: 'fetch("/unused-fixture").then(response => response.ok)',
				});
				assert.equal(
					unblocked.details.data.result,
					true,
					"explicit unroute must release the request",
				);
				await ok({ args: ["trace", "start"] });
				await session.reload();
				await ok({ args: ["trace", "stop", join(root, "trace.zip")] });
				assert.ok((await stat(join(root, "trace.zip"))).size > 0);
				await ok({ args: ["close"] });
			},
		);
		await t.test("caller-owned attachment survives reload until explicit close", async () => {
			await ok({ args: ["open", url] });
			const endpoint = await ok({ args: ["get", "cdp-url"] });
			const attached = `lifecycle-attached-${sm.getSessionId()}`;
			try {
				await ok({ args: ["--session", attached, "connect", endpoint.details.data.cdpUrl] });
				await session.reload();
				assert.equal(
					(await ok({ args: ["--session", attached, "get", "url"] })).details.data.url,
					url,
				);
			} finally {
				await ok({ args: ["--session", attached, "close"] });
			}
			await ok({ args: ["--session", rootName, "close"] });
		});
		await t.test("explicit URL read leaves native unnamed launch caller-owned", async () => {
			const profile = join(root, "empty-profile");
			await mkdir(profile);
			try {
				const read = await ok({ args: ["--profile", profile, "read", url] });
				assert.equal(read.details.sessionName, undefined);
				const status = JSON.parse(
					execFileSync(
						"agent-browser",
						["--json", "--namespace", "", "--session", "default", "session", "info"],
						{
							encoding: "utf8",
							timeout: 5000,
							env: {
								...process.env,
								AGENT_BROWSER_SOCKET_DIR: process.env.PI_AGENT_BROWSER_SOCKET_DIR,
							},
						},
					),
				);
				assert.equal(status.data.active, true);
				assert.equal(status.data.runtime.browserLaunched, true);
				receipts.push({
					label: "unnamed native browser observation",
					daemonActive: true,
					browserLaunched: true,
				});
				await session.reload();
				const reloaded = await ok({ args: ["--session", "default", "session", "info"] });
				assert.equal(reloaded.details.data.active, true);
				assert.equal(reloaded.details.data.pid, status.data.pid);
			} finally {
				await ok({ args: ["--session", "default", "close"] });
			}
		});
		await t.test("managed fresh browser keeps ordinary ownership and cleanup", async () => {
			const opened = await ok({ args: ["open", url], sessionMode: "fresh" });
			assert.match(opened.details.sessionName, /^piab-/);
			const live = await ok({
				args: ["--session", opened.details.sessionName, "session", "info"],
			});
			await session.reload();
			const reloaded = await ok({
				args: ["--session", opened.details.sessionName, "session", "info"],
			});
			assert.equal(reloaded.details.data.pid, live.details.data.pid);
			assert.equal((await ok({ args: ["get", "url"] })).details.data.url, url);
			await ok({ args: ["close"] });
		});
		await t.test("failed journal begin prevents stopping a live native recording", async () => {
			// A failed native append can remain memory-only; isolate this fault rather than
			// claiming that the public SDK repairs unpublished journal ancestry.
			const previous = { session, sm, loader };
			sm = sdk.SessionManager.create(cwd, join(root, "fault-sessions"));
			loader = createLoader();
			await loader.reload();
			({ session } = await sdk.createAgentSession({
				cwd,
				agentDir,
				modelRuntime,
				resourceLoader: loader,
				settingsManager,
				sessionManager: sm,
				noTools: "builtin",
			}));
			await session.bindExtensions({
				onError: (e) => {
					throw new Error(e.error);
				},
			});
			publishFixture();
			let recordingSession;
			try {
				const opened = await ok({ args: ["open", url] });
				recordingSession = opened.details.sessionName;
				await ok({ args: ["record", "start", join(root, "record.webm")] });
				await delay(12_000);
				await chmod(sm.getSessionFile(), 0o400);
				beforeResult = () => chmod(sm.getSessionFile(), 0o600);
				const stopped = await call({ args: ["record", "stop"] });
				beforeResult = undefined;
				assert.equal(stopped.isError, true);
				assert.equal(
					stopped.details.browserStatePersistence,
					"begin-unconfirmed",
					"an unwritable begin must prevent native record stop",
				);
				const recorded = await ok({
					args: ["--session", opened.details.sessionName, "record", "stop"],
				});
				assert.ok(
					recorded.details.data.frames > 0,
					"the failed begin cannot have stopped native recording",
				);
				await ok({ args: ["close"] });
			} finally {
				try {
					await chmod(sm.getSessionFile(), 0o600);
					beforeResult = undefined;
					if (recordingSession) {
						await ok({ args: ["--session", recordingSession, "close"] });
					}
				} finally {
					session.dispose();
					({ session, sm, loader } = previous);
				}
			}
		});
		await t.test(
			"queued browser call waits for code cancellation and preserves its browser",
			async () => {
				callController = new AbortController();
				const before = sm.getEntries().length;
				const running = call({
					code: `await browser({args:["open",${JSON.stringify(url)}]}); await new Promise(() => {});`,
					timeoutMs: 30_000,
				});
				let queued;
				try {
					await waitFor(() =>
						sm
							.getEntries()
							.slice(before)
							.some(
								(entry) =>
									entry.type === "custom" &&
									entry.customType === "agent-browser-transition" &&
									entry.data?.event?.phase === "finish" &&
									entry.data.event.isError === false,
							),
					);
					let settled = false;
					const tool = session.agent.state.tools.find(
						(candidate) => candidate.name === "agent_browser",
					);
					queued = tool.execute("queued-during-code", { args: ["get", "title"] }).then((value) => {
						settled = true;
						return value;
					});
					await delay(100);
					assert.equal(settled, false, "the code cell must retain its whole-cell browser lock");
				} finally {
					callController.abort();
					await running;
					callController = undefined;
				}
				assert.equal(result.details.failureCategory, "aborted", JSON.stringify(result));
				const codeSessionName = result.details.sessionName;
				const followed = await queued;
				assert.notEqual(followed.isError, true, JSON.stringify(followed));
				assert.equal(followed.details.data.title, "Lifecycle fixture");
				receipts.push({
					label: "code cancellation releases ordered follow-up",
					sessionName: codeSessionName,
					failureCategory: result.details.failureCategory,
				});
				await session.reload();
				assert.equal(
					(await ok({ args: ["--session", codeSessionName, "get", "url"] })).details.data.url,
					url,
				);
				await ok({ args: ["--session", codeSessionName, "close"] });
			},
		);
		await t.test(
			"native root restore survives fresh checkout and state-directory inodes",
			async () => {
				// Independently qualify root save/reopen with a fresh native session.
				session.dispose();
				loader = createLoader();
				await loader.reload();
				sm = sdk.SessionManager.create(cwd, join(root, "restore-sessions"));
				({ session } = await sdk.createAgentSession({
					cwd,
					agentDir,
					modelRuntime,
					resourceLoader: loader,
					settingsManager,
					sessionManager: sm,
					noTools: "builtin",
				}));
				await session.bindExtensions({
					onError: (e) => {
						throw new Error(e.error);
					},
				});
				publishFixture();
				const opened = await ok({ args: ["open", url] });
				rootName = opened.details.sessionName;
				assert.match(rootName, /^pi-root-/);
				const nativeStatus = await ok({ args: ["--session", rootName, "session", "info"] });
				assert.equal(nativeStatus.details.data.runtime.restoreKey, rootName);
				await ok({
					args: ["eval", "--stdin"],
					stdin:
						'document.cookie="lifecycle_fixture=synthetic;path=/;max-age=3600"; localStorage.setItem("fixture","local"); sessionStorage.setItem("fixture","session"); true',
				});
				await ok({ args: ["close"] });
				const saved = {
					journal: sm.getSessionFile(),
					sessionId: sm.getSessionId(),
					leaf: sm.getLeafId(),
					entries: sm.getEntries(),
					activeTools: session.getActiveToolNames(),
				};
				const stateDir = join(process.env.HOME, ".agent-browser", "sessions");
				const before = { cwd: (await stat(cwd)).ino, state: (await stat(stateDir)).ino };
				const marker = join(cwd, ".git", "fixture-marker");
				await writeFile(marker, "stable synthetic checkout\n");
				for (const dir of [cwd, stateDir]) {
					await cp(dir, `${dir}.copy`, { recursive: true });
					await rename(dir, `${dir}.old`);
					await rename(`${dir}.copy`, dir);
					await rm(`${dir}.old`, { recursive: true });
				}
				assert.notEqual((await stat(cwd)).ino, before.cwd);
				assert.notEqual((await stat(stateDir)).ino, before.state);
				assert.equal(await readFile(marker, "utf8"), "stable synthetic checkout\n");
				// Cold extension instance through the public persisted-session factory path.
				session.dispose();
				loader = createLoader();
				await loader.reload();
				({ session } = await sdk.createAgentSession({
					sessionManager: sdk.SessionManager.open(saved.journal),
					cwd,
					agentDir,
					modelRuntime,
					resourceLoader: loader,
					settingsManager,
					noTools: "builtin",
				}));
				sm = session.sessionManager;
				await session.bindExtensions({
					onError: (e) => {
						throw new Error(e.error);
					},
				});
				assert.equal(sm.getSessionId(), saved.sessionId);
				assert.equal(sm.getLeafId(), saved.leaf);
				assert.equal(JSON.stringify(sm.getEntries()), JSON.stringify(saved.entries));
				assert.deepEqual(session.getActiveToolNames(), saved.activeTools);
				const reopened = await ok({ args: ["open", url] });
				assert.equal(reopened.details.sessionName, rootName);
				const restoredStatus = await ok({ args: ["--session", rootName, "session", "info"] });
				assert.equal(restoredStatus.details.data.runtime.restoreKey, rootName);
				const observed = await ok({
					args: ["eval", "--stdin"],
					stdin:
						'({checks:[document.cookie === "lifecycle_fixture=synthetic", localStorage.getItem("fixture") === "local", sessionStorage.getItem("fixture") === "session"]})',
				});
				assert.deepEqual(observed.details.data.result, { checks: [true, true, true] });
				receipts.push({
					label: "stable root fresh filesystem restore",
					sessionName: rootName,
					cwdInodeChanged: true,
					stateInodeChanged: true,
					syntheticStateRestored: true,
				});
				await ok({ args: ["close"] });
			},
		);
		await t.test("stable ambient sockets preserve owned and caller-owned routing", async () => {
			const piSockets = process.env.PI_AGENT_BROWSER_SOCKET_DIR;
			const ambient = join(root, "ambient");
			const ownedSockets = `${process.platform === "darwin" ? "/private/tmp" : "/tmp"}/piab-${process.getuid()}`;
			await mkdir(ambient, { mode: 0o700 });
			delete process.env.PI_AGENT_BROWSER_SOCKET_DIR;
			process.env.AGENT_BROWSER_SOCKET_DIR = ambient;
			const status = (name, socketDir, namespace = "") =>
				JSON.parse(
					execFileSync(
						"agent-browser",
						["--json", "--namespace", namespace, "--session", name, "session", "info"],
						{
							encoding: "utf8",
							timeout: 5000,
							env: { ...process.env, AGENT_BROWSER_SOCKET_DIR: socketDir },
						},
					),
				).data;
			const close = async (name, socketDir, namespace = "") => {
				const closed = await call({
					args: ["--namespace", namespace, "--session", name, "close"],
				});
				assert.notEqual(closed.isError, true, JSON.stringify(closed));
				for (let i = 0; i < 100 && status(name, socketDir, namespace).active; i++) {
					await delay(50);
				}
				assert.equal(status(name, socketDir, namespace).active, false);
			};
			let fresh;
			const caller = "piab-caller-fixture"; // A name prefix is not cleanup ownership.
			try {
				const openedRoot = await ok({ args: ["open", url] });
				assert.equal(openedRoot.details.sessionName, rootName);
				const rootStatus = status(rootName, ambient);
				assert.equal(rootStatus.active, true);
				assert.equal(status(rootName, ownedSockets).active, false);
				await session.reload();
				assert.equal(status(rootName, ambient).pid, rootStatus.pid);
				await close(rootName, ambient);

				const opened = await ok({ args: ["open", url], sessionMode: "fresh" });
				fresh = opened.details.sessionName;
				assert.match(fresh, /^piab-/);
				const live = status(fresh, ownedSockets);
				assert.equal(live.active, true);
				assert.equal(live.runtime.browserLaunched, true);
				assert.equal(live.runtime.pageCount, 1);
				assert.equal(status(fresh, ambient).active, false);
				receipts.push({
					label: "distinct stable socket roots",
					sessionName: fresh,
					owned: live,
					ambient: status(fresh, ambient),
				});
				assert.equal(status(fresh, ownedSockets).pid, live.pid);
				await session.reload();
				assert.equal(status(fresh, ownedSockets).pid, live.pid);
				await close(fresh, ownedSockets);
				fresh = undefined;

				await ok({ args: ["--namespace", "caller", "--session", caller, "open", url] });
				const callerStatus = status(caller, ambient, "caller");
				assert.equal(callerStatus.active, true);
				assert.equal(status(caller, ownedSockets, "caller").active, false);
				await session.reload();
				assert.equal(status(caller, ambient, "caller").pid, callerStatus.pid);
				await close(caller, ambient, "caller");
				assert.equal(process.env.PI_AGENT_BROWSER_SOCKET_DIR, undefined);
				assert.equal(process.env.AGENT_BROWSER_SOCKET_DIR, ambient);
			} finally {
				if (fresh) {
					await close(fresh, ownedSockets);
				}
				await close(caller, ambient, "caller");
				await close(rootName, ambient);
				delete process.env.AGENT_BROWSER_SOCKET_DIR;
				process.env.PI_AGENT_BROWSER_SOCKET_DIR = piSockets;
			}
		});
		await t.test(
			"historical ownership survives abnormal restart without acquiring cleanup ownership",
			async () => {
				await qualifyOffbranchRouting({ root, cwd, agentDir, sdkPath, extensionPath, receipts });
			},
		);
	},
);
