import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { extractUpstreamCommandTokens } from "../extensions/agent-browser/lib/argv-descriptor.js";
import { convertBrowserEntries } from "../extensions/agent-browser/lib/browser-session-conversion.js";
import { SessionPageState } from "../extensions/agent-browser/lib/session-page-state.js";
import {
	getNativePendingControl,
	getNativeTabContinuationGuidance,
} from "../extensions/agent-browser/lib/native-confirmation.js";
import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
} from "./helpers/agent-browser-harness.js";
import { readRecord, readArray, readString } from "./helpers/assertions.js";
import { withConfirmations } from "./helpers/read-confirmation-fixture.js";

// Native Windows caller sessions share an identity across storage roots; unrelated file workers do not.
const SHARED_SESSION = `read-route-${process.pid}`;

for (const shared of [false, true]) {
	for (const command of ["confirm", "deny"]) {
		test(
			`URL-read ${command} stays browserless and targets the real native session (shared=${shared})`,
			{ concurrency: false },
			async () => {
				await withConfirmations(async ({ root, log, state, branch, harness: initialHarness }) => {
					let harness = initialHarness;
					const prefix = shared ? ["--namespace", "team", "--session", SHARED_SESSION] : [];
					const read = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: [...prefix, "--confirm-actions", "read", "read", "public.test/docs"],
					});
					assert.equal(read.details?.failureCategory, "confirmation-required");
					assert.equal(read.details.managedSessionOutcome, undefined);
					const action = readArray(read.details.nextActions)
						.map(readRecord)
						.find(
							(candidate) =>
								candidate.id ===
								(command === "confirm" ? "approve-confirmation" : "deny-confirmation"),
						);
					assert.deepEqual(readRecord(action?.params).args, [
						"--namespace",
						shared ? "team" : "",
						"--session",
						shared ? SHARED_SESSION : "default",
						command,
						"read-id",
					]);
					const pendingState = SessionPageState.fromBranch(convertBrowserEntries(branch));
					assert.ok(
						pendingState.findReadConfirmation(["confirm", "read-id"]),
						JSON.stringify(branch),
					);
					assert.equal(
						pendingState.findReadConfirmation(
							["--session", "piab-script-isolated", command, "read-id"],
							"",
						),
						undefined,
						"an isolated script's explicit identity cannot select a shared read confirmation",
					);
					assert.equal(
						pendingState.findReadConfirmation(
							["--namespace", "other", command, "read-id"],
							"other",
						),
						undefined,
					);
					await runExtensionEvent(
						harness.handlers,
						"session_shutdown",
						{ reason: "reload" },
						harness.ctx,
					);
					harness = createExtensionHarness({ cwd: root, branch });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "resume" },
						harness.ctx,
					);
					await writeFile(log, "");
					const beforeConfirm = structuredClone(harness.ctx.sessionManager.getBranch());
					const confirmed = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: [command, "read-id"],
					});
					assert.equal(confirmed.isError, false, confirmed.content[0].text);
					assert.equal(confirmed.details?.sessionName, shared ? SHARED_SESSION : "default");
					assert.equal(confirmed.details.managedSessionOutcome, undefined);
					assert.deepEqual(
						(await readInvocationLog(log)).map((call) => extractUpstreamCommandTokens(call.args)),
						[[command, "read-id"]],
					);
					assert.equal(readRecord(JSON.parse(await readFile(state, "utf8"))).browserTouches, 0);
					assert.equal(
						SessionPageState.fromBranch(convertBrowserEntries(branch)).findReadConfirmation([
							"confirm",
							"read-id",
						]),
						undefined,
					);
					assert.equal(
						SessionPageState.fromBranch(beforeConfirm).findReadConfirmation(["confirm", "read-id"])
							?.id,
						"read-id",
					);
					await runExtensionEvent(
						harness.handlers,
						"session_shutdown",
						{ reason: "quit" },
						harness.ctx,
					);
				});
			},
		);
	}
}

