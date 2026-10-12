import assert from "node:assert/strict";
import { readArray, readRecord, readString } from "./helpers/assertions.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { stripWrapperPrefix, needsRootSessionPageCheck } from "./helpers/passthrough-fixture.js";

test(
	"agentBrowserExtension rejects per-call idle timeout changes that would restart the browser",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-idle-timeout-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, idleTimeout: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { title: "Example Domain", url: "https://example.com/" } }));`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS: "1234",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const mismatch = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--idle-timeout", "5000", "open", "https://example.com/"],
						sessionMode: "fresh",
					});
					assert.ok(mismatch.details);
					assert.equal(mismatch.isError, true);
					assert.match(
						readString(mismatch.details.validationError),
						/conflicts with this Pi process's managed-session idle timeout/,
					);
					assert.match(
						readString(mismatch.details.validationError),
						/PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS=5000/,
					);
					assert.deepEqual(await readInvocationLog(logPath), []);

					const inlineAligned = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--idle-timeout=1234", "open", "https://example.com/"],
						sessionMode: "fresh",
					});
					assert.ok(inlineAligned.details);
					assert.equal(inlineAligned.isError, true);
					assert.match(
						readString(inlineAligned.details.validationError),
						/does not support `--idle-timeout=<value>`/,
					);
					assert.deepEqual(await readInvocationLog(logPath), []);

					const aligned = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--idle-timeout", "1234", "open", "https://example.com/"],
						sessionMode: "fresh",
					});
					assert.equal(aligned.isError, false);
					const alignedInvocations = await readInvocationLog(logPath);
					assert.deepEqual(
						alignedInvocations.map((entry) => entry.args.slice(-2)),
						[
							["open", "https://example.com/"],
							["tab", "list"],
						],
					);
					assert.deepEqual(
						alignedInvocations.map((entry) => entry.idleTimeout),
						["1234", "1234"],
					);

					const activeSessionMismatch = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--idle-timeout", "5000", "open", "https://example.com/next"],
					});
					assert.ok(activeSessionMismatch.details);
					assert.equal(activeSessionMismatch.isError, true);
					assert.match(
						readString(activeSessionMismatch.details.validationError),
						/PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS=5000/,
					);
					assert.equal(activeSessionMismatch.details.sessionRecoveryHint, undefined);
					assert.deepEqual(await readInvocationLog(logPath), alignedInvocations);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension preserves one attached Chrome connection across explicit-session follow-ups",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-attached-session-"));
		const logPath = join(tempDir, "invocations.log");
		const failedDaemonPath = join(tempDir, "failed-daemon-active");
		const unsafeTargetPath = join(tempDir, "unsafe-target");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const valueFlags = new Set(["--allow-file-access", "--args", "--cdp", "--namespace", "--session"]);
let commandIndex = -1;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--json") continue;
  if (valueFlags.has(args[index])) { index += 1; continue; }
  if (args[index].startsWith("--")) continue;
  commandIndex = index;
  break;
}
const command = args[commandIndex] || "unknown";
const subcommand = args[commandIndex + 1];
const sessionName = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
if (process.env.PI_AGENT_BROWSER_TEST_FAIL_ATTACHED_GET_URL === "1" && command === "get" && subcommand === "url" && args.includes("--cdp")) {
  fs.writeFileSync(${JSON.stringify(failedDaemonPath)}, "active");
  process.stdout.write(JSON.stringify({ success: false, error: "attached get url failed after launch" }));
  process.exit(1);
}
const currentUrl = fs.existsSync(${JSON.stringify(unsafeTargetPath)}) ? "file:///tmp/private.html" : "https://dash.cloudflare.com/";
const sessionActive = sessionName === "cloudflare-live" || fs.existsSync(${JSON.stringify(failedDaemonPath)});
const batchInput = command === "batch" ? fs.readFileSync(0, "utf8") : "";
const data = command === "batch"
  ? JSON.parse(batchInput).map((step) => ({
      command: step,
      result: step[0] === "open"
        ? { url: step[1] }
        : step[0] === "snapshot"
          ? { refs: { e1: {} }, snapshot: "- heading \\"Cloudflare Dashboard\\" [ref=e1]", title: "Cloudflare Dashboard", url: currentUrl }
          : step[0] === "network" && step[1] === "route"
            ? { routed: step[2] }
            : {},
      success: true,
    }))
  : command === "tab" && subcommand === "list"
  ? { tabs: [{ tabId: "t1", url: currentUrl, active: true }] }
  : command === "session" && subcommand === "info"
  ? { active: sessionActive, runtime: sessionActive ? { restoreKey: null } : null }
  : command === "get" && subcommand === "url"
  ? { result: currentUrl, url: currentUrl }
  : command === "snapshot"
    ? { snapshot: "- heading \\"Cloudflare Dashboard\\" [ref=e1]", origin: currentUrl }
    : command === "network" && subcommand === "requests"
      ? { requests: [{ method: "GET", requestId: "after-close", resourceType: "fetch", url: "https://dash.cloudflare.com/api/test" }] }
      : { connected: command === "connect" };
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
					PI_AGENT_BROWSER_TEST_PRESERVE_INTERNAL_LAUNCH_FLAGS: "1",
				},
				async () => {
					const harness = createExtensionHarness({
						cwd: tempDir,
						prompt: "Inspect the attached Cloudflare tab.",
					});
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const connect = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "cloudflare-live", "connect", "9222"],
					});
					const url = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "cloudflare-live", "get", "url"],
					});
					const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "cloudflare-live", "snapshot", "-i"],
					});
					const attachedBranch = harness.ctx.sessionManager.getBranch().slice();
					const attachedCloseThenOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "cloudflare-live", "batch"],
						stdin: JSON.stringify([["close"], ["open", "https://dash.cloudflare.com/"]]),
					});
					const snapshotAfterNestedClose = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "cloudflare-live", "snapshot", "-i"],
					});
					assert.ok(snapshotAfterNestedClose.details);
					const freshLabeledUrl = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "cloudflare-live", "get", "url"],
						sessionMode: "fresh",
					});

					assert.equal(connect.isError, false, readString(readRecord(connect.content[0]).text));
					assert.equal(url.isError, false, readString(readRecord(url.content[0]).text));
					assert.equal(snapshot.isError, false, readString(readRecord(snapshot.content[0]).text));
					assert.equal(
						attachedCloseThenOpen.isError,
						false,
						readString(readRecord(attachedCloseThenOpen.content[0]).text),
					);
					assert.equal(
						snapshotAfterNestedClose.isError,
						false,
						readString(readRecord(snapshotAfterNestedClose.content[0]).text),
					);
					assert.equal(snapshotAfterNestedClose.details.attachedBrowserSession, true);
					assert.equal(
						freshLabeledUrl.isError,
						false,
						readString(readRecord(freshLabeledUrl.content[0]).text),
					);
					const attachedInvocations = (await readInvocationLog(logPath)).filter((entry) =>
						entry.args.includes("cloudflare-live"),
					);
					assert.ok(attachedInvocations.some((entry) => entry.args.includes("connect")));
					assert.ok(attachedInvocations.some((entry) => entry.args.includes("snapshot")));
					assert.ok(
						attachedInvocations.some(
							(entry) => entry.args.includes("get") && entry.args.includes("url"),
						),
					);
					assert.ok(
						attachedInvocations.every(
							(entry) =>
								!entry.args.includes("--args") && !entry.args.includes("--allow-file-access"),
						),
					);

					const terminalCloseInvocationCount = (await readInvocationLog(logPath)).length;
					const attachedTerminalClose = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "cloudflare-live", "batch"],
						stdin: JSON.stringify([
							["network", "route", "**/api/**", "--body", "{}"],
							["snapshot", "-i"],
							["close"],
						]),
					});
					assert.ok(attachedTerminalClose.details);
					assert.equal(
						attachedTerminalClose.isError,
						false,
						readString(readRecord(attachedTerminalClose.content[0]).text),
					);
					assert.equal(attachedTerminalClose.details.refSnapshot, undefined);
					const terminalBranch = harness.ctx.sessionManager.getBranch().slice();
					const requestsAfterTerminalClose = await executeRegisteredTool(
						harness.tool,
						harness.ctx,
						{ args: ["--session", "cloudflare-live", "network", "requests"] },
					);
					assert.ok(requestsAfterTerminalClose.details);
					assert.equal(
						requestsAfterTerminalClose.isError,
						false,
						readString(readRecord(requestsAfterTerminalClose.content[0]).text),
					);
					assert.equal(requestsAfterTerminalClose.details.attachedBrowserSession, undefined);
					assert.equal(requestsAfterTerminalClose.details.networkRouteDiagnostics, undefined);
					const postCloseInvocations = (await readInvocationLog(logPath)).slice(
						terminalCloseInvocationCount,
					);
					const postCloseRequests = postCloseInvocations.find(
						(entry) => entry.args.includes("network") && entry.args.includes("requests"),
					);
					assert.equal(postCloseRequests?.args.includes("--args"), false);
					assert.equal(postCloseRequests.args.includes("--allow-file-access"), false);

					const terminalResumeInvocationCount = (await readInvocationLog(logPath)).length;
					const terminalResumeHarness = createExtensionHarness({
						branch: terminalBranch,
						cwd: tempDir,
						prompt: "Resume after the attached session was closed by a batch.",
					});
					await runExtensionEvent(
						terminalResumeHarness.handlers,
						"session_start",
						{ reason: "resume" },
						terminalResumeHarness.ctx,
					);
					const requestsAfterTerminalResume = await executeRegisteredTool(
						terminalResumeHarness.tool,
						terminalResumeHarness.ctx,
						{ args: ["--session", "cloudflare-live", "network", "requests"] },
					);
					assert.ok(requestsAfterTerminalResume.details);
					assert.equal(
						requestsAfterTerminalResume.isError,
						false,
						readString(readRecord(requestsAfterTerminalResume.content[0]).text),
					);
					assert.equal(requestsAfterTerminalResume.details.attachedBrowserSession, undefined);
					assert.equal(requestsAfterTerminalResume.details.networkRouteDiagnostics, undefined);
					const postResumeRequests = (await readInvocationLog(logPath))
						.slice(terminalResumeInvocationCount)
						.find((entry) => entry.args.includes("network") && entry.args.includes("requests"));
					assert.equal(postResumeRequests?.args.includes("--args"), false);
					assert.equal(postResumeRequests.args.includes("--allow-file-access"), false);

					const invocationCount = (await readInvocationLog(logPath)).length;
					const resumedHarness = createExtensionHarness({
						branch: attachedBranch,
						cwd: tempDir,
						prompt: "Resume the attached Cloudflare tab.",
					});
					await runExtensionEvent(
						resumedHarness.handlers,
						"session_start",
						{ reason: "resume" },
						resumedHarness.ctx,
					);
					const resumedSnapshot = await executeRegisteredTool(
						resumedHarness.tool,
						resumedHarness.ctx,
						{ args: ["--session", "cloudflare-live", "snapshot", "-i"] },
					);
					assert.equal(
						resumedSnapshot.isError,
						false,
						readString(readRecord(resumedSnapshot.content[0]).text),
					);
					const resumedInvocations = (await readInvocationLog(logPath)).slice(invocationCount);
					assert.ok(resumedInvocations.length > 0);
					assert.ok(
						resumedInvocations.every(
							(entry) =>
								!entry.args.includes("--args") && !entry.args.includes("--allow-file-access"),
						),
					);

					await writeFile(unsafeTargetPath, "unsafe", "utf8");
					const driftInvocationCount = (await readInvocationLog(logPath)).length;
					const localDriftSnapshot = await executeRegisteredTool(
						resumedHarness.tool,
						resumedHarness.ctx,
						{ args: ["--session", "cloudflare-live", "snapshot", "-i"] },
					);
					assert.equal(localDriftSnapshot.isError, false, JSON.stringify(localDriftSnapshot));
					const driftInvocations = (await readInvocationLog(logPath)).slice(driftInvocationCount);
					assert.ok(
						driftInvocations.some(
							(entry) => entry.args.includes("get") && entry.args.includes("url"),
						),
					);
					assert.ok(driftInvocations.some((entry) => entry.args.includes("snapshot")));

					const implicitHarness = createExtensionHarness({
						cwd: tempDir,
						prompt: "Reject content capture before the attached page URL is verified.",
					});
					await runExtensionEvent(
						implicitHarness.handlers,
						"session_start",
						{ reason: "new" },
						implicitHarness.ctx,
					);
					const implicitInvocationCount = (await readInvocationLog(logPath)).length;
					const blockedFirstUse = await executeRegisteredTool(
						implicitHarness.tool,
						implicitHarness.ctx,
						{ args: ["--cdp", "9222", "snapshot", "-i"], sessionMode: "fresh" },
					);
					assert.equal(blockedFirstUse.isError, true);
					assert.match(readString(readRecord(blockedFirstUse.content[0]).text), /unverified/i);
					assert.ok(
						(await readInvocationLog(logPath))
							.slice(implicitInvocationCount)
							.every((entry) => !entry.args.includes("snapshot")),
					);

					await rm(unsafeTargetPath, { force: true });
					const managedHarness = createExtensionHarness({
						cwd: tempDir,
						prompt: "Attach a managed session, verify it, then close it safely.",
					});
					await runExtensionEvent(
						managedHarness.handlers,
						"session_start",
						{ reason: "new" },
						managedHarness.ctx,
					);
					const managedUrl = await executeRegisteredTool(managedHarness.tool, managedHarness.ctx, {
						args: ["--cdp", "9222", "get", "url"],
						sessionMode: "fresh",
					});
					assert.ok(managedUrl.details);
					assert.equal(managedUrl.isError, false);
					const managedBranch = managedHarness.ctx.sessionManager.getBranch().slice();
					const managedSessionName = managedUrl.details.sessionName;
					assert.equal(typeof managedSessionName, "string");
					await writeFile(unsafeTargetPath, "unsafe", "utf8");
					const localManagedSnapshot = await executeRegisteredTool(
						managedHarness.tool,
						managedHarness.ctx,
						{ args: ["snapshot", "-i"] },
					);
					assert.equal(localManagedSnapshot.isError, false, JSON.stringify(localManagedSnapshot));
					await rm(unsafeTargetPath, { force: true });
					await runExtensionEvent(
						managedHarness.handlers,
						"session_tree",
						{ newLeafId: null, oldLeafId: "attached-branch" },
						managedHarness.ctx,
					);
					await runExtensionEvent(
						managedHarness.handlers,
						"session_shutdown",
						{ reason: "quit" },
						managedHarness.ctx,
					);
					const managedInvocations = (await readInvocationLog(logPath)).filter((entry) =>
						entry.args.includes(readString(managedSessionName)),
					);
					assert.ok(managedInvocations.some((entry) => entry.args.includes("close")));
					assert.ok(
						managedInvocations.every(
							(entry) =>
								!entry.args.includes("--args") && !entry.args.includes("--allow-file-access"),
						),
					);

					const namespaceResumeInvocationCount = (await readInvocationLog(logPath)).length;
					await withPatchedEnv({ AGENT_BROWSER_NAMESPACE: "changed-after-attach" }, async () => {
						const namespaceResumeHarness = createExtensionHarness({
							branch: managedBranch,
							cwd: tempDir,
							prompt:
								"Close the default-namespace attachment after the process environment namespace changes.",
						});
						await runExtensionEvent(
							namespaceResumeHarness.handlers,
							"session_start",
							{ reason: "resume" },
							namespaceResumeHarness.ctx,
						);
						await runExtensionEvent(
							namespaceResumeHarness.handlers,
							"session_shutdown",
							{ reason: "quit" },
							namespaceResumeHarness.ctx,
						);
					});
					const namespaceResumeInvocations = (await readInvocationLog(logPath))
						.slice(namespaceResumeInvocationCount)
						.filter((entry) => entry.args.includes(readString(managedSessionName)));
					assert.ok(namespaceResumeInvocations.some((entry) => entry.args.includes("close")));
					assert.ok(
						namespaceResumeInvocations.every(
							(entry) =>
								!entry.args.includes("--args") && !entry.args.includes("--allow-file-access"),
						),
					);

					await withPatchedEnv({ PI_AGENT_BROWSER_TEST_FAIL_ATTACHED_GET_URL: "1" }, async () => {
						const failedHarness = createExtensionHarness({
							cwd: tempDir,
							prompt: "Clean up a failed attachment that still started its daemon.",
						});
						await runExtensionEvent(
							failedHarness.handlers,
							"session_start",
							{ reason: "new" },
							failedHarness.ctx,
						);
						const failedAttach = await executeRegisteredTool(
							failedHarness.tool,
							failedHarness.ctx,
							{ args: ["--cdp", "9222", "get", "url"], sessionMode: "fresh" },
						);
						assert.ok(failedAttach.details);
						assert.equal(failedAttach.isError, true);
						assert.equal(readRecord(failedAttach.details.managedSessionOutcome).activeAfter, true);
						assert.equal(failedAttach.details.attachedBrowserSession, true);
						const failedSessionName = failedAttach.details.sessionName;
						assert.equal(typeof failedSessionName, "string");
						const failedInvocationCount = (await readInvocationLog(logPath)).length;
						const failedResumeHarness = createExtensionHarness({
							branch: failedHarness.ctx.sessionManager.getBranch().slice(),
							cwd: tempDir,
							prompt: "Resume and clean up the failed attachment that retained an active daemon.",
						});
						await runExtensionEvent(
							failedResumeHarness.handlers,
							"session_start",
							{ reason: "resume" },
							failedResumeHarness.ctx,
						);
						await runExtensionEvent(
							failedResumeHarness.handlers,
							"session_shutdown",
							{ reason: "quit" },
							failedResumeHarness.ctx,
						);
						const failedInvocations = (await readInvocationLog(logPath))
							.slice(failedInvocationCount)
							.filter((entry) => entry.args.includes(readString(failedSessionName)));
						assert.ok(failedInvocations.some((entry) => entry.args.includes("close")));
						assert.ok(
							failedInvocations.every(
								(entry) =>
									!entry.args.includes("--args") && !entry.args.includes("--allow-file-access"),
							),
						);
					});

					await withPatchedEnv({ AGENT_BROWSER_CDP: "9222" }, async () => {
						const envHarness = createExtensionHarness({
							cwd: tempDir,
							prompt: "Reuse the CDP endpoint configured in the environment.",
						});
						await runExtensionEvent(
							envHarness.handlers,
							"session_start",
							{ reason: "new" },
							envHarness.ctx,
						);
						const envUrl = await executeRegisteredTool(envHarness.tool, envHarness.ctx, {
							args: ["--session", "env-cdp", "get", "url"],
						});
						const envSnapshot = await executeRegisteredTool(envHarness.tool, envHarness.ctx, {
							args: ["--session", "env-cdp", "snapshot", "-i"],
						});
						assert.ok(envSnapshot.details);
						assert.equal(envUrl.isError, false);
						assert.equal(envSnapshot.isError, false);
						assert.equal(envSnapshot.details.attachedBrowserSession, true);
						const envInvocations = (await readInvocationLog(logPath)).filter((entry) =>
							entry.args.includes("env-cdp"),
						);
						assert.ok(
							envInvocations.every(
								(entry) =>
									!entry.args.includes("--args") && !entry.args.includes("--allow-file-access"),
							),
						);
						await withPatchedEnv({ AGENT_BROWSER_CDP: undefined }, async () => {
							const resumedEnvHarness = createExtensionHarness({
								branch: envHarness.ctx.sessionManager.getBranch().slice(),
								cwd: tempDir,
								prompt:
									"Resume the environment-attached session without the original environment flag.",
							});
							await runExtensionEvent(
								resumedEnvHarness.handlers,
								"session_start",
								{ reason: "resume" },
								resumedEnvHarness.ctx,
							);
							const resumedEnvSnapshot = await executeRegisteredTool(
								resumedEnvHarness.tool,
								resumedEnvHarness.ctx,
								{ args: ["--session", "env-cdp", "snapshot", "-i"] },
							);
							assert.equal(resumedEnvSnapshot.isError, false);
						});
					});
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension passes through stateful browser-context workflow commands",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-stateful-matrix-"));
		const logPath = join(tempDir, "invocations.log");
		const statePath = join(tempDir, "state.json");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const valueFlags = new Set(["--allow-file-access", "--namespace", "--session"]);
let commandIndex = -1;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--json") continue;
  if (valueFlags.has(args[index])) { index += 1; continue; }
  if (args[index].startsWith("--")) continue;
  commandIndex = index;
  break;
}
const command = args[commandIndex];
const subcommand = args[commandIndex + 1];
if (command === "state" && subcommand === "save") fs.writeFileSync(args[commandIndex + 2], "{}");
const data = command === "get" && subcommand === "url" ? { result: "https://example.test/current", url: "https://example.test/current" }
  : command === "auth" && subcommand === "list" ? { profiles: [{ name: "demo" }] }
  : command === "auth" && subcommand === "show" ? { name: "demo", url: "https://example.test", username: "user@example.test" }
  : command === "cookies" && (subcommand === undefined || subcommand === "get") ? { cookies: [{ name: "sid", domain: "example.test", path: "/", value: "cookie-get-secret" }] }
  : command === "cookies" && subcommand === "set" ? { name: args[commandIndex + 2], value: args[commandIndex + 3], domain: "example.test" }
  : command === "storage" ? { type: args[commandIndex + 1], entries: [{ key: args[commandIndex + 3] || "theme", value: args[commandIndex + 4] || "storage-secret" }] }
  : command === "dialog" ? { open: subcommand === "status", accepted: subcommand === "accept", dismissed: subcommand === "dismiss" }
  : command === "frame" ? { frame: subcommand }
  : command === "state" && subcommand === "list" ? { states: [{ name: "state.json" }] }
  : command === "state" ? { path: args[commandIndex + 2], loaded: subcommand === "load" }
  : { ok: true, command, subcommand };
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);

		const commands = [
			["auth", "save", "demo", "--url", "https://example.test", "--username", "user@example.test"],
			["auth", "login", "demo"],
			["auth", "list"],
			["auth", "show", "demo"],
			["auth", "delete", "demo"],
			["auth", "remove", "demo"],
			["state", "save", statePath],
			["state", "load", statePath],
			["get", "url"],
			["state", "list"],
			["state", "clear", "caller-owned"],
			["cookies", "get"],
			["cookies", "set", "sid", "cookie-secret", "--url", "https://example.test"],
			["cookies", "clear"],
			["storage", "local", "set", "theme", "dark"],
			["storage", "session", "get", "theme"],
			["storage", "local", "clear"],
			["dialog", "status"],
			["dialog", "accept", "prompt text"],
			["dialog", "dismiss"],
			["frame", "#child-frame"],
			["frame", "main"],
			["confirm", "c_demo"],
			["deny", "c_demo"],
		] as const;

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({
					cwd: tempDir,
					prompt: "Exercise stateful browser workflows.",
				});
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				let storageSetResult: Awaited<ReturnType<typeof executeRegisteredTool>> | undefined;
				for (const args of commands) {
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: [...args],
					});
					// Every row in the fixed nonempty stateful sequence checks success and secret redaction.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.ok(result.details);
					// Every row in the fixed nonempty stateful sequence checks success and secret redaction.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(
						result.isError,
						false,
						`${args.join(" ")}: ${readString(readRecord(result.content[0]).text)}`,
					);
					// Every row in the fixed nonempty stateful sequence checks success and secret redaction.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.doesNotMatch(
						readString(readRecord(result.content[0]).text),
						/cookie-secret|cookie-get-secret|storage-secret/,
					);
					// Every row in the fixed nonempty stateful sequence checks success and secret redaction.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.doesNotMatch(
						JSON.stringify(result.details),
						/cookie-secret|cookie-get-secret|storage-secret/,
					);
					if (args[0] === "storage" && args[1] === "local" && args[2] === "set") {
						storageSetResult = result;
					}
					if (args[0] === "get" && args.at(1) === "url") {
						// The literal get-url row checks routing/payload; every stateful row also checks success.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.deepEqual(result.details.args, ["get", "url"]);
						// The literal get-url row checks routing/payload; every stateful row also checks success.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readRecord(result.details.data).url, "https://example.test/current");
					}
				}
				assert.match(readString(readRecord(storageSetResult?.content[0]).text), /theme: dark/);
				assert.match(JSON.stringify(storageSetResult?.details), /"value":"dark"/);

				const jsonResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [
						"--json",
						"cookies",
						"set",
						"sid",
						"json-cookie-secret",
						"--url",
						"https://example.test",
					],
				});
				assert.equal(jsonResult.isError, false);
				const textItems = jsonResult.content.filter((item) => item.type === "text");
				assert.ok(textItems.length > 0, "JSON cookie result must expose visible text");
				for (const item of textItems) {
					// The asserted nonempty text-result set checks every visible item for the cookie secret.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.doesNotMatch(item.text, /json-cookie-secret/);
				}

				const invocations = await readInvocationLog(logPath);
				const isSessionlessAuthRow = (args: readonly string[]) =>
					args[0] === "auth" &&
					["save", "list", "show", "delete", "remove"].includes(args[1] ?? "");
				const isSessionlessStateRow = (args: readonly string[]) =>
					args[0] === "state" &&
					(args[1] === "list" || (args[1] === "clear" && args[2] === "caller-owned"));
				// Exact argv and order including the root-session `get url` page checks and the explicit
				// --json follow-up; sessionless auth/state rows and page-transition/dialog/get-url rows stay
				// unprobed, so a missing or spurious URL probe fails here instead of being filtered away.
				assert.deepEqual(
					invocations.map((entry) => stripWrapperPrefix(entry.args)),
					[
						...commands.flatMap((args): string[][] => {
							const normalizedArgs = args.slice();
							const pageCheck =
								!isSessionlessAuthRow(normalizedArgs) &&
								!isSessionlessStateRow(normalizedArgs) &&
								needsRootSessionPageCheck(normalizedArgs)
									? [["get", "url"]]
									: [];
							return normalizedArgs[0] === "get" && normalizedArgs[1] === "url"
								? [normalizedArgs, ["tab", "list"]]
								: pageCheck.concat([normalizedArgs]);
						}),
						["get", "url"],
						[
							"--json",
							"cookies",
							"set",
							"sid",
							"json-cookie-secret",
							"--url",
							"https://example.test",
						],
					],
				);
				assert.ok(invocations.every((entry) => entry.args.includes("--json")));
				assert.ok(
					invocations.every((entry) => {
						const userArgs = stripWrapperPrefix(entry.args);
						return isSessionlessAuthRow(userArgs) || isSessionlessStateRow(userArgs)
							? !entry.args.includes("--session")
							: entry.args.includes("--session");
					}),
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension normalizes and repairs explicit screenshot artifact paths",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-screenshot-path-"));
		const logPath = join(tempDir, "invocations.log");
		const upstreamTempPath = join(tempDir, "upstream-temp.png");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://safe.example/" } }));
} else {
  const commandIndex = args.indexOf("screenshot");
  const requestedPath = args[commandIndex + 1];
  fs.mkdirSync(path.dirname(${JSON.stringify(upstreamTempPath)}), { recursive: true });
  fs.writeFileSync(${JSON.stringify(upstreamTempPath)}, "fake-png");
  process.stdout.write(JSON.stringify({ success: true, data: { path: ${JSON.stringify(upstreamTempPath)} }, error: null }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir, prompt: "Take a screenshot." });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "warden-vfr", "screenshot", ".dogfood/run/foo.png"],
				});
				assert.ok(result.details);

				const expectedPath = join(tempDir, ".dogfood/run/foo.png");
				assert.equal(result.isError, false);
				assert.equal(await readFile(expectedPath, "utf8"), "fake-png");
				const text = result.content[0]?.type === "text" ? result.content[0].text : "";
				assert.match(text, /Saved image: \.dogfood\/run\/foo\.png/);
				assert.match(text, /Artifact type: image/);
				assert.match(text, /Requested path: \.dogfood\/run\/foo\.png/);
				assert.match(
					text,
					new RegExp(`Absolute path: ${expectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
				);
				assert.match(text, /Exists: true/);
				assert.match(text, /Status: repaired-from-temp/);
				assert.match(
					text,
					new RegExp(`Reported path: ${upstreamTempPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
				);
				assert.match(text, /Session: warden-vfr/);
				assert.match(text, new RegExp(`CWD: ${tempDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

				const artifacts = readArray(result.details.artifacts).map(readRecord);
				assert.equal(artifacts[0].requestedPath, ".dogfood/run/foo.png");
				assert.equal(artifacts[0].absolutePath, expectedPath);
				assert.equal(artifacts[0].cwd, tempDir);
				assert.equal(artifacts[0].session, "warden-vfr");
				assert.equal(artifacts[0].status, "repaired-from-temp");
				assert.equal(artifacts[0].tempPath, upstreamTempPath);

				const invocations = await readInvocationLog(logPath);
				assert.deepEqual(invocations[0]?.args.at(-2), "get");
				assert.equal(
					invocations.find((entry) => entry.args.includes("screenshot"))?.args.at(-1),
					expectedPath,
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension creates parent directories for state save artifacts",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-state-save-path-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const path = args[args.length - 1];
fs.writeFileSync(path, JSON.stringify({ ok: true }));
process.stdout.write(JSON.stringify({ success: true, data: { path } }));`,
		);

		try {
			await withPatchedEnv(
				{ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_PAGE_URL: "https://fixture.test/" },
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir, prompt: "Save browser state." });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const statePath = join(tempDir, "missing", "parents", "fixture-state.json");
					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["state", "save", statePath],
					});
					assert.ok(result.details);

					assert.equal(result.isError, false, JSON.stringify(result));
					assert.equal(await readFile(statePath, "utf8"), JSON.stringify({ ok: true }));
					const [invocation] = await readInvocationLog(logPath);
					assert.equal(invocation.args.at(-1), statePath);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test("agentBrowserExtension blocks per-step batch screenshot annotation foot-guns", async (t) => {
	const tempDir = await mkdtemp(join(tmpdir(), "piab-batch-annotation-"));
	t.after(async () => await rm(tempDir, { force: true, recursive: true }));
	const harness = createExtensionHarness({
		cwd: tempDir,
		prompt: "Take annotated screenshots.",
	});
	const result = await executeRegisteredTool(harness.tool, harness.ctx, {
		args: ["batch"],
		stdin: JSON.stringify([["screenshot", "--annotate", join(tempDir, "foo.png")]]),
	});
	assert.ok(result.details);

	assert.equal(result.isError, true);
	assert.match(
		result.content[0]?.type === "text" ? result.content[0].text : "",
		/put --annotate in top-level args/i,
	);
});

test(
	"agentBrowserExtension normalizes and repairs batch screenshot artifact paths",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-batch-screenshot-path-"));
		const logPath = join(tempDir, "invocations.log");
		const upstreamTempPath = join(tempDir, "upstream-batch-temp.png");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.on("data", chunk => stdin += chunk);
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  fs.mkdirSync(path.dirname(${JSON.stringify(upstreamTempPath)}), { recursive: true });
  fs.writeFileSync(${JSON.stringify(upstreamTempPath)}, "fake-batch-png");
  process.stdout.write(JSON.stringify([{ command: ["screenshot", ".dogfood/run/good-batch.png"], success: true, error: null, result: { path: ${JSON.stringify(upstreamTempPath)} } }]));
});`,
		);

		try {
			await withPatchedEnv(
				{ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_PAGE_URL: "https://fixture.test/" },
				async () => {
					const harness = createExtensionHarness({
						cwd: tempDir,
						prompt: "Take a batch screenshot.",
					});
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--annotate", "batch"],
						stdin: '[["screenshot",".dogfood/run/good-batch.png"]]',
					});
					assert.ok(result.details);

					const expectedPath = join(tempDir, ".dogfood/run/good-batch.png");
					assert.equal(result.isError, false);
					assert.equal(await readFile(expectedPath, "utf8"), "fake-batch-png");
					const text = result.content[0]?.type === "text" ? result.content[0].text : "";
					assert.match(text, /Step 1 — screenshot/);
					assert.match(text, /Saved image: \.dogfood\/run\/good-batch\.png/);
					assert.match(text, /Requested path: \.dogfood\/run\/good-batch\.png/);
					assert.match(text, /Status: repaired-from-temp/);
					assert.match(
						text,
						new RegExp(`Reported path: ${upstreamTempPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
					);

					const artifacts = readArray(result.details.artifacts).map(readRecord);
					assert.equal(artifacts[0].requestedPath, ".dogfood/run/good-batch.png");
					assert.equal(artifacts[0].absolutePath, expectedPath);
					assert.equal(artifacts[0].status, "repaired-from-temp");
					assert.equal(artifacts[0].tempPath, upstreamTempPath);

					const [invocation] = await readInvocationLog(logPath);
					assert.deepEqual(readArray(JSON.parse(readString(invocation.stdin))), [
						["screenshot", expectedPath],
					]);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension guards wrapper-known trace and profiler ownership",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-trace-owner-"));
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("batch")) {
  const steps = JSON.parse(fs.readFileSync(0, "utf8") || "[]");
  process.stdout.write(JSON.stringify({ success: true, data: steps.map((step) => ({
    command: step,
    success: true,
    result: { lifecycle: { effectiveLaunch: { browserLaunched: step[0] !== "close" } } }
  })) }));
} else {
  const data = args.includes("get") && args.includes("url") ? { url: "https://safe.example/" } : { started: true };
  process.stdout.write(JSON.stringify({ success: true, data, error: null }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir, prompt: "Capture a trace." });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const traceStart = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "debug-session", "trace", "start"],
				});
				assert.equal(traceStart.isError, false);

				const profilerStart = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "debug-session", "profiler", "start"],
				});
				assert.equal(profilerStart.isError, true);
				assert.match(
					profilerStart.content[0]?.type === "text" ? profilerStart.content[0].text : "",
					/Wrapper believes trace tracing is active/,
				);

				const directClose = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "debug-session", "close"],
				});
				assert.equal(directClose.isError, false);
				const profilerAfterClose = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "debug-session", "profiler", "start"],
				});
				assert.equal(profilerAfterClose.isError, false);
				await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "debug-session", "close"],
				});
				const traceBeforeBatchClose = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "debug-session", "trace", "start"],
				});
				assert.equal(traceBeforeBatchClose.isError, false);
				const closeThenRelaunch = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "debug-session", "batch"],
					stdin: JSON.stringify([["close"], ["open", "https://safe.example/"]]),
				});
				assert.ok(closeThenRelaunch.details);
				assert.equal(closeThenRelaunch.isError, false);
				const verifiedAfterBatchClose = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "debug-session", "get", "url"],
				});
				assert.equal(verifiedAfterBatchClose.isError, false);
				const profilerAfterBatchClose = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "debug-session", "profiler", "start"],
				});
				assert.ok(profilerAfterBatchClose.details);
				assert.equal(
					profilerAfterBatchClose.isError,
					false,
					JSON.stringify({
						closeThenRelaunch: closeThenRelaunch.details,
						profilerAfterBatchClose: profilerAfterBatchClose.details,
					}),
				);

				const otherNamespaceTrace = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--namespace", "other", "--session", "other-a", "trace", "start"],
				});
				assert.equal(otherNamespaceTrace.isError, false);
				const traceA = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "all-a", "trace", "start"],
				});
				const profilerB = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "all-b", "profiler", "start"],
				});
				assert.equal(traceA.isError, false);
				assert.equal(profilerB.isError, false);
				const closeAll = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["close", "--all"],
				});
				assert.ok(closeAll.details);
				assert.equal(closeAll.isError, false);
				assert.equal(closeAll.details.closeAllApplied, true);
				const profilerAAfterCloseAll = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "all-a", "profiler", "start"],
				});
				assert.equal(profilerAAfterCloseAll.isError, false);
				const profilerOtherAfterCloseAll = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--namespace", "other", "--session", "other-a", "profiler", "start"],
				});
				assert.equal(profilerOtherAfterCloseAll.isError, true);
				assert.match(
					profilerOtherAfterCloseAll.content[0]?.type === "text"
						? profilerOtherAfterCloseAll.content[0].text
						: "",
					/Wrapper believes trace tracing is active/,
				);
				await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--namespace", "other", "--session", "other-a", "close"],
				});
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);
