import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { extractUpstreamCommandTokens } from "../extensions/agent-browser/lib/argv-descriptor.js";
import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
} from "./helpers/agent-browser-harness.js";
import { readRecord, readArray, readString } from "./helpers/assertions.js";
import { withConfirmations } from "./helpers/read-confirmation-fixture.js";

// Native Windows caller sessions share an identity across storage roots; unrelated file workers do not.
const SHARED_SESSION = `capture-actions-${process.pid}`;

for (const action of [
	{ action: "click", locator: "role", role: "button", name: "Save", expected: ["click", "@e5"] },
	{ action: "check", locator: "role", role: "checkbox", name: "Terms", expected: ["check", "@e6"] },
	{
		action: "fill",
		locator: "role",
		role: "textbox",
		name: "Name",
		text: "-kept verbatim",
		expected: ["fill", "@e7", "-kept verbatim"],
	},
	{
		action: "select",
		locator: "role",
		role: "combobox",
		name: "Flavor",
		values: ["-1", "chocolate"],
		expected: ["select", "@e8", "-1", "chocolate"],
	},
	{
		action: "select",
		locator: "label",
		value: "Flavor",
		values: ["vanilla"],
		expected: ["select", "@e8", "vanilla"],
	},
]) {
	test(
		`semantic ${action.action}/${action.locator} uses a confirmed capture once across resume`,
		{ concurrency: false },
		async () => {
			await withConfirmations(async ({ root, state, log, harness: initialHarness }) => {
				let harness = initialHarness;
				await writeFile(
					state,
					JSON.stringify({
						semanticSnapshot: {
							origin: "https://current.test/",
							refs: {
								e5: { role: "button", name: "Save" },
								e6: { role: "checkbox", name: "Terms" },
								e7: { role: "textbox", name: "Name" },
								e8: { role: "combobox", name: "Flavor" },
							},
							snapshot:
								'- button "Save" [ref=e5]\n- checkbox "Terms" [ref=e6]\n- textbox "Name" [ref=e7]\n- combobox "Flavor" [ref=e8]',
						},
					}),
				);
				const prefix = ["--session", SHARED_SESSION];
				assert.equal(
					(
						await executeRegisteredTool(harness.tool, harness.ctx, {
							args: [...prefix, "--confirm-actions", "snapshot", "open", "https://current.test/"],
						})
					).isError,
					false,
				);
				const { expected, ...params } = action;
				const request = { ...params, session: SHARED_SESSION };
				const initialActionTool = harness.getTool("agent_browser_action");
				assert.ok(initialActionTool);
				const pending = await executeRegisteredTool(initialActionTool, harness.ctx, request);
				assert.equal(pending.details?.failureCategory, "confirmation-required");
				assert.match(pending.content[0].text ?? "", /requested command was not dispatched/);
				const approval = readArray(pending.details.nextActions)
					.map(readRecord)
					.find((row) => row.id === "approve-confirmation");
				assert.ok(approval);
				assert.equal(
					(await executeRegisteredTool(harness.tool, harness.ctx, approval.params)).isError,
					false,
				);
				harness = createExtensionHarness({
					cwd: root,
					branch: structuredClone(harness.ctx.sessionManager.getBranch()),
				});
				await runExtensionEvent(
					harness.handlers,
					"session_start",
					{ reason: "resume" },
					harness.ctx,
				);
				await writeFile(log, "");
				const resumedActionTool = harness.getTool("agent_browser_action");
				assert.ok(resumedActionTool);
				const result = await executeRegisteredTool(resumedActionTool, harness.ctx, request);
				assert.equal(result.isError, false, result.content[0].text);
				assert.deepEqual(readRecord(JSON.parse(await readFile(state, "utf8"))).actions, [expected]);
				assert.equal(
					(await readInvocationLog(log)).some(
						(call) => extractUpstreamCommandTokens(call.args)[0] === "snapshot",
					),
					false,
					"reuse must not acquire another gated snapshot",
				);
				const nextActionTool = harness.getTool("agent_browser_action");
				assert.ok(nextActionTool);
				const second = await executeRegisteredTool(nextActionTool, harness.ctx, request);
				assert.equal(
					second.details?.failureCategory,
					"confirmation-required",
					"the next operation must acquire its own sample",
				);
				assert.deepEqual(readRecord(JSON.parse(await readFile(state, "utf8"))).actions, [expected]);
			});
		},
	);
}

