import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentBrowserNextAction } from "../extensions/agent-browser/lib/results/contracts.js";
import { runAgentBrowserProcess } from "../extensions/agent-browser/lib/process.js";
import { createExtensionHarness, executeRegisteredTool, runExtensionEvent, withPatchedEnv } from "./helpers/agent-browser-harness.js";

const enabled = process.env.PI_AGENT_BROWSER_REAL_UPSTREAM === "1";

for (const mode of ["explicit", "empty-namespace", "managed"] as const) {
	test(`native covered-click recovery through registered tools (${mode})`, {
		skip: enabled ? false : "Set PI_AGENT_BROWSER_REAL_UPSTREAM=1 to run against the installed upstream browser.",
	}, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "ov-"));
		const server = createServer((_request, response) => {
			response.setHeader("content-type", "text/html");
			response.end(`<!doctype html><title>Covered click fixture</title>
				<button id="target" onclick="window.targetClicks++">Target</button>
				<div id="cover" style="position:fixed;inset:0;background:white;z-index:10" onclick="window.coverClicks++">Cover</div>
				<script>window.targetClicks=0;window.coverClicks=0;</script>`);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const url = `http://127.0.0.1:${address.port}`;
		const namespace = mode === "managed" ? undefined : mode === "empty-namespace" ? "" : "tenant";
		const prefix = namespace === undefined ? [] : ["--namespace", namespace, "--session", "overlay"];
		try {
			await withPatchedEnv({
				HOME: root, USERPROFILE: root, AGENT_BROWSER_CONFIG: undefined,
				AGENT_BROWSER_NAMESPACE: mode === "explicit" ? namespace : "ambient",
				PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"), PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0",
			}, async () => {
				const harness = createExtensionHarness({ cwd: root, sessionId: "overlay" });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				try {
					const opened = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "open", url] });
					assert.equal(opened.isError, false, JSON.stringify(opened));
					const sessionName = opened.details?.sessionName;
					assert.equal(typeof sessionName, "string");
					const identity = [...(namespace === undefined ? [] : ["--namespace", namespace]), "--session", String(sessionName)];
					const raw = await runAgentBrowserProcess({ args: ["--json", "--namespace", namespace ?? "", "--session", String(sessionName), "click", "#target"], cwd: root });
					assert.equal(raw.exitCode, 1, raw.stdout);
					assert.match(raw.stdout, /is covered by.*at its click point/);
					t.diagnostic(JSON.stringify({ nativeCoveredClick: JSON.parse(raw.stdout), mode }));

					const commands = [
						["click", "#target"], ["find", "text", "Target", "click"], ["find", "text", "Target"],
						["find", "role", "button", "click", "--name", "Target"], ["find", "role", "button"],
						["find", "first", "button", "click"], ["find", "last", "button"],
						["find", "nth", "0", "button", "click"], ["find", "nth", "0", "button"],
					];
					for (const params of [
						...commands.map((args) => ({ args: [...prefix, ...args] })),
						{ args: [...prefix, "--json", "click", "#target"] },
						{ args: [...prefix, "batch"], stdin: JSON.stringify(commands) },
						...(mode === "empty-namespace" ? [] : [{ semanticAction: { action: "click", locator: "text", value: "Target", ...(mode === "managed" ? {} : { session: "overlay" }) } }]),
						...(mode === "managed" ? [{ job: { steps: [{ action: "click", locator: "text", value: "Target" }] } }] : []),
					]) {
						const result = await executeRegisteredTool(harness.tool, harness.ctx, params);
						assert.equal(result.isError, true, JSON.stringify(result));
						assert.equal(result.details?.failureCategory, "upstream-error", JSON.stringify(result));
						assert.equal(result.details?.sessionName, sessionName);
						assert.equal(result.details?.namespace, namespace);
						const actions = result.details?.nextActions as AgentBrowserNextAction[] | undefined;
						assert.deepEqual(actions?.map(({ id, params }) => ({ id, params })), [{
							id: "inspect-overlay-state", params: { args: [...identity, "snapshot", "-i"] },
						}], JSON.stringify(result));
						const text = result.content[0]?.text ?? "";
						if ("args" in params && params.args?.includes("--json")) assert.equal(JSON.parse(text).success, false);
						else assert.match(text, /inspect-overlay-state/);
						const rows = result.details?.batchSteps as Array<{ failureCategory?: string; nextActions?: AgentBrowserNextAction[] }> | undefined;
						for (const row of rows ?? []) {
							assert.equal(row.failureCategory, "upstream-error");
							assert.deepEqual(row.nextActions, actions);
						}
						const inspection = await executeRegisteredTool(harness.tool, harness.ctx, actions?.[0]?.params);
						assert.equal(inspection.isError, false, JSON.stringify(inspection));
						assert.equal(inspection.details?.sessionName, sessionName);
						assert.equal(inspection.details?.namespace, namespace);
						t.diagnostic(JSON.stringify({ mode, params, failureCategory: result.details?.failureCategory, isError: result.isError, actions, failedRows: rows?.length }));
					}
					const hover = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "hover", "#target"] });
					assert.equal(hover.isError, true);
					assert.match(hover.content[0]?.text ?? "", /is covered by.*at its click point/);
					assert.equal(hover.details?.nextActions, undefined);
					const state = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: [...prefix, "eval", "--stdin"], stdin: "({targetClicks,coverClicks,coverExists:!!document.querySelector('#cover')})",
					});
					assert.equal(state.isError, false, JSON.stringify(state));
					assert.deepEqual((state.details?.data as { result?: unknown } | undefined)?.result, { targetClicks: 0, coverClicks: 0, coverExists: true });
					t.diagnostic(JSON.stringify({ mode, unchangedPage: state.details?.data, hoverRecovery: hover.details?.nextActions ?? null }));
				} finally {
					const closed = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "close"] });
					assert.equal(closed.isError, false, JSON.stringify(closed));
					await runExtensionEvent(harness.handlers, "session_shutdown", {}, harness.ctx);
				}
			});
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
			await rm(root, { recursive: true, force: true });
		}
	});
}