for (const command of ["confirm", "deny"]) {
	test(
		`proven HTTP ${command} preserves an unknown DOM target without page probes`,
		{ concurrency: false },
		async () => {
			await withConfirmations(async ({ log, harness }) => {
				const prefix = ["--namespace", "team", "--session", SHARED_SESSION];
				await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, "click", "#guarded"],
				});
				const pending = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, "webmcp", "invoke", "wait_for_navigation", "--detach"],
				});
				assert.equal(pending.details?.sessionTabTargetUnknown, true);
				await writeFile(log, "");
				const blocked = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, command, "unproven-id"],
				});
				assert.equal(blocked.isError, true);
				assert.deepEqual(await readInvocationLog(log), []);
				await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, "read", "public.test/legacy"],
				});
				await writeFile(log, "");
				const legacy = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, command, "read-id"],
				});
				assert.equal(legacy.isError, true);
				assert.deepEqual(await readInvocationLog(log), []);
				const read = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, "read", "public.test/docs"],
				});
				assert.equal(read.details?.failureCategory, "confirmation-required");
				await writeFile(log, "");
				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, command, "read-id"],
				});
				assert.equal(result.isError, false, result.content[0].text);
				assert.deepEqual(
					(await readInvocationLog(log)).map((call) => call.args),
					[["--json", ...prefix, command, "read-id"]],
				);
				assert.equal(result.details?.sessionTabTargetUnknown, true);
				assert.equal(result.details.sessionTabTarget, undefined);
				assert.equal(result.details.managedSessionOutcome, undefined);
				await writeFile(log, "");
				const stillUnknown = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, "click", "#guarded"],
				});
				assert.equal(stillUnknown.isError, true);
				assert.match(stillUnknown.content[0].text ?? "", /active page became unverified/);
				assert.deepEqual(await readInvocationLog(log), []);
			});
		},
	);
}

test(
	"legacy read confirmation retains native-default routing without the browserless exemption",
	{ concurrency: false },
	async () => {
		await withConfirmations(async ({ log, harness }) => {
			const read = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["read", "public.test/legacy"],
			});
			assert.equal(readRecord(read.details?.readConfirmation).sessionName, "default");
			await writeFile(log, "");
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["confirm", "read-id"],
			});
			assert.equal(result.isError, false, result.content[0].text);
			assert.equal(result.details?.sessionName, "default");
			assert.equal(result.details.managedSessionOutcome, undefined);
			assert.deepEqual(
				(await readInvocationLog(log)).map((call) => extractUpstreamCommandTokens(call.args)),
				[
					["get", "url"],
					["confirm", "read-id"],
				],
			);
		});
	},
);

for (const legacy of [true, false]) {
	for (const batch of [false, true]) {
		test(
			`failed confirmed HTTP reads fail truthfully (legacy=${legacy}, batch=${batch})`,
			{ concurrency: false },
			async () => {
				await withConfirmations(async ({ root, log, harness }) => {
					const prefix = ["--namespace", "team", "--session", SHARED_SESSION];
					const read = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: [
							...prefix,
							"read",
							legacy ? "public.test/legacy-failure" : "public.test/failure",
						],
					});
					assert.equal(read.details?.failureCategory, "confirmation-required");
					await writeFile(log, "");
					const outputPath = join(root, "failed-read.json");
					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: [...prefix, "--json", ...(batch ? ["batch"] : ["confirm", "read-id"])],
						...(batch ? { stdin: JSON.stringify([["confirm", "read-id"]]) } : {}),
						outputPath,
					});
					assert.equal(result.isError, true);
					assert.equal(result.details?.resultCategory, "failure");
					assert.equal(readRecord(JSON.parse(result.content[0].text ?? "")).success, false);
					assert.match(result.content[0].text ?? "", /HTTP read failed: test response 500/);
					assert.equal(readRecord(result.details.readConfirmation).state, "cleared");
					if (batch) {
						// This enumerated fixture branch (batch) has variant-specific assertions; common assertions cover every case.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readArray(result.details.batchSteps).map(readRecord)[0].success, false);
					}
					assert.deepEqual(
						(await readInvocationLog(log)).map((call) => extractUpstreamCommandTokens(call.args)),
						[
							...(legacy || batch ? [["get", "url"]] : []),
							batch ? ["batch"] : ["confirm", "read-id"],
						],
					);
					assert.equal(result.details.outputFile, undefined);
					await assert.rejects(readFile(outputPath), { code: "ENOENT" });
				});
			},
		);
	}
}

