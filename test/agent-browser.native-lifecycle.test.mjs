// Opt-in, model-free integration with the public Pi SDK and
// stock agent-browser. Run in an isolated HOME (empty browser profiles only).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadNativeSdk } from "./helpers/native-probe-modules.mjs";
import { setTimeout as delay } from "node:timers/promises";
import nodeTest from "node:test";
import { once } from "node:events";
import { readBrowserToolResult, readToolArguments } from "./helpers/tool-result.mjs";
import { readNativeSessionInfo } from "./helpers/native-session-info.mjs";
import { getMessageText } from "../dist/extensions/agent-browser/lib/prompt-policy.js";
import {
	readDefined,
	readRecord,
	readArray,
	readString,
	readNumber,
	hasErrorCode,
} from "./helpers/assertions.ts";
/** @import {AgentSession, SessionManager} from "@earendil-works/pi-coding-agent" */
/** @import {BrowserToolResult} from "./helpers/tool-result.mjs" */
/** @typedef {import("../extensions/agent-browser/lib/orchestration/input-plan.js").AgentBrowserExecuteParams} NativeInput */
/** @typedef {{name: string, socketDir: string, namespace: string}} NativeIdentity */
import { qualifyOffbranchRouting } from "./helpers/lifecycle-offbranch-native.mjs";

const sdkPath = process.env.PI_NATIVE_LIFECYCLE_SDK;
const required = process.env.PI_NATIVE_LIFECYCLE_REQUIRED === "1";
const extensionPath = resolve(process.env.PI_NATIVE_LIFECYCLE_EXTENSION ?? ".");

