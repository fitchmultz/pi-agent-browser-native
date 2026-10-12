/**
 * Purpose: Verify experimental sourceLookup and networkSourceLookup compilation and analysis contracts.
 * Responsibilities: Assert lookup compilation, workspace candidates, redaction, and Electron context.
 * Scope: Integration-style Node test-runner coverage around the extension harness before result presentation and tab lifecycle suites.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-source-lookup.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";
import { writeFakeLaunchableElectronApp } from "./helpers/extension-validation-fixtures.js";
import { readRecord, readArray, readString } from "./helpers/assertions.js";
import {
	analyzeNetworkSourceLookupResults,
	compileAgentBrowserNetworkSourceLookup,
} from "../extensions/agent-browser/lib/input-modes/lookups.js";

test("network source lookup counts request identities once and correlates only matching failures", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-network-evidence-"));
	try {
		const compiled = compileAgentBrowserNetworkSourceLookup({
			filter: "/api/fail",
			url: "/ignored",
		}).compiled;
		assert.ok(compiled);
		const matching = {
			id: "req-1",
			status: 500,
			url: "https://app.test/api/fail",
			initiator: "src/api.ts:1:2",
		};
		const unrelated = {
			id: "req-other",
			status: 500,
			url: "https://app.test/other",
			initiator: "src/other.ts:1:2",
		};
		const lookup = await analyzeNetworkSourceLookupResults(
			[
				{ success: true, result: matching },
				{ success: true, result: { requests: [matching, unrelated] } },
			],
			compiled,
			tempDir,
		);
		assert.deepEqual(
			lookup.candidates.map((candidate) => candidate.file),
			["src/api.ts"],
		);
		assert.equal(lookup.failedRequests.length, 1);
		assert.match(lookup.summary, /found 1 failed request\(s\)/);
		const separate = await analyzeNetworkSourceLookupResults(
			[
				{
					success: true,
					result: {
						requests: [
							matching,
							{ requestId: "req-2", status: 500, url: matching.url },
							{ status: 500, url: matching.url },
							{ status: 500, url: matching.url },
						],
					},
				},
			],
			compiled,
			tempDir,
		);
		assert.equal(
			separate.failedRequests.length,
			4,
			"same URL is not a request identity; anonymous rows stay distinct",
		);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test(
	"agentBrowserExtension compiles experimental source lookups and reports candidate evidence",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-source-lookup-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await mkdir(join(tempDir, "src"), { recursive: true });
		await writeFile(
			join(tempDir, "src", "Panel.tsx"),
			"export function Panel() { return <button>Save</button>; }\n",
		);
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  const steps = JSON.parse(stdin);
  const results = steps.map((command) => {
    if (command[0] === "get" && command[1] === "html") {
      return { command, success: true, result: "<button data-source-file='src/Button.tsx' data-source-line='17' data-source-column='5'>Save</button>" };
    }
    if (command[0] === "react" && command[1] === "inspect") {
      return { command, success: true, result: { name: "Button", source: { fileName: "src/Button.tsx", lineNumber: 17, columnNumber: 5 } } };
    }
    if (command[0] === "react" && command[1] === "tree") {
      return { command, success: true, result: "0 1 App\\n1 2 Panel" };
    }
    return { command, success: true, result: { ok: true } };
  });
  process.stdout.write(JSON.stringify(results));
});`,
		);

		try {
			await withPatchedEnv(
				{ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_PAGE_URL: "https://fixture.test/" },
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						sourceLookup: {
							selector: "#save",
							reactFiberId: "2",
							componentName: "Panel",
						},
					});

					assert.equal(result.isError, false);
					const compiledSourceLookup = readRecord(result.details?.compiledSourceLookup);
					assert.deepEqual(
						readArray(compiledSourceLookup.steps)
							.map(readRecord)
							.map((step) => step.args),
						[
							["is", "visible", "#save"],
							["get", "html", "#save"],
							["react", "inspect", "2"],
							["react", "tree"],
						],
					);

					const sourceLookup = readRecord(result.details?.sourceLookup);
					assert.equal(sourceLookup.status, "candidates-found");
					assert.ok(
						readArray(sourceLookup.candidates)
							.map(readRecord)
							.some(
								(candidate) =>
									candidate.source === "react-inspect" &&
									candidate.file === "src/Button.tsx" &&
									candidate.line === 17 &&
									candidate.confidence === "high",
							),
					);
					assert.ok(
						readArray(sourceLookup.candidates)
							.map(readRecord)
							.some(
								(candidate) =>
									candidate.source === "dom-attribute" &&
									candidate.file === "src/Button.tsx" &&
									candidate.line === 17 &&
									candidate.column === 5,
							),
					);
					assert.ok(
						readArray(sourceLookup.candidates)
							.map(readRecord)
							.some(
								(candidate) =>
									candidate.source === "workspace-search" &&
									candidate.componentName === "Panel" &&
									candidate.file !== undefined &&
									readString(candidate.file).endsWith(join("src", "Panel.tsx")),
							),
					);
					const invocations = await readInvocationLog(logPath);
					assert.deepEqual(invocations[0].args.slice(-1), ["batch"]);
					assert.deepEqual(JSON.parse(invocations[0].stdin ?? "[]"), [
						["is", "visible", "#save"],
						["get", "html", "#save"],
						["react", "inspect", "2"],
						["react", "tree"],
					]);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension explains packaged Electron sourceLookup no-candidate boundaries",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-source-lookup-electron-"));
		const applicationsDir = join(tempDir, "Applications");
		const logPath = join(tempDir, "invocations.log");
		const launchLogPath = join(tempDir, "electron-launch.log");
		const basePath = process.env.PATH ?? "";
		try {
			await mkdir(applicationsDir, { recursive: true });
			const app = await writeFakeLaunchableElectronApp({
				applicationsDir,
				bundleId: "com.example.PackagedElectron",
				launchLogPath,
				name: "Packaged Electron",
			});
			await writeFakeAgentBrowserBinary(
				tempDir,
				`const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
	fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
	const valueFlags = new Set(["--session"]);
	let commandIndex = -1;
	for (let i = 0; i < args.length; i += 1) {
	const token = args[i];
	if (token === "--json") continue;
	if (valueFlags.has(token)) { i += 1; continue; }
	if (token.startsWith("--")) continue;
	commandIndex = i;
	break;
	}
	const command = args[commandIndex];
	const subcommand = args[commandIndex + 1];
	if (command === "connect") {
	process.stdout.write(JSON.stringify({ success: true, data: { connected: true } }));
	return;
	}
	if (command === "get" && subcommand === "url") {
	process.stdout.write(JSON.stringify({ success: true, data: { result: "app://packaged", url: "app://packaged" } }));
	return;
	}
	if (command === "tab" && subcommand === "list") {
	process.stdout.write(JSON.stringify({ success: true, data: { tabs: [{ active: true, title: "Packaged Electron", type: "page", url: "app://packaged" }] } }));
	return;
	}
	if (command === "snapshot") {
	process.stdout.write(JSON.stringify({ success: true, data: { origin: "app://packaged", title: "Packaged Electron", url: "app://packaged", refs: { e1: { role: "button", name: "Save" } }, snapshot: "- button \\"Save\\" [ref=e1]" } }));
	return;
	}
	if (command === "batch") {
	const steps = JSON.parse(stdin || "[]");
	const results = steps.map((step) => ({ command: step, success: true, result: step[0] === "get" && step[1] === "html" ? "<button>Save</button>" : { ok: true } }));
	process.stdout.write(JSON.stringify(results));
	return;
	}
	if (command === "close") {
	process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));
	return;
	}
	process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
});`,
			);

			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const launchResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "launch", appPath: app.appPath, appArgs: app.appArgs },
				});
				assert.equal(launchResult.isError, false);
				const launch = readRecord(readRecord(launchResult.details?.electron).launch);

				try {
					const lookupResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						sourceLookup: { componentName: "MissingPackagedComponent", selector: "#save" },
					});
					assert.equal(lookupResult.isError, false);
					assert.match(
						lookupResult.content[0].text ?? "",
						/Source lookup found no candidate locations/,
					);
					assert.match(lookupResult.content[0].text ?? "", /workspace scan was limited/);
					assert.match(
						lookupResult.content[0].text ?? "",
						/packaged Electron app code may live outside/,
					);
					const sourceLookup = readRecord(lookupResult.details?.sourceLookup);
					assert.equal(sourceLookup.status, "no-candidates");
					assert.equal(sourceLookup.workspaceRoot, tempDir);
					assert.deepEqual(sourceLookup.electronContext, {
						appName: "Packaged Electron",
						appPath: launch.appPath,
						executablePath: launch.executablePath,
						launchId: launch.launchId,
						sessionName: launch.sessionName,
						url: "app://packaged",
					});
					assert.ok(
						readArray(sourceLookup.limitations)
							.map(readString)
							.some((item) => item.includes("captured execution directory")),
					);
					assert.ok(
						readArray(sourceLookup.limitations)
							.map(readString)
							.some((item) => item.includes("app.asar")),
					);
					const nextActions = readArray(lookupResult.details?.nextActions).map(readRecord);
					const actionIds = new Set(nextActions.map((action) => action.id));
					assert.equal(actionIds.has("snapshot-electron-session"), true);
					assert.equal(actionIds.has("probe-electron-launch"), true);
					assert.equal(actionIds.has("list-electron-tabs"), true);
					assert.ok(
						nextActions.some(
							(action) =>
								action.id === "probe-electron-launch" &&
								action.params !== undefined &&
								readRecord(action.params).launchId === launch.launchId,
						),
					);
					assert.ok(
						nextActions.some(
							(action) =>
								action.id === "snapshot-electron-session" &&
								action.params !== undefined &&
								readRecord(action.params).args !== undefined &&
								readArray(readRecord(action.params).args)
									.map(readString)
									.includes(readString(launch.sessionName)),
						),
					);
				} finally {
					const cleanupResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						electron: { action: "cleanup", launchId: launch.launchId },
					});
					assert.equal(cleanupResult.isError, false);
					await assert.rejects(stat(readString(launch.userDataDir)));
				}
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension allows sourceLookup after local-file URL verification",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-source-lookup-file-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		const fileUrl = `file://${join(tempDir, "plain.html")}`;
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
	fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
	const valueFlags = new Set(["--session"]);
	let commandIndex = -1;
	for (let i = 0; i < args.length; i += 1) {
		const token = args[i];
		if (token === "--json") continue;
		if (valueFlags.has(token)) { i += 1; continue; }
		if (token.startsWith("--")) continue;
		commandIndex = i;
		break;
	}
	const command = args[commandIndex];
	if (command === "get" && args[commandIndex + 1] === "url") {
		process.stdout.write(JSON.stringify({ success: true, data: { result: ${JSON.stringify(fileUrl)}, url: ${JSON.stringify(fileUrl)} } }));
		return;
	}
	if (command === "snapshot") {
		process.stdout.write(JSON.stringify({ success: true, data: { origin: ${JSON.stringify(fileUrl)}, title: "Plain file", url: ${JSON.stringify(fileUrl)}, refs: { e1: { role: "button", name: "Save" } }, snapshot: "- button \\"Save\\" [ref=e1]" } }));
		return;
	}
	if (command === "batch") {
		const steps = JSON.parse(stdin || "[]");
		const results = steps.map((step) => ({ command: step, success: true, result: step[0] === "get" && step[1] === "html" ? "<button>Save</button>" : { ok: true } }));
		process.stdout.write(JSON.stringify(results));
		return;
	}
	process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
});`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const urlResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "url"],
					sessionMode: "fresh",
				});
				assert.equal(urlResult.isError, false, JSON.stringify(urlResult));
				assert.equal(readRecord(urlResult.details?.sessionTabTarget).url, fileUrl);

				const lookupResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					sourceLookup: { componentName: "MissingLocalComponent", selector: "#save" },
				});
				assert.equal(lookupResult.isError, false, JSON.stringify(lookupResult));
				assert.equal(
					(await readInvocationLog(logPath)).some((entry) => entry.args.includes("batch")),
					true,
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension compiles experimental network source lookups and reports failed-request candidates",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-network-source-lookup-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await mkdir(join(tempDir, "src"), { recursive: true });
		await writeFile(
			join(tempDir, "src", "api.ts"),
			"export const endpoint = 'https://user:pass@app.test/api/fail?token=secret&ok=1';\n",
		);
		await writeFile(
			join(tempDir, "src", "ok.ts"),
			"export const endpoint = 'https://app.test/api/ok';\n",
		);
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  if (args.includes("get") && args.includes("url")) {
    process.stdout.write(JSON.stringify({ success: true, data: { url: "https://app.test/" } }));
    return;
  }
  const steps = JSON.parse(stdin);
  const results = steps.map((command) => {
    if (command[0] === "network" && command[1] === "request") {
      return { command, success: true, result: { id: "req-1", method: "GET", url: "https://user:pass@app.test/api/fail?token=secret&ok=1", status: 500, initiator: "src/api.ts:1:22" } };
    }
    if (command[0] === "network" && command[1] === "requests") {
      return { command, success: true, result: { requests: [
        { id: "req-1", method: "GET", url: "https://user:pass@app.test/api/fail?token=secret&ok=1", status: 500, initiator: { stack: "at load (src/api.ts:1:22)" } },
        { id: "req-other", method: "GET", url: "https://app.test/other", status: 500, initiator: { stack: "at other (src/other.ts:1:22)" } },
        { id: "req-ok", method: "GET", url: "https://app.test/api/ok", status: 200, initiator: { stack: "at ok (src/ok.ts:1:22)" } }
      ] } };
    }
    return { command, success: true, result: {} };
  });
  process.stdout.write(JSON.stringify(results));
});`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					networkSourceLookup: {
						requestId: "req-1",
						url: "https://user:pass@app.test/api/fail?token=secret&ok=1",
					},
				});

				assert.equal(result.isError, false);
				const compiled = readRecord(result.details?.compiledNetworkSourceLookup);
				assert.deepEqual(readArray(compiled.steps).map(readRecord)[0].args, [
					"network",
					"request",
					"req-1",
				]);
				assert.deepEqual(
					readArray(readArray(compiled.steps).map(readRecord)[1].args).map(readString).slice(0, 3),
					["network", "requests", "--filter"],
				);
				assert.match(
					readString(readArray(readArray(compiled.steps).map(readRecord)[1].args)[3] ?? ""),
					/api\/fail/,
				);
				assert.match(
					readString(readArray(readArray(compiled.steps).map(readRecord)[1].args)[3] ?? ""),
					/REDACTED/,
				);
				const compiledStdinSteps = readArray(JSON.parse(readString(compiled.stdin ?? "[]"))).map(
					(row) => readArray(row).map(readString),
				);
				assert.deepEqual(compiledStdinSteps[0], ["network", "request", "req-1"]);
				assert.deepEqual(compiledStdinSteps[1].slice(0, 3), ["network", "requests", "--filter"]);
				assert.doesNotMatch(readString(compiled.stdin ?? ""), /secret|user:pass|ok=1/);
				assert.doesNotMatch(
					JSON.stringify(result.details?.compiledNetworkSourceLookup),
					/secret|user:pass|ok=1/,
				);
				const lookup = readRecord(result.details?.networkSourceLookup);
				assert.equal(lookup.status, "failed-requests-found");
				assert.equal(readArray(lookup.failedRequests).length, 1);
				assert.equal(readArray(lookup.failedRequests).map(readRecord)[0].status, 500);
				assert.doesNotMatch(JSON.stringify(lookup), /secret|user:pass|ok=1/);
				assert.doesNotMatch(JSON.stringify(result), /secret|user:pass|ok=1/);
				assert.ok(
					readArray(lookup.candidates)
						.map(readRecord)
						.some(
							(candidate) =>
								candidate.source === "initiator" &&
								candidate.file === "src/api.ts" &&
								candidate.line === 1,
						),
				);
				assert.ok(
					readArray(lookup.candidates)
						.map(readRecord)
						.some(
							(candidate) =>
								candidate.source === "workspace-search" &&
								candidate.file !== undefined &&
								readString(candidate.file).endsWith(join("src", "api.ts")) &&
								candidate.line === 1,
						),
				);
				assert.equal(
					readArray(lookup.candidates)
						.map(readRecord)
						.some(
							(candidate) =>
								candidate.file === "src/ok.ts" ||
								candidate.file === "src/other.ts" ||
								(candidate.file !== undefined &&
									readString(candidate.file).endsWith(join("src", "ok.ts"))),
						),
					false,
				);

				const requestOnlyResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					networkSourceLookup: { requestId: "req-1" },
				});
				assert.equal(requestOnlyResult.isError, false);
				const requestOnlyCompiled = readRecord(
					requestOnlyResult.details?.compiledNetworkSourceLookup,
				);
				assert.deepEqual(
					readArray(requestOnlyCompiled.steps)
						.map(readRecord)
						.map((step) => step.args),
					[["network", "request", "req-1"]],
				);

				const sessionResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					networkSourceLookup: { namespace: "review", requestId: "req-1", session: "named" },
				});
				assert.equal(sessionResult.isError, false);
				const sessionCompiled = readRecord(sessionResult.details?.compiledNetworkSourceLookup);
				assert.deepEqual(sessionCompiled.args, [
					"--namespace",
					"review",
					"--session",
					"named",
					"batch",
				]);
				assert.deepEqual(
					readArray(sessionCompiled.steps)
						.map(readRecord)
						.map((step) => step.args),
					[["network", "request", "req-1"]],
				);

				const defaultNamespaceResult = await withPatchedEnv(
					{ AGENT_BROWSER_NAMESPACE: "prod" },
					async () =>
						executeRegisteredTool(harness.tool, harness.ctx, {
							networkSourceLookup: { namespace: "", requestId: "req-1", session: "named" },
						}),
				);
				assert.equal(defaultNamespaceResult.isError, false);
				const defaultNamespaceCompiled = readRecord(
					defaultNamespaceResult.details?.compiledNetworkSourceLookup,
				);
				assert.deepEqual(defaultNamespaceCompiled.args, [
					"--namespace",
					"",
					"--session",
					"named",
					"batch",
				]);

				const invocations = await readInvocationLog(logPath);
				assert.deepEqual(
					invocations
						.filter((entry) => entry.args.at(-1) === "batch")
						.map((entry) => entry.args.slice(-5)),
					[
						["--json", "--session", readString(result.details?.sessionName), "batch"],
						["--json", "--session", readString(requestOnlyResult.details?.sessionName), "batch"],
						["--namespace", "review", "--session", "named", "batch"],
						["--namespace", "", "--session", "named", "batch"],
					],
				);
				assert.ok(invocations.some((entry) => entry.args.slice(-2).join(" ") === "get url"));
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);