test(
	"a stale read ID cannot consume a newer native DOM confirmation or acquire browser ownership",
	{ concurrency: false },
	async () => {
		await withConfirmations(async ({ log, state, harness }) => {
			const read = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", SHARED_SESSION, "read", "public.test/docs"],
			});
			assert.equal(read.details?.failureCategory, "confirmation-required");
			const native = readRecord(JSON.parse(await readFile(state, "utf8")));
			await writeFile(
				state,
				JSON.stringify({
					...native,
					pending: {
						id: "new-dom-id",
						action: "click",
						sessionName: SHARED_SESSION,
						namespace: "",
					},
				}),
			);
			await writeFile(log, "");
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["confirm", "read-id"],
			});
			assert.equal(result.isError, true);
			assert.match(result.content[0].text ?? "", /mismatch/);
			assert.equal(
				result.details?.sessionName,
				SHARED_SESSION,
				"the stale ID must reach its original native session, not a newly generated one",
			);
			assert.equal(result.details.managedSessionOutcome, undefined);
			assert.deepEqual(
				(await readInvocationLog(log)).map((call) => extractUpstreamCommandTokens(call.args)),
				[["confirm", "read-id"]],
			);
			const after = readRecord(JSON.parse(await readFile(state, "utf8")));
			assert.equal(readRecord(after.pending).id, "new-dom-id");
			assert.equal(after.domConfirmed, false);
			assert.equal(after.browserTouches, 0);
		});
	},
);