nodeTest(
	"native public SDK lifecycle, ownership, and stable root restore",
	{ skip: (sdkPath === undefined || sdkPath === "") && !required, timeout: 240_000 },
	async (t) => {
		assert.ok(
			sdkPath !== undefined && sdkPath !== "",
			"A native lifecycle check needs its selected SDK path",
		);
		assert.ok(
			!required || process.getuid?.() !== 0,
			"Required qualification must run non-root for EACCES fault injection",
		);
		const sdk = await loadNativeSdk(sdkPath);
		assert.equal(typeof sdk.createAgentSession, "function");
		assert.ok(
			process.env.PI_NATIVE_LIFECYCLE_BROWSER_DIR !== undefined &&
				process.env.PI_NATIVE_LIFECYCLE_BROWSER_DIR !== "",
			"Supply an installed stock Chrome-for-Testing directory (binaries only)",
		);
		const browserDir = resolve(readString(process.env.PI_NATIVE_LIFECYCLE_BROWSER_DIR));
		const originalEnv = { ...process.env };
		// The macOS per-user temp path exceeds the native Unix-socket limit with full session names.
		const root = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "piab-lc-"));
		const artifactsDir = resolve(
			process.env.PI_NATIVE_LIFECYCLE_ARTIFACT_DIR ?? `${root}-transcripts`,
		);
		/** @type {AgentSession | undefined} */
		let session;
		/** @type {SessionManager | undefined} */
		let sm;
		/** @type {BrowserToolResult | undefined} */
		let result;
		/** @type {(() => Promise<void>) | undefined} */
		let beforeResult;
		/** @type {string | undefined} */
		let rootName;
		/** @type {Map<string, NativeIdentity>} */
		const nativeSessions = new Map();
		/** @type {Record<string, unknown>[]} */
		const receipts = [];
		const server = createServer((_req, res) => {
			res.setHeader("content-type", "text/html");
			res.end("<!doctype html><title>Lifecycle fixture</title><h1>Empty-profile fixture</h1>");
		});
		t.after(async () => {
			try {
				const journal = sm?.getSessionFile();
				if (journal !== undefined && journal !== "") {
					await chmod(journal, 0o600).catch(() => {
						// A journal fault must not prevent independent native-session cleanup.
					});
				}
				beforeResult = undefined;
				if (rootName !== undefined && rootName !== "") {
					await call({ args: ["--session", readString(rootName), "close"] }).catch(() => {
						// Replay failure is tolerated here; every recorded identity is closed natively below.
					});
				}
				await session?.reload().catch(() => {
					// Faulted reload cannot own cleanup; native identities are independently closed below.
				});
				session?.dispose();
				// Cleanup must not depend on extension replay succeeding after a journal fault.
				/** @type {{name: string, active: boolean}[]} */
				const closedSessions = [];
				for (const { name, socketDir, namespace } of nativeSessions.values()) {
					const env = { ...process.env, AGENT_BROWSER_SOCKET_DIR: socketDir };
					const args = ["--json", "--namespace", namespace, "--session", name];
					execFileSync("agent-browser", [...args, "close"], { env, timeout: 5000 });
					let status;
					for (let i = 0; i < 100; i++) {
						status = readNativeSessionInfo(
							readRecord(
								JSON.parse(
									execFileSync("agent-browser", [...args, "session", "info"], {
										env,
										encoding: "utf8",
										timeout: 5000,
									}),
								),
							).data,
						);
						if (!status.active) {
							break;
						}
						await delay(50);
					}
					closedSessions.push({ name, active: readDefined(status).active });
				}
				assert.deepEqual(
					closedSessions.filter(({ active }) => active),
					[],
					"All fixture native daemons must exit",
				);
			} finally {
				try {
					await new Promise((done) => {
						server.close(done);
					});
					console.log(JSON.stringify({ receipts }));
					// Preserve the real Pi journals, including abnormal-restart evidence, before cleanup.
					await mkdir(artifactsDir, { recursive: true });
					for (const name of ["sessions", "restore-sessions", "crash-sessions", "fault-sessions"]) {
						await cp(join(root, name), join(artifactsDir, name), { recursive: true }).catch(
							(/** @type {unknown} */ error) => {
								if (!hasErrorCode(error, "ENOENT")) {
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
				/^(AGENT_BROWSER_|PI_AGENT_BROWSER_|PI_SUBAGENT_|PI_INTERCOM_(ROOT|PARENT)_SESSION_ID$|EXA_API_KEY$|BRAVE_API_KEY$)/i.test(
					key,
				) ||
				/^(https?|all|no)_proxy$/i.test(key)
			) {
				delete process.env[key];
			}
		}
		const home = join(root, "home");
		process.env.HOME = home;
		process.env.PI_AGENT_BROWSER_SOCKET_DIR = join(root, "sockets");
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
		process.env.PI_OFFLINE = "1";
		await mkdir(join(home, ".agent-browser", "browsers"), { recursive: true });
		await cp(
			browserDir,
			join(home, ".agent-browser", "browsers", readDefined(browserDir.split(/[\\/]/).at(-1))),
			{ recursive: true },
		);
		const cwd = join(root, "checkout");
		const agentDir = join(root, "agent");
		await mkdir(join(cwd, ".git"), { recursive: true });
		await mkdir(agentDir);
		const listening = once(server, "listening");
		server.listen(0, "127.0.0.1");
		await listening;
		const address = server.address();
		assert.ok(address !== null && typeof address === "object");
		const url = `http://127.0.0.1:${address.port}/fixture`;
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
								const params = readToolArguments(JSON.parse(args));
								const toolName = "agent_browser";
								const tool = readDefined(session).agent.state.tools.find(
									(candidate) => candidate.name === toolName,
								);
								assert.ok(tool);
								const id = `lifecycle-call-${++callId}`;
								result = readBrowserToolResult(await tool.execute(id, params));
								if (
									typeof result.details.sessionName === "string" &&
									result.details.sessionName !== ""
								) {
									const inputArgs =
										params.args === undefined ? [] : readArray(params.args).map(readString);
									const identity = {
										name: result.details.sessionName,
										socketDir: readString(
											result.details.managedSessionSocketDir ??
												process.env.PI_AGENT_BROWSER_SOCKET_DIR ??
												process.env.AGENT_BROWSER_SOCKET_DIR,
										),
										namespace: inputArgs.includes("--namespace")
											? readString(inputArgs[inputArgs.indexOf("--namespace") + 1])
											: "",
									};
									nativeSessions.set(JSON.stringify(identity), identity);
								}
								await beforeResult?.();
								// Real native entries from real tool results, without a model/provider call.
								readDefined(sm).appendMessage({
									role: "toolResult",
									toolCallId: id,
									toolName,
									content: result.content,
									details: readToolArguments(JSON.parse(JSON.stringify(result.details))),
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
			readDefined(sm).appendMessage({
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
		/** @param {NativeInput} params */
		const call = async (params) => {
			await readDefined(session).prompt(`/lifecycle-browser-test ${JSON.stringify(params)}`);
			return readDefined(result);
		};
		/** @param {NativeInput} params */
		const ok = async (params) => {
			const value = await call(params);
			assert.notEqual(value.isError, true, JSON.stringify(value));
			// Native close can acknowledge before its daemon finishes exiting (macOS).
			// Observe that exit independently before reusing or deleting its socket root.
			if (!("args" in params) || params.args.at(-1) !== "close") {
				return value;
			}
			const name = readString(value.details.sessionName);
			assert.ok(name !== "");
			let status;
			for (let i = 0; i < 100; i++) {
				status = readNativeSessionInfo(
					readRecord(
						JSON.parse(
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
						),
					).data,
				);
				if (!status.active) {
					break;
				}
				await delay(50);
			}
			assert.equal(readDefined(status).active, false, JSON.stringify(status));
			return value;
		};
		/** @param {() => boolean} predicate */
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
			await readDefined(session).reload();
			const reloaded = await ok({ args: ["--version"] });
			assert.deepEqual(reloaded.content, version.content);
		});
		await t.test(
			"root browser survives branch navigation and reload with routes and traces",
			async () => {
				const beforeBrowser = readString(readDefined(sm).getLeafId());
				const opened = await ok({ args: ["open", url] });
				rootName = readString(opened.details.sessionName);
				assert.match(rootName, /^pi-root-/);
				const live = await ok({ args: ["--session", rootName, "session", "info"] });
				assert.equal(readRecord(live.details.data).active, true);
				await readDefined(session).navigateTree(beforeBrowser, { summarize: false });
				await readDefined(session).reload();
				const reloaded = await ok({ args: ["--session", rootName, "session", "info"] });
				assert.equal(readRecord(reloaded.details.data).pid, readRecord(live.details.data).pid);
				assert.equal(
					readRecord((await ok({ args: ["--session", rootName, "get", "url"] })).details.data).url,
					url,
				);
				await ok({ args: ["network", "route", "**/unused-fixture", "--abort"] });
				await readDefined(session).reload();
				const blocked = await ok({
					args: ["eval", "--stdin"],
					stdin:
						'(async () => { try { await fetch("/unused-fixture"); return false; } catch { return true; } })()',
				});
				assert.equal(
					readRecord(blocked.details.data).result,
					true,
					"native route must survive reload",
				);
				await ok({ args: ["network", "unroute", "**/unused-fixture"] });
				const unblocked = await ok({
					args: ["eval", "--stdin"],
					stdin: 'fetch("/unused-fixture").then(response => response.ok)',
				});
				assert.equal(
					readRecord(unblocked.details.data).result,
					true,
					"explicit unroute must release the request",
				);
				await ok({ args: ["trace", "start"] });
				await readDefined(session).reload();
				await ok({ args: ["trace", "stop", join(root, "trace.zip")] });
				assert.ok((await stat(join(root, "trace.zip"))).size > 0);
				await ok({ args: ["close"] });
			},
		);
		await t.test("caller-owned attachment survives reload until explicit close", async () => {
			await ok({ args: ["open", url] });
			const endpoint = await ok({ args: ["get", "cdp-url"] });
			const attached = `lifecycle-attached-${readDefined(sm).getSessionId()}`;
			try {
				await ok({
					args: [
						"--session",
						attached,
						"connect",
						readString(readRecord(endpoint.details.data).cdpUrl),
					],
				});
				await readDefined(session).reload();
				assert.equal(
					readRecord((await ok({ args: ["--session", attached, "get", "url"] })).details.data).url,
					url,
				);
			} finally {
				await ok({ args: ["--session", attached, "close"] });
			}
			await ok({ args: ["--session", readString(rootName), "close"] });
		});
		await t.test("explicit URL read leaves native unnamed launch caller-owned", async () => {
			const profile = join(root, "empty-profile");
			await mkdir(profile);
			try {
				const read = await ok({ args: ["--profile", profile, "read", url] });
				assert.equal(read.details.sessionName, undefined);
				const status = readNativeSessionInfo(
					readRecord(
						JSON.parse(
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
						),
					).data,
				);
				assert.equal(readDefined(status).active, true);
				assert.ok(status.runtime);
				// Official 0.43+ launches a browser only for a command that needs one, so this read
				// leaves the unnamed daemon browserless.
				const browserLaunched = false;
				assert.equal(status.runtime.browserLaunched, browserLaunched);
				assert.deepEqual(readRecord(read.details.lifecycle).effectiveLaunch, { browserLaunched });
				receipts.push({
					label: "unnamed native browser observation",
					daemonActive: true,
					browserLaunched,
				});
				await readDefined(session).reload();
				const reloaded = await ok({ args: ["--session", "default", "session", "info"] });
				assert.equal(readRecord(reloaded.details.data).active, true);
				assert.equal(readRecord(reloaded.details.data).pid, status.pid);
			} finally {
				await ok({ args: ["--session", "default", "close"] });
			}
		});
		await t.test("cold explicit-session auth login keeps launch flags after reload", async () => {
			const certDir = join(root, "https-fixture");
			await mkdir(certDir);
			const keyPath = join(certDir, "key.pem");
			const certPath = join(certDir, "cert.pem");
			const subject = ["-subj", "/CN=lifecycle-fixture"];
			const san = ["-addext", "subjectAltName=IP:127.0.0.1"];
			execFileSync("openssl", [
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"1",
				"-keyout",
				keyPath,
				"-out",
				certPath,
				...subject,
				...san,
			]);
			const https = createHttpsServer(
				{
					key: await readFile(keyPath),
					cert: await readFile(certPath),
				},
				(_req, res) => {
					res.setHeader("content-type", "text/html");
					res.end(
						"<!doctype html><title>Login fixture</title><form onsubmit=\"event.preventDefault();document.body.dataset.login=document.querySelector('#user').value+':'+document.querySelector('#pass').value\"><input id=user><input id=pass type=password><button id=go>Sign in</button></form>",
					);
				},
			);
			const httpsListening = once(https, "listening");
			https.listen(0, "127.0.0.1");
			await httpsListening;
			const httpsAddress = https.address();
			assert.ok(httpsAddress !== null && typeof httpsAddress === "object");
			const sessionName = `lifecycle-https-${readDefined(sm).getSessionId()}`;
			try {
				await ok({
					args: [
						"auth",
						"save",
						"fixture",
						"--url",
						`https://127.0.0.1:${httpsAddress.port}/`,
						"--username",
						"fixture-user",
						"--username-selector",
						"#user",
						"--password-selector",
						"#pass",
						"--submit-selector",
						"#go",
						"--password-stdin",
					],
					stdin: "fixture-only\n",
				});
				const loginArgs = [
					"--session",
					sessionName,
					"--ignore-https-errors",
					"--args",
					"--disable-gpu",
					"auth",
					"login",
					"fixture",
				];
				// Reporter shape: the login is the first call, so it must start the browser itself.
				const firstLogin = await ok({ args: loginArgs });
				const login = await ok({
					args: ["--session", sessionName, "eval", "--stdin"],
					stdin: "document.body.dataset.login",
				});
				assert.equal(readRecord(login.details.data).result, "fixture-user:fixture-only");
				await ok({ args: ["--session", sessionName, "get", "url"] });
				const nativeArgs = ["--json", "--namespace", "", "--session", sessionName];
				const nativeEnv = {
					...process.env,
					AGENT_BROWSER_SOCKET_DIR: process.env.PI_AGENT_BROWSER_SOCKET_DIR,
				};
				/** @param {readonly string[]} args */
				const readNative = (args) =>
					readRecord(
						readRecord(
							JSON.parse(
								execFileSync("agent-browser", args, {
									env: nativeEnv,
									encoding: "utf8",
									timeout: 15_000,
								}),
							),
						).data,
					);
				// Stop only this fixture's browser without clearing the extension's remembered target.
				readNative([...nativeArgs, "close"]);
				await waitFor(() => readNative([...nativeArgs, "session", "info"]).active === false);
				await readDefined(session).reload();
				await ok({ args: loginArgs });
				const resumedLogin = await ok({
					args: ["--session", sessionName, "eval", "--stdin"],
					stdin: "document.body.dataset.login",
				});
				assert.equal(readRecord(resumedLogin.details.data).result, "fixture-user:fixture-only");
				const previousTarget = readRecord(resumedLogin.details.sessionTabTarget);
				assert.equal(typeof previousTarget.targetId, "string");
				readNative([...nativeArgs, "close"]);
				await waitFor(() => readNative([...nativeArgs, "session", "info"]).active === false);
				const nativeReadArgs = [
					...readArray(firstLogin.details.effectiveArgs).map(readString).slice(0, -3),
					"get",
					"title",
				];
				const nativeControl = {
					title: readNative(nativeReadArgs).title,
					url: readNative([...nativeArgs, "get", "url"]).url,
					pid: readNative([...nativeArgs, "session", "info"]).pid,
				};
				assert.equal(typeof nativeControl.title, "string");
				assert.equal(typeof nativeControl.url, "string");
				readNative([...nativeArgs, "close"]);
				await waitFor(() => readNative([...nativeArgs, "session", "info"]).active === false);
				await readDefined(session).reload();
				const coldRead = await ok({ args: [...loginArgs.slice(0, -3), "get", "title"] });
				assert.equal(readRecord(coldRead.details.data).title, nativeControl.title);
				assert.equal(readRecord(coldRead.details.sessionTabTarget).url, nativeControl.url);
				assert.equal(typeof readRecord(coldRead.details.sessionTabTarget).targetId, "string");
				assert.notEqual(
					readRecord(coldRead.details.sessionTabTarget).targetId,
					previousTarget.targetId,
				);
				assert.equal(readRecord(coldRead.details.data).navigationSummary, undefined);
				assert.equal(coldRead.details.pageChangeSummary, undefined);
				assert.doesNotMatch(
					getMessageText(coldRead.content),
					/Action dispatched; application change unverified/,
				);
				const followed = await ok({ args: ["--session", sessionName, "get", "title"] });
				assert.equal(readRecord(followed.details.data).title, nativeControl.title);
				assert.equal(
					readRecord(followed.details.sessionTabTarget).targetId,
					readRecord(coldRead.details.sessionTabTarget).targetId,
				);
				receipts.push({
					label: "native cold non-navigation read comparison",
					nativeReadArgs,
					nativeControl,
					previousTarget,
					replacementTarget: coldRead.details.sessionTabTarget,
					nativeTitle: readRecord(coldRead.details.data).title,
				});
			} finally {
				try {
					try {
						await ok({ args: ["--session", sessionName, "close"] });
					} finally {
						await ok({ args: ["auth", "remove", "fixture"] });
					}
				} finally {
					await new Promise((done) => {
						https.close(done);
					});
				}
			}
		});
		await t.test("managed fresh browser keeps ordinary ownership and cleanup", async () => {
			const opened = await ok({ args: ["open", url], sessionMode: "fresh" });
			const managedName = readString(opened.details.sessionName);
			assert.match(managedName, /^piab-/);
			const live = await ok({
				args: ["--session", managedName, "session", "info"],
			});
			await readDefined(session).reload();
			const reloaded = await ok({
				args: ["--session", managedName, "session", "info"],
			});
			assert.equal(readRecord(reloaded.details.data).pid, readRecord(live.details.data).pid);
			assert.equal(readRecord((await ok({ args: ["get", "url"] })).details.data).url, url);
			await ok({ args: ["close"] });
		});
		await t.test("failed journal begin prevents stopping a live native recording", async () => {
			// A failed native append can remain memory-only; isolate this fault rather than
			// claiming that the public SDK repairs unpublished journal ancestry.
			const previous = { session: readDefined(session), sm: readDefined(sm), loader };
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
				recordingSession = readString(opened.details.sessionName);
				await ok({ args: ["record", "start", join(root, "record.webm")] });
				await delay(12_000);
				await chmod(readString(sm.getSessionFile()), 0o400);
				beforeResult = () => chmod(readString(readDefined(sm).getSessionFile()), 0o600);
				const stopped = await call({ args: ["record", "stop"] });
				beforeResult = undefined;
				assert.equal(stopped.isError, true);
				assert.equal(
					stopped.details.browserStatePersistence,
					"begin-unconfirmed",
					"an unwritable begin must prevent native record stop",
				);
				const recorded = await ok({
					args: ["--session", recordingSession, "record", "stop"],
				});
				assert.ok(
					readNumber(readRecord(recorded.details.data).frames) > 0,
					"the failed begin cannot have stopped native recording",
				);
				await ok({ args: ["close"] });
			} finally {
				try {
					await chmod(readString(readDefined(sm).getSessionFile()), 0o600);
					beforeResult = undefined;
					if (recordingSession !== undefined && recordingSession !== "") {
						await ok({ args: ["--session", recordingSession, "close"] });
					}
				} finally {
					readDefined(session).dispose();
					({ session, sm, loader } = previous);
				}
			}
		});
		await t.test(
			"native root restore survives fresh checkout and state-directory inodes",
			async () => {
				// Independently qualify root save/reopen with a fresh native session.
				readDefined(session).dispose();
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
				rootName = readString(opened.details.sessionName);
				assert.match(rootName, /^pi-root-/);
				const nativeStatus = await ok({ args: ["--session", rootName, "session", "info"] });
				assert.equal(
					readRecord(readRecord(nativeStatus.details.data).runtime).restoreKey,
					rootName,
				);
				await ok({
					args: ["eval", "--stdin"],
					stdin:
						'document.cookie="lifecycle_fixture=synthetic;path=/;max-age=3600"; localStorage.setItem("fixture","local"); sessionStorage.setItem("fixture","session"); true',
				});
				await ok({ args: ["close"] });
				const saved = {
					journal: sm.getSessionFile(),
					sessionId: readDefined(sm).getSessionId(),
					leaf: sm.getLeafId(),
					entries: sm.getEntries(),
					activeTools: session.getActiveToolNames(),
				};
				const stateDir = join(home, ".agent-browser", "sessions");
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
				readDefined(session).dispose();
				loader = createLoader();
				await loader.reload();
				({ session } = await sdk.createAgentSession({
					sessionManager: sdk.SessionManager.open(readString(saved.journal)),
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
				assert.equal(readDefined(sm).getSessionId(), saved.sessionId);
				assert.equal(sm.getLeafId(), saved.leaf);
				assert.equal(JSON.stringify(sm.getEntries()), JSON.stringify(saved.entries));
				assert.deepEqual(session.getActiveToolNames(), saved.activeTools);
				const reopened = await ok({ args: ["open", url] });
				assert.equal(reopened.details.sessionName, rootName);
				const restoredStatus = await ok({ args: ["--session", rootName, "session", "info"] });
				assert.equal(
					readRecord(readRecord(restoredStatus.details.data).runtime).restoreKey,
					rootName,
				);
				const observed = await ok({
					args: ["eval", "--stdin"],
					stdin:
						'({checks:[document.cookie === "lifecycle_fixture=synthetic", localStorage.getItem("fixture") === "local", sessionStorage.getItem("fixture") === "session"]})',
				});
				assert.deepEqual(readRecord(observed.details.data).result, { checks: [true, true, true] });
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
			const piSockets = readString(process.env.PI_AGENT_BROWSER_SOCKET_DIR);
			const restoredRoot = readString(rootName);
			const ambient = join(root, "ambient");
			const uid = readDefined(process.getuid?.());
			const ownedSockets = `${process.platform === "darwin" ? "/private/tmp" : "/tmp"}/piab-${uid}`;
			await mkdir(ambient, { mode: 0o700 });
			delete process.env.PI_AGENT_BROWSER_SOCKET_DIR;
			process.env.AGENT_BROWSER_SOCKET_DIR = ambient;
			/** @param {string} name @param {string} socketDir @param {string} [namespace] */
			const status = (name, socketDir, namespace = "") =>
				readNativeSessionInfo(
					readRecord(
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
						),
					).data,
				);
			/** @param {string} name @param {string} socketDir @param {string} [namespace] */
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
				const rootStatus = status(restoredRoot, ambient);
				assert.equal(rootStatus.active, true);
				assert.equal(status(restoredRoot, ownedSockets).active, false);
				await readDefined(session).reload();
				assert.equal(status(restoredRoot, ambient).pid, rootStatus.pid);
				await close(restoredRoot, ambient);

				const opened = await ok({ args: ["open", url], sessionMode: "fresh" });
				fresh = readString(opened.details.sessionName);
				assert.match(fresh, /^piab-/);
				const live = status(fresh, ownedSockets);
				assert.equal(live.active, true);
				assert.ok(live.runtime);
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
				await readDefined(session).reload();
				assert.equal(status(fresh, ownedSockets).pid, live.pid);
				await close(fresh, ownedSockets);
				fresh = undefined;

				await ok({ args: ["--namespace", "caller", "--session", caller, "open", url] });
				const callerStatus = status(caller, ambient, "caller");
				assert.equal(callerStatus.active, true);
				assert.equal(status(caller, ownedSockets, "caller").active, false);
				await readDefined(session).reload();
				assert.equal(status(caller, ambient, "caller").pid, callerStatus.pid);
				await close(caller, ambient, "caller");
				assert.equal(process.env.PI_AGENT_BROWSER_SOCKET_DIR, undefined);
				assert.equal(process.env.AGENT_BROWSER_SOCKET_DIR, ambient);
			} finally {
				if (fresh !== undefined && fresh !== "") {
					await close(fresh, ownedSockets);
				}
				await close(caller, ambient, "caller");
				await close(restoredRoot, ambient);
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
