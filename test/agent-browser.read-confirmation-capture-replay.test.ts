import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { extractUpstreamCommandTokens } from "../extensions/agent-browser/lib/argv-descriptor.js";
import { convertBrowserEntries } from "../extensions/agent-browser/lib/browser-session-conversion.js";
import { SessionPageState } from "../extensions/agent-browser/lib/session-page-state.js";
import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
} from "./helpers/agent-browser-harness.js";
import { readRecord, readArray } from "./helpers/assertions.js";
import { withConfirmations } from "./helpers/read-confirmation-fixture.js";

for (const after of [
	"none",
	"failed-row",
	"pending",
	"invalidation",
	"capture",
	"failed-snapshot",
] as const) {
	test(
		`confirmed batch snapshots replace refs in row order (${after})`,
		{ concurrency: false },
		async () => {
			await withConfirmations(async ({ state, log, branch, harness }) => {
				const prefix = ["--session", "shared"];
				await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, "--confirm-actions", "snapshot", "open", "https://current.test/"],
				});
				await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, "snapshot", "-i"],
				});
				const first = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, "confirm", "snapshot-id"],
				});
				assert.equal(first.isError, false);
				await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, "snapshot", "-i"],
				});
				if (after === "failed-snapshot") {
					const native = readRecord(JSON.parse(await readFile(state, "utf8")));
					readRecord(native.pending).failure = "no-active-page";
					await writeFile(state, JSON.stringify(native));
				}
				const laterRows: Readonly<Record<string, string[][]>> = {
					"failed-row": [["confirm", "missing"]],
					pending: [["snapshot", "-i"]],
					invalidation: [["webmcp", "invoke", "pending"]],
					capture: [
						["snapshot", "-i"],
						["confirm", "snapshot-id"],
					],
				};
				const later = laterRows[after] ?? [];
				await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, "batch"],
					stdin: JSON.stringify([["confirm", "snapshot-id"], ...later]),
				});
				const replay = SessionPageState.fromBranch(convertBrowserEntries(branch)).get("shared");
				const invalidated = after === "invalidation" || after === "failed-snapshot";
				const current = after === "capture" ? "e3" : "e2";
				if (invalidated) {
					// This enumerated fixture branch (invalidated) has variant-specific assertions; common assertions cover every case.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(replay.refSnapshot, undefined);
					// This enumerated fixture branch (invalidated) has variant-specific assertions; common assertions cover every case.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(
						replay.refSnapshotInvalidation?.reason,
						after === "failed-snapshot" ? "no-active-page" : "page-transition",
					);
				} else {
					// This enumerated fixture branch (invalidated) has variant-specific assertions; common assertions cover every case.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.deepEqual(replay.refSnapshot?.refIds, [current]);
				}
				await writeFile(log, "");
				const getter = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, "get", "text", `@${current}`],
				});
				const fresh = after === "none" || after === "capture";
				assert.equal(getter.isError, !fresh, getter.content[0].text);
				assert.equal(
					(await readInvocationLog(log)).some(
						(call) => extractUpstreamCommandTokens(call.args).join(" ") === `get text @${current}`,
					),
					fresh,
				);
				if (!invalidated && !fresh) {
					// This enumerated fixture branch (!invalidated && !fresh) has variant-specific assertions; common assertions cover every case.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(
						getter.details?.failureCategory,
						"confirmation-required",
						"later rows retire one-use freshness, not the completed snapshot's membership",
					);
				}
			});
		},
	);
}

test(
	"pending snapshots preserve explicit JSON and executable identity-qualified actions",
	{ concurrency: false },
	async () => {
		await withConfirmations(async ({ harness }) => {
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--namespace", "team", "--session", "shared", "--json", "snapshot", "-i"],
			});
			assert.equal(result.details?.failureCategory, "confirmation-required");
			assert.equal(
				readRecord(readRecord(JSON.parse(result.content[0].text ?? "")).data).confirmation_required,
				true,
			);
			assert.doesNotMatch(result.content[0].text ?? "", /no interactive elements|Refs: 0/);
			assert.deepEqual(
				readArray(result.details.nextActions)
					.map(readRecord)
					.map((row) => readRecord(row.params).args),
				[
					["--namespace", "team", "--session", "shared", "confirm", "snapshot-id"],
					["--namespace", "team", "--session", "shared", "deny", "snapshot-id"],
				],
			);
		});
	},
);