for (const owned of [false, true]) {
	for (const route of ["path", "hash"]) {
		for (const semantic of [false, true]) {
			for (const drift of [false, true]) {
				test(
					`warm confirmed capture checks the live page without resume (owned=${owned}, route=${route}, semantic=${semantic}, drift=${drift})`,
					{ concurrency: false },
					async () => {
						const url =
							route === "hash"
								? "https://current.test/#/contract"
								: "https://current.test/contract";
						const movedUrl =
							route === "hash" ? "https://current.test/#/other" : "https://current.test/other";
						await withConfirmations(async ({ state, log, harness }) => {
							await writeFile(
								state,
								JSON.stringify({
									semanticSnapshot: {
										origin: url,
										refs: { e8: { role: "combobox", name: "Flavor" } },
										snapshot: '- combobox "Flavor" [ref=e8]',
									},
								}),
							);
							const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
								args: [
									...(owned ? [] : ["--session", SHARED_SESSION]),
									"--confirm-actions",
									"snapshot",
									"open",
									url,
								],
								...(owned ? { sessionMode: "fresh" as const } : {}),
							});
							assert.equal(opened.isError, false, opened.content[0].text);
							if (owned) {
								// This enumerated fixture branch (owned) has variant-specific assertions; common assertions cover every case.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(
									readRecord(opened.details?.managedSessionOutcome).status,
									"created",
									"fresh launch establishes real wrapper ownership through the ordinary daemon/policy path",
								);
							} else {
								// This enumerated fixture branch (owned) has variant-specific assertions; common assertions cover every case.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(opened.details?.usedImplicitSession, false);
							}
							const session = readString(opened.details?.sessionName);
							const prefix = ["--session", session];
							await executeRegisteredTool(harness.tool, harness.ctx, {
								args: [...prefix, "snapshot", "-i"],
							});
							assert.equal(
								(
									await executeRegisteredTool(harness.tool, harness.ctx, {
										args: [...prefix, "confirm", "snapshot-id"],
									})
								).isError,
								false,
							);
							if (drift) {
								const native = readRecord(JSON.parse(await readFile(state, "utf8")));
								native.url = movedUrl;
								readRecord(readRecord(readRecord(native.semanticSnapshot).refs).e8).name =
									"Renamed";
								await writeFile(state, JSON.stringify(native));
							}
							await writeFile(log, "");
							const actionTool = harness.getTool("agent_browser_action");
							assert.ok(actionTool);
							const result = await executeRegisteredTool(
								semantic ? actionTool : harness.tool,
								harness.ctx,
								semantic
									? {
											action: "select",
											locator: "role",
											role: "combobox",
											name: "Flavor",
											value: "chocolate",
											session,
										}
									: { args: [...prefix, "select", "@e8", "chocolate"] },
							);
							assert.equal(result.isError, drift, result.content[0].text);
							if (drift) {
								// This enumerated fixture branch (drift) has variant-specific assertions; common assertions cover every case.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(result.details?.failureCategory, "stale-ref");
								// This enumerated fixture branch (drift) has variant-specific assertions; common assertions cover every case.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.ok(
									readString(result.content[0].text).includes(
										`current session target is ${movedUrl}`,
									),
								);
							}
							const calls = (await readInvocationLog(log)).map((call) =>
								extractUpstreamCommandTokens(call.args),
							);
							assert.equal(
								calls.some((tokens) => tokens.join(" ") === "get url"),
								true,
								"the live URL must be observed on this warm call",
							);
							assert.equal(
								calls.some((tokens) => tokens[0] === "snapshot"),
								false,
								"one-use freshness must not acquire another gated capture",
							);
							assert.deepEqual(
								readRecord(JSON.parse(await readFile(state, "utf8"))).actions ?? [],
								drift ? [] : [["select", "@e8", "chocolate"]],
							);
						});
					},
				);
			}
		}
	}
}

for (const mode of ["absent", "ambiguous", "drift", "intervening"] as const) {
	test(
		`confirmed semantic select retains its guards (${mode})`,
		{ concurrency: false },
		async () => {
			await withConfirmations(async ({ root, state, log, harness: initialHarness }) => {
				let harness = initialHarness;
				const refs =
					mode === "absent"
						? { e5: { role: "button", name: "Save" } }
						: {
								e8: { role: "combobox", name: "Flavor" },
								...(mode === "ambiguous" ? { e9: { role: "combobox", name: "Flavor" } } : {}),
							};
				await writeFile(
					state,
					JSON.stringify({
						semanticSnapshot: { origin: "https://current.test/", refs, snapshot: "" },
					}),
				);
				const prefix = ["--session", SHARED_SESSION];
				await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, "--confirm-actions", "snapshot", "open", "https://current.test/"],
				});
				await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, "snapshot", "-i"],
				});
				assert.equal(
					(
						await executeRegisteredTool(harness.tool, harness.ctx, {
							args: [...prefix, "confirm", "snapshot-id"],
						})
					).isError,
					false,
				);
				harness = createExtensionHarness({
					cwd: root,
					branch: structuredClone(harness.ctx.sessionManager.getBranch()),
				});
				await runExtensionEvent(
					harness.handlers,
					"session_start",
					{ reason: "resume" },
					harness.ctx,
				);
				if (mode === "intervening") {
					await executeRegisteredTool(harness.tool, harness.ctx, {
						args: [...prefix, "get", "title"],
					});
				}
				if (mode === "drift") {
					const native = readRecord(JSON.parse(await readFile(state, "utf8")));
					await writeFile(state, JSON.stringify({ ...native, url: "https://external.test/" }));
				}
				await writeFile(log, "");
				const actionTool = harness.getTool("agent_browser_action");
				assert.ok(actionTool);
				const result = await executeRegisteredTool(actionTool, harness.ctx, {
					action: "select",
					locator: "role",
					role: "combobox",
					name: "Flavor",
					value: "chocolate",
					session: SHARED_SESSION,
				});
				assert.equal(result.isError, true);
				if (mode === "absent" || mode === "ambiguous") {
					// This enumerated fixture branch (mode === "absent" || mode === "ambiguous") has variant-specific assertions; common assertions cover every case.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(readString(result.details?.validationError), /exactly one current visible/);
				}
				if (mode === "drift") {
					// This enumerated fixture branch (mode === "drift") has variant-specific assertions; common assertions cover every case.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(result.details?.failureCategory, "tab-drift");
				}
				if (mode === "intervening") {
					// This enumerated fixture branch (mode === "intervening") has variant-specific assertions; common assertions cover every case.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(result.details?.failureCategory, "confirmation-required");
				}
				assert.equal(
					(await readInvocationLog(log)).some((call) =>
						["select", "find"].includes(extractUpstreamCommandTokens(call.args)[0]),
					),
					false,
				);
			});
		},
	);
}
