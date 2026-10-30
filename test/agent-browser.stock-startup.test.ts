import { readArray, readRecord, readString } from "./helpers/assertions.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { withNativeSessionDefaults } from "../extensions/agent-browser/lib/orchestration/native-session-defaults.js";
import { resolveAgentBrowserInput } from "../extensions/agent-browser/lib/orchestration/input-plan.js";
import { getUpstreamEffectiveBatchSteps } from "../extensions/agent-browser/lib/orchestration/batch-stdin.js";
import { parseArgvDescriptor } from "../extensions/agent-browser/lib/argv-descriptor.js";
import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	startAgentBrowserContractFixtureServer,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

async function cdp(url: string, method: string): Promise<Record<string, unknown>> {
	const socket = new WebSocket(url);
	try {
		return await new Promise<Record<string, unknown>>((resolve, reject) => {
			socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method })));
			socket.addEventListener("error", reject);
			socket.addEventListener("message", (event) => {
				const response = readRecord(JSON.parse(readString(event.data)));
				if (response.id === 1) {
					if (response.error !== undefined) {
						reject(new Error(JSON.stringify(response.error)));
						return;
					}
					resolve(readRecord(response.result));
				}
			});
		});
	} finally {
		socket.close();
	}
}

function stockLaunch(mode: string, profile: string, headed: boolean): string[] {
	if (mode === "config" || mode === "env") {
		return [];
	}
	return [
		"--profile",
		profile,
		...(headed
			? [...(mode === "initial" ? [] : ["--args", "--disable-gpu,--enable-automation"]), "--headed"]
			: []),
	];
}

const stockVersion =
	process.env.PI_AGENT_BROWSER_REAL_UPSTREAM === "1"
		? execFileSync("agent-browser", ["--version"], { encoding: "utf8" }).trim()
		: undefined;

const resolve = (args: readonly string[], stdin?: string) =>
	resolveAgentBrowserInput({
		params: { args: [...args], stdin },
		getBatchPreflightValidationError: () => {
			/* Valid fixture input needs no preflight rejection. */
		},
	});

test("URL-less open uses native lazy launch without inventing navigation or hiding effective commands", () => {
	const requested = ["--session", "existing", "open", "--headed", "false"];
	const result = resolve(requested);
	assert.deepEqual(result.redactedArgs, requested);
	assert.deepEqual(result.toolArgs, ["--session", "existing", "get", "url", "--headed", "false"]);
	assert.deepEqual(resolve(["open", "about:blank"]).toolArgs, ["open", "about:blank"]);
	assert.deepEqual(resolve(["goto"]).toolArgs, ["goto"]);
	assert.deepEqual(resolve(["open", "--help"]).toolArgs, ["open", "--help"]);
	const ignored = JSON.stringify([["open"]]);
	assert.equal(
		resolve(["batch", ""], ignored).toolStdin,
		ignored,
		"even an empty raw command displaces stdin",
	);
});

