import assert from "node:assert/strict";
import { getMessageText } from "../extensions/agent-browser/lib/prompt-policy.js";
import { readFile, writeFile } from "node:fs/promises";
import nodeTest from "node:test";
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

// Native Windows caller sessions share an identity across storage roots; unrelated file workers do not.
const SHARED_SESSION = `capture-replay-${process.pid}`;

for (const after of [
	"none",
	"failed-row",
	"pending",
	"invalidation",
	"capture",
	"failed-snapshot",
] as const) {
	nodeTest(
		`confirmed batch snapshots replace refs in row order (${after})`,
		{ concurrency: false },
		async (t) => {
			await withConfirmations(async ({ state, log, branch, harness }) => {
				const prefix = ["--session", SHARED_SESSION];
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
				const replay = SessionPageState.fromBranch(convertBrowserEntries(branch)).get(
					SHARED_SESSION,
				);
				const invalidated = after === "invalidation" || after === "failed-snapshot";
				const current = after === "capture" ? "e3" : "e2";
				if (invalidated) {
					await t.test("retires snapshot with the observed reason", () => {
						assert.equal(replay.refSnapshot, undefined);
						assert.equal(
							replay.refSnapshotInvalidation?.reason,
							after === "failed-snapshot" ? "no-active-page" : "page-transition",
						);
					});
				} else {
					await t.test("retains the last completed capture", () => {
						assert.deepEqual(replay.refSnapshot?.refIds, [current]);
					});
				}
				await writeFile(log, "");
				const getter = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, "get", "text", `@${current}`],
				});
				const fresh = after === "none" || after === "capture";
				assert.equal(getter.isError, !fresh, getMessageText(getter.content));
				assert.equal(
					(await readInvocationLog(log)).some(
						(call) => extractUpstreamCommandTokens(call.args).join(" ") === `get text @${current}`,
					),
					fresh,
				);
				if (!invalidated && !fresh) {
					await t.test("requires confirmation after later rows", () => {
						assert.equal(
							getter.details?.failureCategory,
							"confirmation-required",
							"later rows retire one-use freshness, not the completed snapshot's membership",
						);
					});
				}
			});
		},
	);
}

nodeTest(
	"pending snapshots preserve explicit JSON and executable identity-qualified actions",
	{ concurrency: false },
	async () => {
		await withConfirmations(async ({ harness }) => {
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--namespace", "team", "--session", SHARED_SESSION, "--json", "snapshot", "-i"],
			});
			assert.equal(result.details?.failureCategory, "confirmation-required");
			assert.equal(
				readRecord(readRecord(JSON.parse(getMessageText(result.content))).data)
					.confirmation_required,
				true,
			);
			assert.doesNotMatch(getMessageText(result.content), /no interactive elements|Refs: 0/);
			assert.deepEqual(
				readArray(result.details.nextActions)
					.map(readRecord)
					.map((row) => readRecord(row.params).args),
				[
					["--namespace", "team", "--session", SHARED_SESSION, "confirm", "snapshot-id"],
					["--namespace", "team", "--session", SHARED_SESSION, "deny", "snapshot-id"],
				],
			);
		});
	},
);

for (const mode of [
	"direct",
	"batch",
	"intervening",
	"absent",
	"drift",
	"deny",
	"nested",
] as const) {
	nodeTest(
		`confirmed capture is one-use across resume (${mode})`,
		{ concurrency: false },
		async (t) => {
			const unresolved = mode === "deny" || mode === "nested";
			await withConfirmations(async ({ root, state, log, harness: initialHarness }) => {
				let harness = initialHarness;
				const prefix = ["--session", SHARED_SESSION];
				const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, "--confirm-actions", "snapshot", "open", "https://current.test/"],
				});
				assert.equal(opened.isError, false, getMessageText(opened.content));
				const pending = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, "snapshot", "-i"],
				});
				assert.equal(
					pending.details?.failureCategory,
					"confirmation-required",
					getMessageText(pending.content),
				);
				if (mode === "nested") {
					const native = readRecord(JSON.parse(await readFile(state, "utf8")));
					readRecord(native.pending).nested = true;
					await writeFile(state, JSON.stringify(native));
				}
				const confirmed = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, mode === "deny" ? "deny" : "confirm", "snapshot-id"],
				});
				assert.equal(confirmed.isError, mode === "nested", getMessageText(confirmed.content));
				const branch = structuredClone(harness.ctx.sessionManager.getBranch());
				harness = createExtensionHarness({ cwd: root, branch });
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
					native.url = "https://external.test/";
					await writeFile(state, JSON.stringify(native));
				}
				await writeFile(log, "");
				const getterArgs = ["get", "text", mode === "absent" ? "@e99" : "@e1"];
				const getter = await executeRegisteredTool(
					harness.tool,
					harness.ctx,
					mode === "batch"
						? { args: [...prefix, "batch", "--bail"], stdin: JSON.stringify([getterArgs]) }
						: { args: [...prefix, ...getterArgs] },
				);
				const fresh = mode === "direct" || mode === "batch";
				await t.test("native result reflects capture freshness", () => {
					assert.equal(getter.isError, !fresh, getMessageText(getter.content));
				});
				const commands = (await readInvocationLog(log)).map((call) =>
					extractUpstreamCommandTokens(call.args),
				);
				assert.equal(
					commands.some((tokens) => tokens[0] === "snapshot"),
					mode === "intervening",
					"only an eligible next call can reuse the approved capture",
				);
				if (!fresh) {
					await t.test("unresolved capture leaves native ref ownership intact", async (unfresh) => {
						assert.equal(
							commands.some((tokens) => tokens.join(" ") === getterArgs.join(" ")),
							unresolved,
							"without a completed capture, native still owns ref resolution; unconfirmed results must not grant freshness",
						);
						if (unresolved) {
							await unfresh.test("does not grant freshness without confirmation", () => {
								assert.equal(
									readRecord(confirmed.details?.readConfirmation).refSnapshotFresh,
									undefined,
								);
							});
						}
					});
					return;
				}
				const consumedBranch = structuredClone(harness.ctx.sessionManager.getBranch());
				harness = createExtensionHarness({ cwd: root, branch: consumedBranch });
				await runExtensionEvent(
					harness.handlers,
					"session_start",
					{ reason: "resume" },
					harness.ctx,
				);
				await writeFile(log, "");
				const second = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, ...getterArgs],
				});
				assert.equal(
					second.details?.failureCategory,
					"confirmation-required",
					getMessageText(second.content),
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
				assert.equal(helper.isError, false, getMessageText(helper.content));
				const third = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, "get", "text", "@e2"],
				});
				assert.equal(third.isError, false, getMessageText(third.content));
			});
		},
	);
}