for (const mode of [
	"direct",
	"batch",
	"code",
	"intervening",
	"absent",
	"drift",
	"deny",
	"nested",
] as const) {
	test(`confirmed capture is one-use across resume (${mode})`, { concurrency: false }, async () => {
		const unresolved = mode === "deny" || mode === "nested";
		await withConfirmations(async ({ root, state, log, harness: initialHarness }) => {
			let harness = initialHarness;
			const prefix = ["--session", "shared"];
			await executeRegisteredTool(harness.tool, harness.ctx, {
				args: [...prefix, "--confirm-actions", "snapshot", "open", "https://current.test/"],
			});
			await executeRegisteredTool(harness.tool, harness.ctx, {
				args: [...prefix, "snapshot", "-i"],
			});
			if (mode === "nested") {
				const native = readRecord(JSON.parse(await readFile(state, "utf8")));
				readRecord(native.pending).nested = true;
				await writeFile(state, JSON.stringify(native));
			}
			const confirmed = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: [...prefix, mode === "deny" ? "deny" : "confirm", "snapshot-id"],
			});
			assert.equal(confirmed.isError, mode === "nested", confirmed.content[0].text);
			const branch = structuredClone(harness.ctx.sessionManager.getBranch());
			harness = createExtensionHarness({ cwd: root, branch });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			if (mode === "intervening") {
				await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, "get", "title"],
				});
			}
			if (mode === "drift") {
				const native = readRecord(JSON.parse(await readFile(state, "utf8")));
				native.url = "https://external.test/";
				await writeFile(state, JSON.stringify(native));
			}
			await writeFile(log, "");
			const getterArgs = ["get", "text", mode === "absent" ? "@e99" : "@e1"];
			const codeTool = harness.getTool("agent_browser_code");
			assert.ok(codeTool);
			const code = codeTool;
			const getterRequests: Readonly<Record<string, unknown>> = {
				code: {
					session: "shared",
					code: `emit((await browser({args:${JSON.stringify(getterArgs)}})).success);`,
				},
				batch: { args: [...prefix, "batch", "--bail"], stdin: JSON.stringify([getterArgs]) },
			};
			const getter = await executeRegisteredTool(
				mode === "code" ? code : harness.tool,
				harness.ctx,
				getterRequests[mode] ?? { args: [...prefix, ...getterArgs] },
			);
			const fresh = ["direct", "batch", "code"].includes(mode);
			if (mode === "code") {
				// This enumerated fixture branch (mode === "code") has variant-specific assertions; common assertions cover every case.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(getter.details?.data, true, getter.content[0].text);
			} else {
				// This enumerated fixture branch (mode === "code") has variant-specific assertions; common assertions cover every case.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(getter.isError, !fresh, getter.content[0].text);
			}
			const commands = (await readInvocationLog(log)).map((call) =>
				extractUpstreamCommandTokens(call.args),
			);
			assert.equal(
				commands.some((tokens) => tokens[0] === "snapshot"),
				mode === "intervening",
				"only an eligible next call can reuse the approved capture",
			);
			if (!fresh) {
				// This enumerated fixture branch (!fresh) has variant-specific assertions; common assertions cover every case.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(
					commands.some((tokens) => tokens.join(" ") === getterArgs.join(" ")),
					unresolved,
					"without a completed capture, native still owns ref resolution; unconfirmed results must not grant freshness",
				);
				if (unresolved) {
					// This enumerated fixture branch (unresolved) has variant-specific assertions; common assertions cover every case.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(readRecord(confirmed.details?.readConfirmation).refSnapshotFresh, undefined);
				}
				return;
			}
			const consumedBranch = structuredClone(harness.ctx.sessionManager.getBranch());
			harness = createExtensionHarness({ cwd: root, branch: consumedBranch });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			await writeFile(log, "");
			const second = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: [...prefix, ...getterArgs],
			});
			assert.equal(
				second.details?.failureCategory,
				"confirmation-required",
				second.content[0].text,
			);
			assert.equal(second.details.agentBrowserStarted, false);
			assert.equal(
				(await readInvocationLog(log)).some(
					(call) => extractUpstreamCommandTokens(call.args).join(" ") === getterArgs.join(" "),
				),
				false,
			);
			const approve = readArray(second.details.nextActions)
				.map(readRecord)
				.find((action) => action.id === "approve-confirmation");
			assert.ok(approve);
			const helper = await executeRegisteredTool(harness.tool, harness.ctx, approve.params);
			assert.equal(helper.isError, false, helper.content[0].text);
			const third = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: [...prefix, "get", "text", "@e2"],
			});
			assert.equal(third.isError, false, third.content[0].text);
		});
	});
}