test(
	"native DOM decisions suppress overwriting helpers but page-shaped and unrelated decisions keep page checks",
	{ concurrency: false },
	async () => {
		await withConfirmations(async ({ log, branch, harness }) => {
			const body = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", SHARED_SESSION, "read", "public.test/body"],
			});
			assert.equal(body.details?.readConfirmation, undefined);
			const pageJson = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: [
					"--session",
					SHARED_SESSION,
					"eval",
					"({ confirmed: true, action: 'read', result: { success: false, error: 'HTTP read failed: test response 500' } })",
				],
			});
			assert.equal(pageJson.isError, false, pageJson.content[0].text);
			assert.equal(pageJson.details?.readConfirmation, undefined);
			await writeFile(log, "");
			await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", SHARED_SESSION, "confirm", "read-id"],
			});
			assert.deepEqual(
				(await readInvocationLog(log)).map((call) => extractUpstreamCommandTokens(call.args)),
				[
					["get", "url"],
					["confirm", "read-id"],
				],
			);
			const bare = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", SHARED_SESSION, "read"],
			});
			assert.equal(
				readRecord(bare.details?.readConfirmation).source,
				"native-guarded-action",
				"a native current-page read is browser-backed, not explicit-URL provenance",
			);
			assert.equal(readRecord(bare.details?.readConfirmation).capabilities, undefined);
			const legacy = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", SHARED_SESSION, "read", "public.test/legacy"],
			});
			assert.equal(
				readRecord(legacy.details?.readConfirmation).capabilities,
				undefined,
				"legacy routing metadata does not prove native ID checking",
			);
			await writeFile(log, "");
			await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", SHARED_SESSION, "confirm", "read-id"],
			});
			assert.deepEqual(
				(await readInvocationLog(log)).map((call) => extractUpstreamCommandTokens(call.args)),
				[
					["get", "url"],
					["confirm", "read-id"],
				],
			);
			await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", SHARED_SESSION, "read", "public.test/docs"],
			});
			const blocked = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", SHARED_SESSION, "click", "#guarded"],
			});
			assert.equal(blocked.isError, true);
			assert.equal(blocked.details?.failureCategory, "confirmation-required");
			assert.equal(readRecord(blocked.details.readConfirmation).state, "pending");
			const actions = readArray(blocked.details.nextActions).map(readRecord);
			assert.deepEqual(
				actions.map((action) => readRecord(action.params).args),
				[
					["--namespace", "", "--session", SHARED_SESSION, "confirm", "dom-id"],
					["--namespace", "", "--session", SHARED_SESSION, "deny", "dom-id"],
				],
			);
			const replayed = SessionPageState.fromBranch(convertBrowserEntries(branch));
			assert.equal(
				replayed.findReadConfirmation(["--session", SHARED_SESSION, "confirm", "read-id"]),
				undefined,
			);
			assert.equal(
				replayed.findReadConfirmation(["--session", SHARED_SESSION, "confirm", "dom-id"])?.source,
				"native-guarded-action",
			);
			for (const args of [
				["--session", SHARED_SESSION, "confirm", "foreign-id"],
				["--session", "other", "confirm", "dom-id"],
			]) {
				// This step consumes or replaces the shared native pending slot; later commands depend on its completion.
				// oxlint-disable-next-line no-await-in-loop
				await writeFile(log, "");
				// This step consumes or replaces the shared native pending slot; later commands depend on its completion.
				// oxlint-disable-next-line no-await-in-loop
				const unrelated = await executeRegisteredTool(harness.tool, harness.ctx, { args });
				// The nonempty args fixture matrix exhaustively verifies each case; any failed assertion fails the test.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(unrelated.isError, true);
				// The nonempty args fixture matrix exhaustively verifies each case; any failed assertion fails the test.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.deepEqual(
					// Observe the current fixture receipt before deciding whether the next poll or state transition may proceed.
					// oxlint-disable-next-line no-await-in-loop
					(await readInvocationLog(log)).map((call) => extractUpstreamCommandTokens(call.args)),
					[
						["get", "url"],
						["confirm", readString(args.at(-1))],
					],
				);
			}
			await writeFile(log, "");
			const dom = await executeRegisteredTool(harness.tool, harness.ctx, actions[0].params);
			assert.equal(dom.isError, false, dom.content[0].text);
			assert.equal(readRecord(dom.details?.readConfirmation).state, "cleared");
			assert.deepEqual(
				(await readInvocationLog(log)).map((call) => extractUpstreamCommandTokens(call.args)),
				[
					["confirm", "dom-id"],
					["get", "url"],
					["get", "title"],
					["tab", "list"],
				],
			);
			assert.equal(
				readRecord(dom.details?.sessionTabTarget).url,
				"https://clicked.test/",
				"completed native click reconciles its resulting target before follow-ups",
			);
		});
	},
);

for (const batch of [false, true]) {
	test(
		`completed guarded decisions reconcile tabs, fail inner actions truthfully and retire confirmed close on replay (batch=${batch})`,
		{ concurrency: false },
		async () => {
			await withConfirmations(async ({ harness }) => {
				const prefix = ["--session", SHARED_SESSION];
				const decide = async (args: readonly string[]) => {
					const pending = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: [...prefix, ...args],
					});
					assert.equal(pending.details?.failureCategory, "confirmation-required");
					assert.doesNotMatch(
						pending.content[0].text ?? "",
						/Native helper|if dispatched/,
						"the requested action itself awaits confirmation",
					);
					return await executeRegisteredTool(
						harness.tool,
						harness.ctx,
						batch
							? {
									args: [...prefix, "batch", "--bail"],
									stdin: JSON.stringify([["confirm", "dom-id"]]),
								}
							: { args: [...prefix, "confirm", "dom-id"] },
					);
				};
				const failed = await decide(["eval", "throw fixture"]);
				assert.equal(failed.isError, true, failed.content[0].text);
				assert.match(failed.content[0].text ?? "", /HTTP read failed: test response 500/);
				assert.equal(readRecord(failed.details?.readConfirmation).state, "cleared");
				const newTab = await decide(["tab", "new"]);
				assert.equal(newTab.isError, false, newTab.content[0].text);
				assert.equal(readRecord(newTab.details?.sessionTabTarget).url, "about:blank");
				const closed = await decide(["close"]);
				assert.equal(closed.isError, false, closed.content[0].text);
				assert.equal(closed.details?.sessionTabTarget, undefined);
				assert.equal(
					SessionPageState.fromBranch(
						convertBrowserEntries(harness.ctx.sessionManager.getBranch()),
					).get(SHARED_SESSION).tabTarget,
					undefined,
				);
			});
		},
	);
}