test("startup adaptation preserves native argument sources and excludes external engines and attachments", async (t) => {
	const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "psa-"));
	await writeFakeAgentBrowserBinary(
		root,
		`console.log(JSON.stringify({success:true,data:{session:'default'}}));`,
	);
	try {
		await writeFile(
			join(root, "agent-browser.json"),
			JSON.stringify({ args: "--config-argument" }),
		);
		const cleared = Object.fromEntries(
			Object.keys(process.env)
				.filter((name) => name.startsWith("AGENT_BROWSER_"))
				.map((name) => [name, undefined]),
		);
		await withPatchedEnv(
			{
				...cleared,
				HOME: root,
				USERPROFILE: root,
				PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
			},
			async () => {
				const check = async (
					args: readonly string[],
					expected: string | undefined,
					stdin?: string,
					expectedRoot?: boolean,
				) => {
					const input = resolve(args, stdin);
					assert.equal(input.status, "valid");
					const callerArgs = [...input.toolArgs];
					await withNativeSessionDefaults(
						input,
						{
							cwd: root,
							root: expectedRoot === undefined ? undefined : { sessionId: "startup-precedence" },
						},
						async (planned, withLaunchDefaults) => {
							assert.equal(planned.chromeStartupArgs, expected, args.join(" "));
							assert.deepEqual(
								planned.toolArgs.slice(-callerArgs.length),
								callerArgs,
								"native argv precedence stays caller-owned",
							);
							if (expectedRoot !== undefined) {
								// Exhaustive fixture variant (expectedRoot !== undefined): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(
									planned.toolArgs[0] === "--session",
									expectedRoot,
									"automatic root identity follows native attachment selection",
								);
								// Exhaustive fixture variant (expectedRoot !== undefined): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(typeof withLaunchDefaults === "function", expectedRoot);
								if (expectedRoot) {
									// Exhaustive fixture variant (expectedRoot): this selected path must satisfy its own contract.
									// oxlint-disable-next-line node-test/no-conditional-assertion
									assert.match(readString(planned.toolArgs[1]), /^pi-root-[a-f0-9]{24}$/);
								}
							}
							return { content: [], details: {} };
						},
					);
				};
				await check(["open"], undefined);
				await withPatchedEnv({ AGENT_BROWSER_ARGS: "--env-argument" }, async () => {
					await check(["open"], undefined);
					await check(["--args", "--argv-argument", "open"], undefined);
				});

				await withPatchedEnv({ AGENT_BROWSER_AUTO_CONNECT: "true" }, async () => {
					await check(["open"], undefined);
					await check(["--auto-connect", "false", "open"], undefined);
				});
				await check(["batch", "batch open"], undefined);
				await check(["batch"], undefined, JSON.stringify([["connect", "9222"]]));
				await writeFile(
					join(root, "agent-browser.json"),
					JSON.stringify({ args: "--config-argument", autoConnect: true }),
				);
				await t.test(
					"CLI false overrides configured and environment auto-connect and keeps the local root",
					async () => {
						await withPatchedEnv({ AGENT_BROWSER_AUTO_CONNECT: "true" }, () =>
							check(["--auto-connect", "false", "open"], undefined, undefined, true),
						);
					},
				);
				await t.test(
					"environment false does not disable native configured auto-connect",
					async () => {
						await withPatchedEnv({ AGENT_BROWSER_AUTO_CONNECT: "false" }, () =>
							check(["open"], undefined, undefined, false),
						);
					},
				);
				await writeFile(join(root, "agent-browser.json"), "{}");
				await check(["open"], "--no-startup-window");
				await check(["--args", "--argv-argument", "open"], "--no-startup-window,--argv-argument");
				await check(["batch", "batch open"], "--no-startup-window");
				await Promise.all(
					[
						["connect", "9222"],
						["--cdp", "9222", "open"],
						["--auto-connect", "open"],
						["--provider", "kernel", "open"],
						["--engine", "lightpanda", "open"],
						["batch", "batch 'connect 9222'"],
					].map((args) => check(args, undefined)),
				);
			},
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

for (const mode of ["stdin", "raw"] as const) {
	test(`URL-less batch opens preserve ${mode} precedence and literal/nested commands`, () => {
		const rows = [
			["open"],
			["fill", "#field", "open"],
			["batch", "open"],
			["open", "https://example.com"],
		];
		const stdin = JSON.stringify(mode === "stdin" ? rows : [["open", "ignored"]]);
		const args =
			mode === "stdin"
				? ["batch", "--bail"]
				: [
						"batch",
						"--bail",
						"open",
						"fill '#field' open",
						"batch open",
						"open https://example.com",
					];
		const result = resolve(args, stdin);
		assert.equal(result.status, "valid");
		assert.deepEqual(
			getUpstreamEffectiveBatchSteps(
				parseArgvDescriptor(result.toolArgs).upstreamCommandTokens,
				result.toolStdin,
			),
			[["get", "url"], rows[1], ["batch", "'get' 'url'"], rows[3]],
		);
		if (mode === "raw") {
			// Exhaustive fixture variant (mode === "raw"): this selected path must satisfy its own contract.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(result.toolStdin, stdin, "ignored stdin is unchanged");
		}
	});
}

for (const mode of ["root", "explicit", "fresh"] as const) {
	test(`native configured Chrome arguments stay caller-owned for ${mode} across initial and active calls`, async () => {
		const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "pss-"));
		const log = join(root, "calls.jsonl");
		await writeFakeAgentBrowserBinary(
			root,
			`
const fs = require('node:fs');
const args = process.argv.slice(2);
const active = ${JSON.stringify(join(root, "active"))};
if (args.at(-1) === 'session') { console.log(JSON.stringify({success:true,data:{session:'default'}})); process.exit(0); }
if (args.includes('info')) { console.log(JSON.stringify({success:true,data:{active:fs.existsSync(active),runtime:{restoreKey:null}}})); process.exit(0); }
const configArgs = JSON.parse(fs.readFileSync(require('node:path').join(process.cwd(), 'agent-browser.json'), 'utf8')).args;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, configArgs, environmentArgs: process.env.AGENT_BROWSER_ARGS ?? null, launchArgs: args.includes('--args') ? args[args.lastIndexOf('--args') + 1] : null}) + '\\n');
fs.writeFileSync(active, '1');
console.log(JSON.stringify({success:true,data:{url:'https://fixture.test/', title:'Fixture'}}));
`,
		);
		try {
			const cleared = Object.fromEntries(
				Object.keys(process.env)
					.filter(
						(name) => name.startsWith("AGENT_BROWSER_") || name.startsWith("PI_AGENT_BROWSER_"),
					)
					.map((name) => [name, undefined]),
			);
			await writeFile(join(root, "agent-browser.json"), JSON.stringify({ args: "--disable-gpu" }));
			await withPatchedEnv(
				{
					...cleared,
					HOME: root,
					USERPROFILE: root,
					PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
					PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"),
					PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
					PI_AGENT_BROWSER_TEST_PRESERVE_INTERNAL_LAUNCH_FLAGS: "1",
					PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0",
					PI_SUBAGENT_CHILD: undefined,
					PI_SUBAGENT_ROOT_SESSION_ID: undefined,
				},
				async () => {
					const harness = createExtensionHarness({ cwd: root });
					const prefix = mode === "explicit" ? ["--session", "local"] : [];
					const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: [...prefix, "open"],
						...(mode === "fresh" ? { sessionMode: "fresh" as const } : {}),
					});
					const openedDetails = readRecord(opened.details);
					assert.equal(opened.isError, false, opened.content[0].text);
					assert.ok(
						readArray(openedDetails.effectiveArgs)
							.map((value) => readString(value))
							.includes("url"),
					);
					const first = readRecord(
						(await readInvocationLog(log)).find((call) =>
							readArray(call.args).map(readString).includes("url"),
						),
					);
					assert.equal(first.launchArgs, null, "native config args are not rewritten into argv");
					assert.equal(first.configArgs, "--disable-gpu");
					assert.equal(first.environmentArgs, null);
					const followup = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: [...prefix, "open"],
					});
					assert.equal(followup.isError, false, followup.content[0].text);
					const calls = readArray(
						(await readInvocationLog(log)).filter((call) =>
							readArray(call.args).map(readString).includes("url"),
						),
					).map((value) => readRecord(value));
					assert.equal(calls.length, 2, "both initial and active URL-less calls reached upstream");
					assert.ok(
						calls.every(
							(call) =>
								call.launchArgs === null &&
								call.configArgs === "--disable-gpu" &&
								call.environmentArgs === null,
						),
						"native configured arguments remain unchanged across initial and active calls",
					);
				},
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

