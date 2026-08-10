/**
 * Purpose: Verify allowed-domain policy enforcement and cleanup at the extension entrypoint.
 * Responsibilities: Assert managed-session allowed-domain policy survives reload, fails closed on escapes, and is cleared on close or Electron cleanup.
 * Scope: Focused fake-upstream coverage for wrapper-owned allowed-domain session policy.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-allowed-domains.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createExtensionHarness,
	createToolBranchEntry,
	executeRegisteredTool,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

test("agentBrowserExtension fails when allowed-domain managed session escapes after click", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-allowed-domains-"));
	const statePath = join(tempDir, "page-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
function writeState(state) { fs.writeFileSync(statePath, JSON.stringify(state)); }
function readState() { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return { title: "", url: "about:blank" }; } }
if (args.includes("open")) {
  const url = args.at(-1);
  const state = url.includes("iana.org") ? { title: "Example Domains", url } : { title: "Example Domain", url: "https://example.com/" };
  writeState(state);
  process.stdout.write(JSON.stringify({ success: true, data: state }));
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "https://example.com/", refs: [{ ref: "e1", role: "heading", name: "Example Domain" }, { ref: "e2", role: "link", name: "Learn more" }, { ref: "e3", role: "link", name: "Same domain" }] } }));
} else if (args.includes("click")) {
  const ref = args.at(-1);
  const state = ref === "@e3" ? { title: "Example Same", url: "https://example.com/same" } : { title: "Example Domains", url: "https://www.iana.org/help/example-domains" };
  writeState(state);
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: ref } }));
} else if (args.includes("get") && args.includes("url")) {
  const state = readState();
  process.stdout.write(JSON.stringify({ success: true, data: { result: state.url, url: state.url } }));
} else if (args.includes("get") && args.includes("title")) {
  const state = readState();
  process.stdout.write(JSON.stringify({ success: true, data: { result: state.title, title: state.title } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: readState() }));
} else if (args.includes("close")) {
  process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const open = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--allowed-domains", "example.com", "open", "https://example.com"],
				sessionMode: "fresh",
			});
			assert.equal(open.isError, false, JSON.stringify(open));

			const branch = [createToolBranchEntry({ details: open.details ?? {}, isError: false })];
			const reloadedHarness = createExtensionHarness({ branch, cwd: tempDir });
			await runExtensionEvent(reloadedHarness.handlers, "session_start", { reason: "reload" }, reloadedHarness.ctx);

			const escapedClick = await executeRegisteredTool(reloadedHarness.tool, reloadedHarness.ctx, { args: ["click", "@e2"] });
			assert.equal(escapedClick.isError, true, JSON.stringify(escapedClick));
			assert.equal(escapedClick.details?.resultCategory, "failure");
			assert.equal(escapedClick.details?.failureCategory, "policy-blocked");
			assert.match((escapedClick.content[0] as { text: string }).text, /--allowed-domains example\.com does not allow www\.iana\.org/);
			assert.equal((escapedClick.details?.navigationSummary as { url?: string } | undefined)?.url, "https://www.iana.org/help/example-domains");

			const close = await executeRegisteredTool(reloadedHarness.tool, reloadedHarness.ctx, { args: ["close"] });
			assert.equal(close.isError, false, JSON.stringify(close));
			const noPolicyClick = await executeRegisteredTool(reloadedHarness.tool, reloadedHarness.ctx, { args: ["click", "@e2"] });
			assert.equal(noPolicyClick.isError, false, JSON.stringify(noPolicyClick));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension preserves policies from overlapping caller-owned sessions", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-allowed-domains-concurrent-"));
	const startedPath = join(tempDir, "slow-started");
	const generationStartedPath = join(tempDir, "generation-started");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const sessionIndex = args.indexOf("--session");
const session = sessionIndex >= 0 ? args[sessionIndex + 1] : "default";
const statePath = path.join(${JSON.stringify(tempDir)}, "state-" + session + ".json");
const readState = () => { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return { title: "", url: "about:blank" }; } };
const writeState = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
if (args.includes("open")) {
  if (session === "slow" || session === "generation") {
    fs.writeFileSync(session === "slow" ? ${JSON.stringify(startedPath)} : ${JSON.stringify(generationStartedPath)}, "started");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, session === "slow" ? 100 : 500);
  }
  const url = args.at(-1);
  const state = { title: session, url };
  writeState(state);
  process.stdout.write(JSON.stringify({ success: true, data: state }));
} else if (args.includes("get") && args.includes("url")) {
  const state = readState();
  process.stdout.write(JSON.stringify({ success: true, data: { result: state.url, url: state.url } }));
} else if (args.includes("click")) {
  const state = { title: "Outside", url: "https://outside.test/" + session };
  writeState(state);
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args.at(-1), ...state } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: readState() }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: readState() }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const slowOpen = executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "slow", "--allowed-domains", "example.com", "open", "https://example.com/"],
			});
			for (let attempt = 0; attempt < 3_000; attempt += 1) {
				try { await access(startedPath); break; } catch {
					if (attempt === 2_999) assert.fail("slow caller-owned open did not start");
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
			}
			const fastOpen = executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "fast", "--allowed-domains", "iana.org", "open", "https://iana.org/"],
			});
			const opened = await Promise.all([slowOpen, fastOpen]);
			assert.equal(opened.every((result) => result.isError === false), true, JSON.stringify(opened));

			for (const session of ["slow", "fast"]) {
				const escaped = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", session, "click", "a"] });
				assert.equal(escaped.isError, true, JSON.stringify(escaped));
				assert.equal(escaped.details?.failureCategory, "policy-blocked");
			}

			const generationOpen = executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "generation", "--allowed-domains", "example.com", "open", "https://example.com/"],
			});
			for (let attempt = 0; attempt < 3_000; attempt += 1) {
				try { await access(generationStartedPath); break; } catch {
					if (attempt === 2_999) assert.fail("generation caller-owned open did not start");
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
			}
			const managedOpen = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://managed.test/"] });
			assert.equal(managedOpen.isError, false, JSON.stringify(managedOpen));
			assert.equal((await generationOpen).isError, false);
			const generationEscape = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "generation", "click", "a"] });
			assert.equal(generationEscape.isError, true, JSON.stringify(generationEscape));
			assert.equal(generationEscape.details?.failureCategory, "policy-blocked");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension tracks fresh managed sessions that fail after allowed-domain policy checks", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-allowed-domains-fresh-fail-"));
	const statePath = join(tempDir, "page-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
function writeState(state) { fs.writeFileSync(statePath, JSON.stringify(state)); }
function readState() { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return { title: "", url: "about:blank" }; } }
if (args.includes("open")) {
  const url = args.at(-1);
  const state = url.includes("iana.org") ? { title: "Example Domains", url } : { title: "Example Domain", url: "https://example.com/" };
  writeState(state);
  process.stdout.write(JSON.stringify({ success: true, data: state }));
} else if (args.includes("click")) {
  const state = { title: "Example Domains", url: "https://www.iana.org/help/example-domains" };
  writeState(state);
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args.at(-1) } }));
} else if (args.includes("get") && args.includes("url")) {
  const state = readState();
  process.stdout.write(JSON.stringify({ success: true, data: { result: state.url, url: state.url } }));
} else if (args.includes("get") && args.includes("title")) {
  const state = readState();
  process.stdout.write(JSON.stringify({ success: true, data: { result: state.title, title: state.title } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: readState() }));
} else if (args.includes("close")) {
  process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const escapedOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--allowed-domains", "example.com", "open", "https://www.iana.org/"],
				sessionMode: "fresh",
			});
			assert.equal(escapedOpen.isError, true, JSON.stringify(escapedOpen));
			assert.equal(escapedOpen.details?.failureCategory, "policy-blocked");
			const outcome = escapedOpen.details?.managedSessionOutcome as { activeAfter?: boolean; attemptedSessionName?: string; currentSessionName?: string; status?: string; succeeded?: boolean } | undefined;
			assert.equal(outcome?.activeAfter, true);
			assert.equal(outcome?.status, "created");
			assert.equal(outcome?.succeeded, false);
			assert.equal(outcome?.currentSessionName, escapedOpen.details?.sessionName);

			const branch = [createToolBranchEntry({ details: escapedOpen.details ?? {}, isError: true })];
			const reloadedHarness = createExtensionHarness({ branch, cwd: tempDir });
			await runExtensionEvent(reloadedHarness.handlers, "session_start", { reason: "reload" }, reloadedHarness.ctx);
			const reloadedEscape = await executeRegisteredTool(reloadedHarness.tool, reloadedHarness.ctx, { args: ["click", "@e2"] });
			assert.equal(reloadedEscape.isError, true, JSON.stringify(reloadedEscape));
			assert.equal(reloadedEscape.details?.failureCategory, "policy-blocked");

			const close = await executeRegisteredTool(reloadedHarness.tool, reloadedHarness.ctx, { args: ["close"] });
			assert.equal(close.isError, false, JSON.stringify(close));
			const closeOutcome = close.details?.managedSessionOutcome as { attemptedSessionName?: string; status?: string } | undefined;
			assert.equal(closeOutcome?.status, "closed");
			assert.equal(closeOutcome?.attemptedSessionName, escapedOpen.details?.sessionName);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension does not restore namespaced allowed-domain policy after electron cleanup closes the session", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(process.platform === "win32" ? join(tmpdir(), "a-") : "/tmp/a-");
	const socketDir = await mkdtemp(process.platform === "win32" ? join(tmpdir(), "p-") : "/tmp/p-");
	const statePath = join(tempDir, "page-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
function writeState(state) { fs.writeFileSync(statePath, JSON.stringify(state)); }
function readState() { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return { title: "", url: "about:blank" }; } }
if (args.includes("open")) {
  const state = { title: "Example Domain", url: "https://example.com/" };
  writeState(state);
  process.stdout.write(JSON.stringify({ success: true, data: state }));
} else if (args.includes("click")) {
  const state = { title: "Example Domains", url: "https://www.iana.org/help/example-domains" };
  writeState(state);
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args.at(-1) } }));
} else if (args.includes("get") && args.includes("url")) {
  const state = readState();
  process.stdout.write(JSON.stringify({ success: true, data: { result: state.url, url: state.url } }));
} else if (args.includes("get") && args.includes("title")) {
  const state = readState();
  process.stdout.write(JSON.stringify({ success: true, data: { result: state.title, title: state.title } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: readState() }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_SOCKET_DIR: socketDir }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const sessionName = "caller-owned-electron";
			const open = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--namespace", "team", "--session", sessionName, "--allowed-domains", "example.com", "open", "https://example.com"],
				sessionMode: "fresh",
			});
			assert.equal(open.isError, false, JSON.stringify(open));
			const branch = [
				createToolBranchEntry({ details: open.details ?? {}, isError: false }),
				createToolBranchEntry({
					details: {
						args: ["electron", "cleanup"],
						command: "electron",
						electron: { cleanup: { results: [{ steps: [{ resource: "managed-session", sessionName, state: "removed" }] }] } },
						namespace: "team",
						sessionName,
					},
					isError: false,
				}),
			];
			const reloadedHarness = createExtensionHarness({ branch, cwd: tempDir });
			await runExtensionEvent(reloadedHarness.handlers, "session_start", { reason: "reload" }, reloadedHarness.ctx);

			const noPolicyClick = await executeRegisteredTool(reloadedHarness.tool, reloadedHarness.ctx, {
				args: ["--namespace", "team", "--session", sessionName, "click", "@e2"],
			});
			assert.equal(noPolicyClick.isError, false, JSON.stringify(noPolicyClick));
			assert.equal(noPolicyClick.details?.failureCategory, undefined);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
		await rm(socketDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension fails when allowed-domain batch navigation escapes", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-allowed-domains-batch-"));
	const statePath = join(tempDir, "page-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
let stdin = "";
function writeState(state) { fs.writeFileSync(statePath, JSON.stringify(state)); }
function readState() { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return { title: "", url: "about:blank" }; } }
function runCommand(command) {
  if (command[0] === "open") {
    const state = { title: "Example Domain", url: "https://example.com/" };
    writeState(state);
    return { command, success: true, result: { opened: command[1] } };
  }
  if (command[0] === "click") {
    const state = { title: "Example Domains", url: "https://www.iana.org/help/example-domains" };
    writeState(state);
    return { command, success: true, result: { clicked: command[1] } };
  }
  if (command[0] === "screenshot") {
    return { command, success: true, result: { path: command[1] } };
  }
  return { command, success: true, result: { ok: true } };
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  if (args.includes("batch")) {
    process.stdout.write(JSON.stringify(JSON.parse(stdin).map(runCommand)));
  } else if (args.includes("get") && args.includes("url")) {
    const state = readState();
    process.stdout.write(JSON.stringify({ success: true, data: { result: state.url, url: state.url } }));
  } else if (args.includes("get") && args.includes("title")) {
    const state = readState();
    process.stdout.write(JSON.stringify({ success: true, data: { result: state.title, title: state.title } }));
  } else if (args.includes("eval")) {
    process.stdout.write(JSON.stringify({ success: true, data: readState() }));
  } else {
    process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
  }
});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const escapedBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--allowed-domains", "example.com", "batch"],
				sessionMode: "fresh",
				stdin: JSON.stringify([
					["open", "https://example.com"],
					["click", "a.learn"],
				]),
			});
			assert.equal(escapedBatch.isError, true, JSON.stringify(escapedBatch));
			assert.equal(escapedBatch.details?.failureCategory, "policy-blocked");
			assert.equal((escapedBatch.details?.navigationSummary as { url?: string } | undefined)?.url, "https://www.iana.org/help/example-domains");
			assert.match((escapedBatch.content[0] as { text: string }).text, /--allowed-domains example\.com does not allow www\.iana\.org/);

			const missingPath = join(tempDir, "missing-batch.png");
			const missingArtifactBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--allowed-domains", "example.com", "batch"],
				sessionMode: "fresh",
				stdin: JSON.stringify([
					["open", "https://example.com"],
					["screenshot", missingPath],
				]),
			});
			assert.equal(missingArtifactBatch.isError, true, JSON.stringify(missingArtifactBatch));
			assert.equal(missingArtifactBatch.details?.failureCategory, "artifact-missing");
			assert.equal(Array.isArray(missingArtifactBatch.details?.batchSteps), true);
			assert.equal(Array.isArray(missingArtifactBatch.details?.data), true);
			const missingText = (missingArtifactBatch.content[0] as { text: string }).text;
			assert.match(missingText, /Batch failed: 1\/2 succeeded/);
			assert.match(missingText, /Step 2 — screenshot/);
			assert.doesNotMatch(missingText, /"0":/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension preserves in-domain navigation with allowed domains", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-allowed-domains-safe-"));
	const statePath = join(tempDir, "page-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
function writeState(state) { fs.writeFileSync(statePath, JSON.stringify(state)); }
function readState() { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return { title: "", url: "about:blank" }; } }
if (args.includes("open")) {
  const state = { title: "Example Domain", url: "https://example.com/" };
  writeState(state);
  process.stdout.write(JSON.stringify({ success: true, data: state }));
} else if (args.includes("click")) {
  const state = { title: "Example Same", url: "https://example.com/same" };
  writeState(state);
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args.at(-1) } }));
} else if (args.includes("get") && args.includes("url")) {
  const state = readState();
  process.stdout.write(JSON.stringify({ success: true, data: { result: state.url, url: state.url } }));
} else if (args.includes("get") && args.includes("title")) {
  const state = readState();
  process.stdout.write(JSON.stringify({ success: true, data: { result: state.title, title: state.title } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: readState() }));
} else if (args.includes("close")) {
  process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const open = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--allowed-domains=example.com", "open", "https://example.com"],
				sessionMode: "fresh",
			});
			assert.equal(open.isError, false, JSON.stringify(open));

			const safeClick = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e3"] });
			assert.equal(safeClick.isError, false, JSON.stringify(safeClick));
			assert.equal(safeClick.details?.resultCategory, "success");
			assert.equal((safeClick.details?.navigationSummary as { url?: string } | undefined)?.url, "https://example.com/same");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