for (const batch of [false, true]) {
	for (const command of ["confirm", "deny"]) {
		test(
			`transport tab continuation preserves the exact ${command} (batch=${batch})`,
			{ concurrency: false },
			async () => {
				await withConfirmations(async ({ state, log, harness }) => {
					const target = "https://current.test/continued";
					const metadata = {
						after_confirmation: ["open", target],
						guidance:
							"Only after confirmation creates the blank tab (never after denial), open the requested URL in that tab.",
					};
					await writeFile(state, JSON.stringify({ tabMetadata: metadata }));
					const prefix = ["--namespace", "team", "--session", SHARED_SESSION];
					const row = ["tab", "new", "--label", "continued", target];
					const pending = await executeRegisteredTool(
						harness.tool,
						harness.ctx,
						batch
							? { args: [...prefix, "batch", "--bail"], stdin: JSON.stringify([row]) }
							: { args: [...prefix, ...row] },
					);
					assert.equal(pending.details?.failureCategory, "confirmation-required");
					assert.equal(readRecord(pending.details.readConfirmation).action, "tab_new");
					assert.ok(
						readString(pending.content[0].text).includes(metadata.guidance),
						"conditional transport guidance stays model-visible",
					);
					const native = readRecord(JSON.parse(await readFile(state, "utf8")));
					await writeFile(state, JSON.stringify({ ...native, gateNextUrl: true }));
					await writeFile(log, "");
					const action = readArray(pending.details.nextActions)
						.map(readRecord)
						.find(
							(candidate) =>
								candidate.id ===
								(command === "confirm" ? "approve-confirmation" : "deny-confirmation"),
						);
					assert.ok(action);
					const settled = await executeRegisteredTool(harness.tool, harness.ctx, action.params);
					assert.equal(settled.isError, command === "confirm", settled.content[0].text);
					const data = readRecord(settled.details?.data);
					assert.equal(data.action, "tab_new");
					if (command === "confirm") {
						// This enumerated fixture branch (command === "confirm") has variant-specific assertions; common assertions cover every case.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(data.confirmed, true);
						// This enumerated fixture branch (command === "confirm") has variant-specific assertions; common assertions cover every case.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(
							readRecord(data.result).success,
							true,
							"the original tab decision completed before the separately gated post-action URL helper",
						);
						// This enumerated fixture branch (command === "confirm") has variant-specific assertions; common assertions cover every case.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(settled.details?.failureCategory, "confirmation-required");
						// This enumerated fixture branch (command === "confirm") has variant-specific assertions; common assertions cover every case.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readRecord(settled.details.readConfirmation).action, "url");
					}
					const calls = (await readInvocationLog(log)).map((call) =>
						extractUpstreamCommandTokens(call.args),
					);
					assert.deepEqual(
						calls[0],
						[command, "dom-id"],
						"no gated URL helper replaces the native decision",
					);
					assert.equal(
						calls.some((tokens) => tokens[0] === "open"),
						false,
						"transport continuation is never automatically executed",
					);
					assert.equal(
						readRecord(JSON.parse(await readFile(state, "utf8"))).url,
						command === "confirm" ? "about:blank" : undefined,
					);
				});
			},
		);
	}
}