for (const mode of ["root", "explicit", "fresh", "config", "env", "initial", "headless"] as const) {
	test(
		`stock Chrome ${mode}: one page, stable browser/profile and URL-less opens`,
		{ skip: process.env.PI_AGENT_BROWSER_REAL_UPSTREAM !== "1", timeout: 120_000 },
		async () => {
			const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "psr-"));
			const fixture = await startAgentBrowserContractFixtureServer();
			const headed = mode !== "headless";
			const profile = join(root, "profile");
			const cleared = Object.fromEntries(
				Object.keys(process.env)
					.filter(
						(name) => name.startsWith("AGENT_BROWSER_") || name.startsWith("PI_AGENT_BROWSER_"),
					)
					.map((name) => [name, undefined]),
			);
			try {
				if (mode === "config") {
					await writeFile(
						join(root, "agent-browser.json"),
						// Native launch defaults own their full args; request the one-page startup explicitly.
						JSON.stringify({
							args: "--no-startup-window,--disable-gpu,--enable-automation",
							profile,
							headed,
						}),
					);
				}
				await withPatchedEnv(
					{
						...cleared,
						HOME: root,
						USERPROFILE: root,
						PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"),
						...(mode === "env"
							? {
									AGENT_BROWSER_ARGS: "--no-startup-window,--disable-gpu,--enable-automation",
									AGENT_BROWSER_PROFILE: profile,
									AGENT_BROWSER_HEADED: "true",
								}
							: {}),
						PI_SUBAGENT_CHILD: undefined,
						PI_SUBAGENT_ROOT_SESSION_ID: undefined,
					},
					async () => {
						const harness = createExtensionHarness({
							cwd: root,
							sessionId: "stock-startup-parent",
							sessionFile: join(root, "fixture-session.jsonl"),
						});
						const prefix =
							mode === "explicit" || mode === "config" ? ["--session", "stock-local"] : [];
						const call = async (args: readonly string[], extra = {}) => {
							const result = await executeRegisteredTool(harness.tool, harness.ctx, {
								args: [...prefix, ...args],
								...extra,
							});
							assert.equal(result.isError, false, result.content[0].text);
							return result;
						};
						try {
							const launch = stockLaunch(mode, profile, headed);
							const opened = await call(
								[...launch, "open", ...(mode === "initial" ? [fixture.baseUrl] : [])],
								mode === "fresh" ? { sessionMode: "fresh" } : {},
							);
							const openedDetails = readRecord(opened.details);
							const openedArgs = readArray(openedDetails.effectiveArgs).map(readString);
							assert.ok(openedArgs.includes(mode === "initial" ? "open" : "url"));
							assert.equal(
								readRecord(openedDetails.data).url,
								mode === "initial" ? `${fixture.baseUrl}/` : "about:blank",
							);
							const endpoint = readRecord((await call(["get", "cdp-url"])).details?.data).cdpUrl;
							const browserPid = async () => {
								const processes = await cdp(readString(endpoint), "SystemInfo.getProcessInfo");
								return readRecord(
									readArray(processes.processInfo)
										.map(readRecord)
										.find((entry) => entry.type === "browser"),
								).id;
							};
							const pid = await browserPid();
							if (headed && mode !== "initial") {
								const argv = readArray(
									(await cdp(readString(endpoint), "Browser.getBrowserCommandLine")).arguments,
								).map((value) => readString(value));
								// Exhaustive fixture variant (headed && mode !== "initial"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.ok(argv.includes("--no-startup-window"));
								// Exhaustive fixture variant (headed && mode !== "initial"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.ok(
									["--disable-gpu", `--user-data-dir=${profile}`].every((value) =>
										argv.includes(value),
									),
								);
								// Exhaustive fixture variant (headed && mode !== "initial"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.ok(!argv.some((value) => value.startsWith("--headless")));
							} else {
								// Exhaustive fixture variant (headed && mode !== "initial"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(
									readString(
										(await cdp(readString(endpoint), "Browser.getVersion")).userAgent,
									).includes("HeadlessChrome"),
									!headed,
								);
							}
							const pages = async () =>
								readArray((await cdp(readString(endpoint), "Target.getTargets")).targetInfos)
									.map(readRecord)
									.filter((entry) => entry.type === "page");
							assert.equal((await pages()).length, 1);
							await call(["open", fixture.baseUrl]);
							await call(["eval", "--stdin"], {
								stdin: "localStorage.setItem('startup-marker','retained'); 'marked'",
							});
							await call(["open"]);
							await call(["batch", "--bail"], {
								stdin: JSON.stringify([["open"], ["get", "url"]]),
							});
							await call(["batch", "--bail", "open", "get url"], {
								stdin: JSON.stringify([["open", "about:blank"]]),
							});
							assert.equal(
								readRecord((await call(["get", "url"])).details?.data).url,
								`${fixture.baseUrl}/`,
							);
							if (mode === "root") {
								await withPatchedEnv(
									{ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_ROOT_SESSION_ID: "stock-startup-parent" },
									async () => {
										const child = createExtensionHarness({
											cwd: root,
											sessionId: "stock-startup-child",
										});
										const result = await executeRegisteredTool(child.tool, child.ctx, {
											args: ["open"],
										});
										const resultDetails = readRecord(result.details);
										// Exhaustive fixture variant (mode === "root"): this selected path must satisfy its own contract.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(result.isError, false, result.content[0].text);
										// Exhaustive fixture variant (mode === "root"): this selected path must satisfy its own contract.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(resultDetails.sessionName, openedDetails.sessionName);
									},
								);
							}
							assert.equal(
								readRecord(
									(
										await call(["eval", "--stdin"], {
											stdin: "localStorage.getItem('startup-marker')",
										})
									).details?.data,
								).result,
								"retained",
							);
							assert.equal((await pages()).length, 1);
							assert.equal(await browserPid(), pid);
							if (mode === "headless") {
								const script = await executeRegisteredTool(
									harness.getTool("agent_browser_code") ??
										// Exhaustive fixture variant (mode === "headless"): this selected path must satisfy its own contract.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.fail("code tool must be registered"),
									harness.ctx,
									{
										code: `await browser({args:["open"]}); await browser({args:["open",${JSON.stringify(fixture.baseUrl)}]}); emit((await browser({args:["open"]})).data.url);`,
									},
								);
								const scriptDetails = readRecord(script.details);
								// Exhaustive fixture variant (mode === "headless"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(script.isError, false, script.content[0].text);
								// Exhaustive fixture variant (mode === "headless"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(scriptDetails.data, `${fixture.baseUrl}/`);
								// Exhaustive fixture variant (mode === "headless"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(scriptDetails.sessionName, openedDetails.sessionName);
								// Exhaustive fixture variant (mode === "headless"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(await browserPid(), pid);
							}
							console.log(
								JSON.stringify({
									mode,
									stockVersion,
									browserPid: pid,
									pageCount: 1,
									headed,
									customArgsRetained: !["initial", "headless"].includes(mode),
									storageRetained: true,
									url: `${fixture.baseUrl}/`,
								}),
							);
						} finally {
							await call(["close"]);
						}
					},
				);
			} finally {
				await fixture.close();
				await rm(root, { recursive: true, force: true });
			}
		},
	);
}
