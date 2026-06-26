/**
 * Purpose: Verify experimental sourceLookup and networkSourceLookup compilation and analysis contracts.
 * Responsibilities: Assert metadata, prompt injection, bash blocking, CLI validation, missing binary, malformed envelope, fallback error, and oversized parse-failure behavior.
 * Scope: Integration-style Node test-runner coverage around the extension harness before result presentation and tab lifecycle suites.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-validation.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { Theme, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

import {
	WEB_SEARCH_PROMPT_GUIDELINE,
	QUICK_START_GUIDELINES,
	buildInstalledDocsGuideline,
	SHARED_BROWSER_PLAYBOOK_GUIDELINES,
	TOOL_PROMPT_GUIDELINES_PREFIX,
	TOOL_PROMPT_GUIDELINES_SUFFIX,
	WRAPPER_TAB_RECOVERY_BEHAVIOR,
} from "../extensions/agent-browser/lib/playbook.js";
import {
	discoverElectronApps,
	ELECTRON_DISCOVERY_MAX_RESULTS,
	type ElectronAppDiscovery,
} from "../extensions/agent-browser/lib/electron/discovery.js";
import {
	cleanupElectronLaunchResources,
} from "../extensions/agent-browser/lib/electron/cleanup.js";
import {
	cleanupSecureTempArtifacts,
	createSecureTempDirectory,
} from "../extensions/agent-browser/lib/temp.js";
import {
	TEST_SESSION_ID,
	createExtensionHarness,
	createToolBranchEntry,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	runExtensionEventResults,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
	type AgentBrowserToolParams,
	type AgentBrowserToolRenderContext,
} from "./helpers/agent-browser-harness.js";

import {
	PLAIN_RENDER_THEME,
	createRenderContext,
	electronAppNames,
	fakeAgentBrowserLifecycleScript,
	isTestPidAlive,
	readOptionalFakeElectronLaunchLog,
	stopTestPid,
	waitForTestPidExit,
	writeFakeLaunchableElectronApp,
	writeFakeLinuxElectronBinary,
	writeFakeMacElectronApp,
} from "./helpers/extension-validation-fixtures.js";

test("agentBrowserExtension compiles experimental source lookups and reports candidate evidence", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-source-lookup-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await mkdir(join(tempDir, "src"), { recursive: true });
	await writeFile(join(tempDir, "src", "Panel.tsx"), "export function Panel() { return <button>Save</button>; }\n");
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
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				sourceLookup: {
					selector: "#save",
					reactFiberId: "2",
					componentName: "Panel",
				},
			});

			assert.equal(result.isError, false);
			const compiledSourceLookup = result.details?.compiledSourceLookup as { steps?: Array<{ args: string[] }>; stdin?: string } | undefined;
			assert.deepEqual(compiledSourceLookup?.steps?.map((step) => step.args), [
				["is", "visible", "#save"],
				["get", "html", "#save"],
				["react", "inspect", "2"],
				["react", "tree"],
			]);
			assert.deepEqual(JSON.parse(compiledSourceLookup?.stdin ?? "[]"), compiledSourceLookup?.steps?.map((step) => step.args));
			const sourceLookup = result.details?.sourceLookup as { status?: string; candidates?: Array<{ source?: string; file?: string; line?: number; column?: number; confidence?: string; componentName?: string }> } | undefined;
			assert.equal(sourceLookup?.status, "candidates-found");
			assert.ok(sourceLookup?.candidates?.some((candidate) => candidate.source === "react-inspect" && candidate.file === "src/Button.tsx" && candidate.line === 17 && candidate.confidence === "high"));
			assert.ok(sourceLookup?.candidates?.some((candidate) => candidate.source === "dom-attribute" && candidate.file === "src/Button.tsx" && candidate.line === 17 && candidate.column === 5));
			assert.ok(sourceLookup?.candidates?.some((candidate) => candidate.source === "workspace-search" && candidate.componentName === "Panel" && candidate.file?.endsWith("src/Panel.tsx")));
			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(invocations[0]?.args.slice(-1), ["batch"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension explains packaged Electron sourceLookup no-candidate boundaries", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-source-lookup-electron-"));
	const applicationsDir = join(tempDir, "Applications");
	const logPath = join(tempDir, "invocations.log");
	const launchLogPath = join(tempDir, "electron-launch.log");
	const basePath = process.env.PATH ?? "";
	try {
		await mkdir(applicationsDir, { recursive: true });
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.PackagedElectron", launchLogPath, name: "Packaged Electron" });
		await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
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
	if (command === "tab" && subcommand === "list") {
	process.stdout.write(JSON.stringify({ success: true, data: { tabs: [{ active: true, title: "Packaged Electron", type: "page", url: "app://packaged" }] } }));
	return;
	}
	if (command === "snapshot") {
	process.stdout.write(JSON.stringify({ success: true, data: { origin: "app://packaged", title: "Packaged Electron", url: "app://packaged", refs: { e1: { role: "button", name: "Save" } }, snapshot: "- button \\\"Save\\\" [ref=e1]" } }));
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
});`);

		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const launchResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "launch", appPath: app.appPath } });
			assert.equal(launchResult.isError, false);
			const launch = (launchResult.details?.electron as { launch: { appPath?: string; executablePath?: string; launchId: string; sessionName: string; userDataDir: string } }).launch;

			const lookupResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				sourceLookup: { componentName: "MissingPackagedComponent", selector: "#save" },
			});
			assert.equal(lookupResult.isError, false);
			assert.match(lookupResult.content[0]?.text ?? "", /Source lookup found no candidate locations/);
			assert.match(lookupResult.content[0]?.text ?? "", /workspace scan was limited/);
			assert.match(lookupResult.content[0]?.text ?? "", /packaged Electron app code may live outside/);
			const sourceLookup = lookupResult.details?.sourceLookup as {
				electronContext?: { appName?: string; appPath?: string; executablePath?: string; launchId?: string; sessionName?: string; url?: string };
				limitations?: string[];
				status?: string;
				workspaceRoot?: string;
			} | undefined;
			assert.equal(sourceLookup?.status, "no-candidates");
			assert.equal(sourceLookup?.workspaceRoot, tempDir);
			assert.deepEqual(sourceLookup?.electronContext, {
				appName: "Packaged Electron",
				appPath: launch.appPath,
				executablePath: launch.executablePath,
				launchId: launch.launchId,
				sessionName: launch.sessionName,
				url: "app://packaged",
			});
			assert.ok(sourceLookup?.limitations?.some((item) => item.includes("Pi tool session cwd")));
			assert.ok(sourceLookup?.limitations?.some((item) => item.includes("app.asar")));
			const nextActions = lookupResult.details?.nextActions as Array<{ id: string; params?: { args?: string[]; electron?: { action?: string; launchId?: string } } }> | undefined;
			const actionIds = new Set(nextActions?.map((action) => action.id));
			assert.equal(actionIds.has("snapshot-electron-session"), true);
			assert.equal(actionIds.has("probe-electron-launch"), true);
			assert.equal(actionIds.has("list-electron-tabs"), true);
			assert.ok(nextActions?.some((action) => action.id === "probe-electron-launch" && action.params?.electron?.launchId === launch.launchId));
			assert.ok(nextActions?.some((action) => action.id === "snapshot-electron-session" && action.params?.args?.includes(launch.sessionName)));

			const cleanupResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "cleanup", launchId: launch.launchId } });
			assert.equal(cleanupResult.isError, false);
			await assert.rejects(stat(launch.userDataDir));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension does not add packaged Electron sourceLookup guidance for plain file pages", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-source-lookup-file-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	const fileUrl = `file://${join(tempDir, "plain.html")}`;
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
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
	if (command === "snapshot") {
		process.stdout.write(JSON.stringify({ success: true, data: { origin: ${JSON.stringify(fileUrl)}, title: "Plain file", url: ${JSON.stringify(fileUrl)}, refs: { e1: { role: "button", name: "Save" } }, snapshot: "- button \\\"Save\\\" [ref=e1]" } }));
		return;
	}
	if (command === "batch") {
		const steps = JSON.parse(stdin || "[]");
		const results = steps.map((step) => ({ command: step, success: true, result: step[0] === "get" && step[1] === "html" ? "<button>Save</button>" : { ok: true } }));
		process.stdout.write(JSON.stringify(results));
		return;
	}
	process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
});`);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const snapshotResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"], sessionMode: "fresh" });
			assert.equal(snapshotResult.isError, false);
			assert.equal((snapshotResult.details?.refSnapshot as { target?: { url?: string } } | undefined)?.target?.url, fileUrl);

			const lookupResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				sourceLookup: { componentName: "MissingLocalComponent", selector: "#save" },
			});
			assert.equal(lookupResult.isError, false);
			assert.match(lookupResult.content[0]?.text ?? "", /Source lookup found no candidate locations\./);
			assert.doesNotMatch(lookupResult.content[0]?.text ?? "", /packaged Electron|app\.asar|workspace scan was limited/);
			const sourceLookup = lookupResult.details?.sourceLookup as { electronContext?: unknown; status?: string; workspaceRoot?: string } | undefined;
			assert.equal(sourceLookup?.status, "no-candidates");
			assert.equal(sourceLookup?.electronContext, undefined);
			assert.equal(sourceLookup?.workspaceRoot, undefined);
			const nextActions = lookupResult.details?.nextActions as Array<{ id: string }> | undefined;
			assert.equal(nextActions?.some((action) => ["snapshot-electron-session", "probe-electron-launch", "list-electron-tabs"].includes(action.id)) ?? false, false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});


test("agentBrowserExtension compiles experimental network source lookups and reports failed-request candidates", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-network-source-lookup-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await mkdir(join(tempDir, "src"), { recursive: true });
	await writeFile(join(tempDir, "src", "api.ts"), "export const endpoint = 'https://user:pass@app.test/api/fail?token=secret&ok=1';\n");
	await writeFile(join(tempDir, "src", "ok.ts"), "export const endpoint = 'https://app.test/api/ok';\n");
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
    if (command[0] === "network" && command[1] === "request") {
      return { command, success: true, result: { id: "req-1", method: "GET", url: "https://user:pass@app.test/api/fail?token=secret&ok=1", status: 500, initiator: "src/api.ts:1:22" } };
    }
    if (command[0] === "network" && command[1] === "requests") {
      return { command, success: true, result: { requests: [
        { id: "req-1", method: "GET", url: "https://user:pass@app.test/api/fail?token=secret&ok=1", status: 500, initiator: { stack: "at load (src/api.ts:1:22)" } },
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
				networkSourceLookup: { requestId: "req-1", url: "https://user:pass@app.test/api/fail?token=secret&ok=1" },
			});

			assert.equal(result.isError, false);
			const compiled = result.details?.compiledNetworkSourceLookup as { steps?: Array<{ args: string[] }>; stdin?: string } | undefined;
			assert.deepEqual(compiled?.steps?.[0]?.args, ["network", "request", "req-1"]);
			assert.deepEqual(compiled?.steps?.[1]?.args.slice(0, 3), ["network", "requests", "--filter"]);
			assert.match(compiled?.steps?.[1]?.args[3] ?? "", /api\/fail/);
			assert.match(compiled?.steps?.[1]?.args[3] ?? "", /REDACTED/);
			const compiledStdinSteps = JSON.parse(compiled?.stdin ?? "[]") as string[][];
			assert.deepEqual(compiledStdinSteps[0], ["network", "request", "req-1"]);
			assert.deepEqual(compiledStdinSteps[1]?.slice(0, 3), ["network", "requests", "--filter"]);
			assert.doesNotMatch(compiled?.stdin ?? "", /secret|user:pass|ok=1/);
			assert.doesNotMatch(JSON.stringify(result.details?.compiledNetworkSourceLookup), /secret|user:pass|ok=1/);
			const lookup = result.details?.networkSourceLookup as { status?: string; failedRequests?: Array<{ status?: number; url?: string }>; candidates?: Array<{ source?: string; file?: string; line?: number; requestUrl?: string }> } | undefined;
			assert.equal(lookup?.status, "failed-requests-found");
			assert.equal(lookup?.failedRequests?.[0]?.status, 500);
			assert.doesNotMatch(JSON.stringify(lookup), /secret|user:pass|ok=1/);
			assert.doesNotMatch(JSON.stringify(result), /secret|user:pass|ok=1/);
			assert.ok(lookup?.candidates?.some((candidate) => candidate.source === "initiator" && candidate.file === "src/api.ts" && candidate.line === 1));
			assert.ok(lookup?.candidates?.some((candidate) => candidate.source === "workspace-search" && candidate.file?.endsWith("src/api.ts") && candidate.line === 1));
			assert.equal(lookup?.candidates?.some((candidate) => candidate.file === "src/ok.ts" || candidate.file?.endsWith("src/ok.ts")), false);

			const requestOnlyResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				networkSourceLookup: { requestId: "req-1" },
			});
			assert.equal(requestOnlyResult.isError, false);
			const requestOnlyCompiled = requestOnlyResult.details?.compiledNetworkSourceLookup as { steps?: Array<{ args: string[] }> } | undefined;
			assert.deepEqual(requestOnlyCompiled?.steps?.map((step) => step.args), [["network", "request", "req-1"]]);

			const sessionResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				networkSourceLookup: { namespace: "review", requestId: "req-1", session: "named" },
			});
			assert.equal(sessionResult.isError, false);
			const sessionCompiled = sessionResult.details?.compiledNetworkSourceLookup as { args?: string[]; steps?: Array<{ args: string[] }> } | undefined;
			assert.deepEqual(sessionCompiled?.args, ["--namespace", "review", "--session", "named", "batch"]);
			assert.deepEqual(sessionCompiled?.steps?.map((step) => step.args), [["network", "request", "req-1"]]);

			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(invocations[0]?.args.slice(-1), ["batch"]);
			assert.deepEqual(invocations[2]?.args.slice(-5), ["--namespace", "review", "--session", "named", "batch"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