test("malformed tab transport metadata grants no confirmation provenance", () => {
	const target = "https://current.test/continued";
	const metadata = [
		{ after_confirmation: ["open", target], guidance: "Continuation", action: "click" },
		{ after_confirmation: ["open", "https://other.test/"], guidance: "Unrelated URL" },
		{ after_confirmation: ["open", target] },
		{ guidance: "Missing continuation" },
		{ after_confirmation: ["open", target, "--headers", "{}"], guidance: "Extra arguments" },
		{ after_confirmation: ["open", target], guidance: "" },
		{ after_confirmation: ["open", target], guidance: "Continuation", unrelated: true },
	];
	const command = ["tab", "new", target];
	const controls = metadata.map((row) => {
		const data = {
			confirmation_required: true,
			confirmation_id: "dom-id",
			action: "tab_new",
			...row,
		};
		return [
			getNativePendingControl(command, data),
			getNativeTabContinuationGuidance(command, data),
		];
	});
	assert.deepEqual(
		controls,
		Array.from({ length: 7 }, () => [undefined, undefined]),
	);
});

test(
	"tab continuation page content and malformed native metadata never grant control provenance",
	{ concurrency: false },
	async () => {
		await withConfirmations(async ({ state, log, harness }) => {
			await writeFile(
				state,
				JSON.stringify({
					tabMetadata: {
						after_confirmation: ["open", "https://current.test/continued"],
						guidance: "Continuation",
					},
				}),
			);
			for (const args of [
				["eval", "transport-page"],
				["read", "public.test/body"],
			]) {
				// This step consumes or replaces the shared native pending slot; later commands depend on its completion.
				// oxlint-disable-next-line no-await-in-loop
				const page = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", SHARED_SESSION, ...args],
				});
				// The nonempty args fixture matrix exhaustively verifies each case; any failed assertion fails the test.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(page.details?.readConfirmation, undefined);
			}
			await writeFile(log, "");
			await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", SHARED_SESSION, "confirm", "dom-id"],
			});
			assert.deepEqual(extractUpstreamCommandTokens((await readInvocationLog(log))[0].args), [
				"get",
				"url",
			]);
			await writeFile(
				state,
				JSON.stringify({
					tabMetadata: {
						after_confirmation: ["open", "https://current.test/continued"],
						guidance: "Continuation",
						unrelated: true,
					},
				}),
			);
			const malformed = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", SHARED_SESSION, "tab", "new", "https://current.test/continued"],
			});
			assert.equal(malformed.details?.readConfirmation, undefined);
			await writeFile(log, "");
			await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", SHARED_SESSION, "confirm", "dom-id"],
			});
			assert.deepEqual(
				extractUpstreamCommandTokens((await readInvocationLog(log))[0].args),
				["get", "url"],
				"malformed native metadata still requires a page check before the decision",
			);
		});
	},
);

test(
	"resumed batch confirmation reconciles click before an ordinary getter without discarding adjacent rows",
	{ concurrency: false },
	async () => {
		await withConfirmations(async ({ root, state, branch, harness }) => {
			await writeFile(state, JSON.stringify({ url: "https://fixture.test/before" }));
			const prefix = ["--session", SHARED_SESSION];
			for (const args of [
				["get", "url"],
				["click", "#guarded"],
			]) {
				// This step consumes or replaces the shared native pending slot; later commands depend on its completion.
				// oxlint-disable-next-line no-await-in-loop
				await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, ...args],
				});
			}
			const resumed = createExtensionHarness({ cwd: root, branch });
			await runExtensionEvent(resumed.handlers, "session_start", { reason: "resume" }, resumed.ctx);
			const confirmed = await executeRegisteredTool(resumed.tool, resumed.ctx, {
				args: [...prefix, "batch", "--bail"],
				stdin: JSON.stringify([
					["get", "title"],
					["confirm", "dom-id"],
					["get", "title"],
				]),
			});
			assert.equal(confirmed.isError, false, confirmed.content[0].text);
			assert.equal(readRecord(confirmed.details?.sessionTabTarget).url, "https://clicked.test/");
			assert.equal(readArray(confirmed.details?.batchSteps).length, 3);
			const title = await executeRegisteredTool(resumed.tool, resumed.ctx, {
				args: [...prefix, "get", "title"],
			});
			assert.equal(title.isError, false, title.content[0].text);
		});
	},
);

