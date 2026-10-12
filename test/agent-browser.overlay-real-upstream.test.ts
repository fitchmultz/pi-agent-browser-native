import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRecord, readArray, readString } from "./helpers/assertions.js";

import { runAgentBrowserProcess } from "../extensions/agent-browser/lib/process.js";
import {
	createExtensionHarness,
	executeRegisteredTool,
	createShortPrivateSocketDir,
	runExtensionEvent,
	withPatchedEnv,
} from "./helpers/agent-browser-harness.js";

const enabled = process.env.PI_AGENT_BROWSER_REAL_UPSTREAM === "1";

for (const mode of ["explicit", "empty-namespace", "managed"] as const) {
	test(
		`native covered-click recovery through registered tools (${mode})`,
		{
			skip: enabled
				? false
				: "Set PI_AGENT_BROWSER_REAL_UPSTREAM=1 to run against the installed upstream browser.",
		},
		async (t) => {
			const root = await mkdtemp(join(tmpdir(), "ov-"));
			const socketDir = createShortPrivateSocketDir(root);
			const server = createServer((_request, response) => {
				response.setHeader("content-type", "text/html");
				response.end(`<!doctype html><title>Covered click fixture</title>
				<button id="target" onclick="window.targetClicks++">Target</button>
				<div id="cover" style="position:fixed;inset:0;background:white;z-index:10" onclick="window.coverClicks++">Cover</div>
				<script>window.targetClicks=0;window.coverClicks=0;</script>`);
			});
			await new Promise<void>((resolve) => {
				server.listen(0, "127.0.0.1", resolve);
			});
			const address = server.address();
			assert.ok(address !== null && typeof address !== "string");
			const url = `http://127.0.0.1:${address.port}`;
			const namespaces = { managed: undefined, "empty-namespace": "", explicit: "tenant" };
			const namespace = namespaces[mode];
			const prefix =
				namespace === undefined ? [] : ["--namespace", namespace, "--session", "overlay"];
			const namespacePrefix = prefix.slice(0, 2);
			const nativeNamespace = namespace ?? "";
			const initialSessionOptions = mode === "managed" ? { sessionMode: "fresh" } : {};
			try {
				await withPatchedEnv(
					{
						HOME: root,
						USERPROFILE: root,
						AGENT_BROWSER_CONFIG: undefined,
						AGENT_BROWSER_NAMESPACE: mode === "explicit" ? namespace : "ambient",
						PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
						PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0",
					},
					async () => {
						const harness = createExtensionHarness({ cwd: root, sessionId: "overlay" });
						await runExtensionEvent(
							harness.handlers,
							"session_start",
							{ reason: "new" },
							harness.ctx,
						);
						try {
							const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
								args: [...prefix, "open", url],
								// This variant exercises wrapper ownership, not automatic root-group caller ownership.
								...initialSessionOptions,
							});
							assert.equal(opened.isError, false, JSON.stringify(opened));
							const sessionName = readRecord(opened.details).sessionName;
							assert.equal(typeof sessionName, "string");
							const identity = [...namespacePrefix, "--session", readString(sessionName)];
							const raw = await runAgentBrowserProcess({
								// Raw controls must keep the managed idle policy or upstream relaunches at about:blank.
								ownedManagedSession: mode === "managed",
								args: [
									"--json",
									"--namespace",
									nativeNamespace,
									"--session",
									readString(sessionName),
									"click",
									"#target",
								],
								cwd: root,
							});
							assert.equal(raw.exitCode, 1, raw.stdout);
							assert.match(raw.stdout, /is covered by.*at its click point/);
							t.diagnostic(
								JSON.stringify({ nativeCoveredClick: readRecord(JSON.parse(raw.stdout)), mode }),
							);

							const commands = [
								["click", "#target"],
								["find", "text", "Target", "click"],
								["find", "text", "Target"],
								["find", "role", "button", "click", "--name", "Target"],
								["find", "role", "button"],
								["find", "first", "button", "click"],
								["find", "last", "button"],
								["find", "nth", "0", "button", "click"],
								["find", "nth", "0", "button"],
							];
							for (const params of [
								{ args: [...prefix, "click", "#target"] },
								{ args: [...prefix, "--json", "click", "#target"] },
								{ args: [...prefix, "batch"], stdin: JSON.stringify(commands) },
								...(mode === "empty-namespace"
									? []
									: [
											{
												semanticAction: {
													action: "click",
													locator: "text",
													value: "Target",
													...(mode === "managed" ? {} : { session: "overlay" }),
												},
											},
										]),
								...(mode === "managed"
									? [
											{
												args: ["batch", "--bail"],
												stdin: JSON.stringify([["find", "text", "Target", "click"]]),
											},
										]
									: []),
							]) {
								// Inspect each covered-click failure before the next call mutates the same native page/session.
								// oxlint-disable-next-line no-await-in-loop
								const result = await executeRegisteredTool(harness.tool, harness.ctx, params);
								// The fixed click variants assert native failure and identity; only batch variants have per-row receipts.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(result.isError, true, JSON.stringify(result));
								// The fixed click variants assert native failure and identity; only batch variants have per-row receipts.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(
									readRecord(result.details).failureCategory,
									"upstream-error",
									JSON.stringify(result),
								);
								// The fixed click variants assert native failure and identity; only batch variants have per-row receipts.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(readRecord(result.details).sessionName, sessionName);
								// The fixed click variants assert native failure and identity; only batch variants have per-row receipts.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(readRecord(result.details).namespace, namespace);
								const actions = readArray(readRecord(result.details).nextActions);
								// The fixed click variants assert native failure and identity; only batch variants have per-row receipts.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.deepEqual(
									actions.map((action) => {
										const { id, params: actionParams } = readRecord(action);
										return { id, params: actionParams };
									}),
									[
										{
											id: "inspect-overlay-state",
											params: { args: [...identity, "snapshot", "-i"] },
										},
									],
									JSON.stringify(result),
								);
								const text = readString(readRecord(result.content[0]).text);
								if ("args" in params && params.args?.includes("--json") === true) {
									// The fixed click variants assert native failure and identity; only batch variants have per-row receipts.
									// oxlint-disable-next-line node-test/no-conditional-assertion
									assert.equal(readRecord(JSON.parse(text)).success, false);
								} else {
									// The fixed click variants assert native failure and identity; only batch variants have per-row receipts.
									// oxlint-disable-next-line node-test/no-conditional-assertion
									assert.match(text, /inspect-overlay-state/);
								}
								const rows = readArray(readRecord(result.details).batchSteps ?? []).map(readRecord);
								const expectedCommands =
									"stdin" in params
										? readArray(JSON.parse(readString(params.stdin))).map((row) =>
												readArray(row).map(readString),
											)
										: [];
								// Every declared batch must retain all native failures in input order; direct calls have no rows.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.deepEqual(
									rows.map((row) => ({ command: row.command, success: row.success })),
									expectedCommands.map((command) => ({ command, success: false })),
								);
								for (const row of rows) {
									// The fixed click variants assert native failure and identity; only batch variants have per-row receipts.
									// oxlint-disable-next-line node-test/no-conditional-assertion
									assert.equal(readRecord(row).failureCategory, "upstream-error");
									// The fixed click variants assert native failure and identity; only batch variants have per-row receipts.
									// oxlint-disable-next-line node-test/no-conditional-assertion
									assert.deepEqual(readRecord(row).nextActions, actions);
								}
								// Inspect each covered-click failure before the next call mutates the same native page/session.
								// oxlint-disable-next-line no-await-in-loop
								const inspection = await executeRegisteredTool(
									harness.tool,
									harness.ctx,
									readRecord(actions[0]).params,
								);
								// The fixed click variants assert native failure and identity; only batch variants have per-row receipts.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(inspection.isError, false, JSON.stringify(inspection));
								// The fixed click variants assert native failure and identity; only batch variants have per-row receipts.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(readRecord(inspection.details).sessionName, sessionName);
								// The fixed click variants assert native failure and identity; only batch variants have per-row receipts.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(readRecord(inspection.details).namespace, namespace);
								t.diagnostic(
									JSON.stringify({
										mode,
										params,
										failureCategory: readRecord(result.details).failureCategory,
										isError: result.isError,
										actions,
										failedRows:
											readRecord(result.details).batchSteps === undefined ? undefined : rows.length,
									}),
								);
							}
							const hover = await executeRegisteredTool(harness.tool, harness.ctx, {
								args: [...prefix, "hover", "#target"],
							});
							assert.equal(hover.isError, true);
							assert.match(
								readString(readRecord(hover.content[0]).text),
								/is covered by.*at its click point/,
							);
							assert.equal(readRecord(hover.details).nextActions, undefined);
							const state = await executeRegisteredTool(harness.tool, harness.ctx, {
								args: [...prefix, "eval", "--stdin"],
								stdin:
									"({targetClicks,coverClicks,coverExists:!!document.querySelector('#cover')})",
							});
							assert.equal(state.isError, false, JSON.stringify(state));
							assert.deepEqual(readRecord(readRecord(state.details).data).result, {
								targetClicks: 0,
								coverClicks: 0,
								coverExists: true,
							});
							t.diagnostic(
								JSON.stringify({
									mode,
									unchangedPage: readRecord(state.details).data,
									hoverRecovery: readRecord(hover.details).nextActions ?? null,
								}),
							);
						} finally {
							const closed = await executeRegisteredTool(harness.tool, harness.ctx, {
								args: [...prefix, "close"],
							});
							assert.equal(closed.isError, false, JSON.stringify(closed));
							await runExtensionEvent(harness.handlers, "session_shutdown", {}, harness.ctx);
						}
					},
				);
			} finally {
				await new Promise<void>((resolve, reject) => {
					server.close((error) => {
						if (error) {
							reject(error);
						} else {
							resolve();
						}
					});
				});
				await rm(root, { recursive: true, force: true });
				await rm(socketDir, { recursive: true, force: true });
			}
		},
	);
}