test(
	"early helper pending identifies the helper and the requested command is not dispatched",
	{ concurrency: false },
	async () => {
		await withConfirmations(async ({ state, log, harness }) => {
			await writeFile(state, JSON.stringify({ gateNextUrl: true }));
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", SHARED_SESSION, "get", "title"],
			});
			assert.equal(result.details?.failureCategory, "confirmation-required");
			assert.equal(result.details.agentBrowserStarted, false);
			assert.match(
				result.content[0].text ?? "",
				/Native helper get requires confirmation \(url\).*requested command was not dispatched/,
			);
			assert.deepEqual(
				(await readInvocationLog(log)).map((call) => extractUpstreamCommandTokens(call.args)),
				[["get", "url"]],
			);
		});
	},
);

test(
	"genuine post-command helper pending remains labelled and preserves the dispatched batch receipt",
	{ concurrency: false },
	async () => {
		await withConfirmations(async ({ harness }) => {
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", SHARED_SESSION, "batch", "--bail"],
				stdin: JSON.stringify([["click", "#dispatched"]]),
			});
			assert.equal(result.details?.failureCategory, "confirmation-required");
			assert.equal(result.details.agentBrowserStarted, true);
			assert.equal(readRecord(result.details.readConfirmation).command, "get");
			assert.match(result.content[0].text ?? "", /Native helper get requires confirmation/);
			assert.deepEqual(readArray(result.details.data).map(readRecord)[0].command, [
				"click",
				"#dispatched",
			]);
		});
	},
);

test(
	"only the first effective matching batch decision suppresses helpers and later unknown-page checks remain",
	{ concurrency: false },
	async () => {
		await withConfirmations(async ({ log, state, harness }) => {
			const prefix = ["--session", SHARED_SESSION];
			await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "get", "url"] });
			for (const control of [
				{ session: SHARED_SESSION, rows: [["confirm", "dom-id"]], suppress: true },
				{ session: SHARED_SESSION, rows: [["confirm", "foreign-id"]], suppress: false },
				{ session: "other", rows: [["confirm", "dom-id"]], suppress: false },
				{
					session: SHARED_SESSION,
					rows: [
						["get", "title"],
						["confirm", "dom-id"],
					],
					suppress: false,
				},
				{
					session: SHARED_SESSION,
					rows: [["confirm", "dom-id"]],
					raw: "get title",
					suppress: false,
				},
			]) {
				// This step consumes or replaces the shared native pending slot; later commands depend on its completion.
				// oxlint-disable-next-line no-await-in-loop
				await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, "click", "#guarded"],
				});
				// This step consumes or replaces the shared native pending slot; later commands depend on its completion.
				// oxlint-disable-next-line no-await-in-loop
				await writeFile(log, "");
				// This step consumes or replaces the shared native pending slot; later commands depend on its completion.
				// oxlint-disable-next-line no-await-in-loop
				await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [
						"--session",
						control.session,
						"batch",
						"--bail",
						...(control.raw !== undefined && control.raw.length > 0 ? [control.raw] : []),
					],
					stdin: JSON.stringify(control.rows),
				});
				// Observe the current fixture receipt before deciding whether the next poll or state transition may proceed.
				// oxlint-disable-next-line no-await-in-loop
				const commands = (await readInvocationLog(log)).map((call) =>
					extractUpstreamCommandTokens(call.args),
				);
				// The nonempty control fixture matrix exhaustively verifies each case; any failed assertion fails the test.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(commands[0][0] === "batch", control.suppress, JSON.stringify(control));
				if (control.raw !== undefined && control.raw.length > 0) {
					// This enumerated fixture branch (control.raw !== undefined && control.raw.length > 0) has variant-specific assertions; common assertions cover every case.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(
						// This step consumes or replaces the shared native pending slot; later commands depend on its completion.
						// oxlint-disable-next-line no-await-in-loop
						readRecord(readRecord(JSON.parse(await readFile(state, "utf8"))).pending).id,
						"dom-id",
						"ignored stdin cannot settle the pending action",
					);
				}
			}
			await executeRegisteredTool(harness.tool, harness.ctx, {
				args: [...prefix, "webmcp", "invoke", "pending"],
			});
			await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "close"] });
			await writeFile(log, "");
			const blocked = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: [...prefix, "batch", "--bail"],
				stdin: JSON.stringify([
					["confirm", "dom-id"],
					["get", "title"],
				]),
			});
			assert.equal(blocked.isError, true);
			assert.match(readString(blocked.details?.validationError), /unverified|unknown|verified/i);
			assert.deepEqual(
				await readInvocationLog(log),
				[],
				"matching the first decision cannot bypass later unknown-page validation",
			);
		});
	},
);

for (const mode of ["direct", "batch", "code", "code-batch"] as const) {
	for (const failedClose of [false, true]) {
		test(
			`confirmed close retires attachment on live and replay paths (${mode}, failed=${failedClose})`,
			{ concurrency: false },
			async () => {
				const expectedAttachment = failedClose ? true : undefined;
				await withConfirmations(async ({ root, state, harness }) => {
					const prefix = ["--session", SHARED_SESSION];
					await executeRegisteredTool(harness.tool, harness.ctx, {
						args: [...prefix, "connect", "9222"],
					});
					for (const args of [["--confirm-actions", "close", "get", "url"], ["close"]]) {
						// This step consumes or replaces the shared native pending slot; later commands depend on its completion.
						// oxlint-disable-next-line no-await-in-loop
						await executeRegisteredTool(harness.tool, harness.ctx, {
							args: [...prefix, ...args],
						});
					}
					if (failedClose) {
						const native = readRecord(JSON.parse(await readFile(state, "utf8")));
						readRecord(native.pending).failure = true;
						await writeFile(state, JSON.stringify(native));
					}
					const decision = mode.endsWith("batch")
						? { args: ["batch", "--bail"], stdin: JSON.stringify([["confirm", "dom-id"]]) }
						: { args: ["confirm", "dom-id"] };
					const code = mode.startsWith("code");
					const codeTool = harness.getTool("agent_browser_code");
					assert.ok(codeTool);
					const result = await executeRegisteredTool(
						code ? codeTool : harness.tool,
						harness.ctx,
						code
							? {
									session: SHARED_SESSION,
									code: `emit((await browser(${JSON.stringify(decision)})).success);`,
								}
							: { ...decision, args: [...prefix, ...decision.args] },
					);
					assert.equal(result.isError, code ? false : failedClose, result.content[0].text);
					if (code) {
						// This enumerated fixture branch (code) has variant-specific assertions; common assertions cover every case.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(result.details?.data, !failedClose);
					}
					const page = SessionPageState.fromBranch(
						convertBrowserEntries(harness.ctx.sessionManager.getBranch()),
					).get(SHARED_SESSION);
					assert.equal(
						page.tabTargetUnknown,
						undefined,
						"a completed close must retire the code intent's unknown target",
					);
					assert.equal(page.pinningReason, failedClose ? "restore" : undefined);
					assert.equal(page.tabTarget?.url, failedClose ? "https://current.test/" : undefined);
					assert.equal(page.confirmActions, failedClose ? "close" : undefined);
					const live = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: [...prefix, "get", "title"],
					});
					assert.equal(live.isError, false, live.content[0].text);
					assert.equal(live.details?.attachedBrowserSession, expectedAttachment);
					const resumed = createExtensionHarness({
						cwd: root,
						branch: structuredClone(harness.ctx.sessionManager.getBranch()),
					});
					await runExtensionEvent(
						resumed.handlers,
						"session_start",
						{ reason: "resume" },
						resumed.ctx,
					);
					const restored = await executeRegisteredTool(resumed.tool, resumed.ctx, {
						args: [...prefix, "get", "title"],
					});
					assert.equal(restored.isError, false, restored.content[0].text);
					assert.equal(
						restored.details?.attachedBrowserSession,
						expectedAttachment,
						"confirmed-close retirement must survive compact direct/code/batch replay; failed close must retain attachment",
					);
				});
			},
		);
	}
}
