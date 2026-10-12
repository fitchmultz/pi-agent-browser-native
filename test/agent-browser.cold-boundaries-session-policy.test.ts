import assert from "node:assert/strict";
import test from "node:test";
import { readRecord, readArray, readString } from "./helpers/assertions.js";
import { extractUpstreamCommandTokens } from "../extensions/agent-browser/lib/argv-descriptor.js";
import { chosenUrl, withPage, withPages } from "./helpers/cold-boundaries-fixture.js";

for (const state of ["cold", "known", "unknown", "reopen"]) {
	test(
		`session info timeout preserves ${state} state without browser recovery`,
		{ concurrency: false },
		async (t) => {
			await withPage(
				async (page) => {
					const initialArgs = {
						cold: ["--namespace", "cold", "--session", "cold-inspected", "session", "info"],
						reopen: ["tab", "list"],
						unknown: ["webmcp", "invoke", "wait_for_navigation", "--detach"],
						known: ["snapshot", "-i"],
					};
					const before = await page.call({
						args: readArray(readRecord(initialArgs)[state]).map(readString),
					});
					assert.equal(before.isError, false, readString(readRecord(before.content[0]).text));
					if (state === "known") {
						// Fixed cold/known/unknown/reopen and batch fixtures require different state assertions; common dispatch checks remain unconditional.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.notEqual(readRecord(readRecord(before.details).refSnapshot), undefined);
					}
					if (state === "unknown") {
						// Fixed cold/known/unknown/reopen and batch fixtures require different state assertions; common dispatch checks remain unconditional.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readRecord(before.details).sessionTabTargetUnknown, true);
					}
					if (state === "reopen") {
						// Fixed cold/known/unknown/reopen and batch fixtures require different state assertions; common dispatch checks remain unconditional.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readRecord(before.details).sessionTabReopenPending, true);
					}
					const prefix = [
						"--namespace",
						"cold",
						"--session",
						readString(readRecord(before.details).sessionName),
					];
					const args = [...prefix, "session", "info"];
					const nativeBefore = await page.state();
					const offset = (await page.calls()).length;
					await page.patch({ timeoutInfo: true });
					const realSetTimeout = setTimeout;
					t.mock.timers.enable({ apis: ["setTimeout"] });
					const controller = new AbortController();
					const pending = page.call({ args, timeoutMs: 800 }, controller.signal);
					let timedOut;
					try {
						const deadline = Date.now() + 15_000;
						// Observe actual subprocess startup before advancing its timeout.
						// oxlint-disable-next-line no-await-in-loop
						while ((await page.calls()).length === offset) {
							if (Date.now() > deadline) {
								throw new Error("session info child did not dispatch");
							}
							// Native I/O must progress while only the wrapper watchdog is controlled.
							// oxlint-disable-next-line no-await-in-loop
							await new Promise<void>((resolve) => {
								realSetTimeout(resolve, 5);
							});
						}
						t.mock.timers.tick(800);
						t.mock.timers.reset();
						timedOut = await pending;
					} finally {
						t.mock.timers.reset();
						controller.abort();
						await page.patch({ timeoutInfo: false });
						await Promise.allSettled([pending]);
					}
					assert.equal(timedOut.isError, true);
					assert.equal(
						readRecord(timedOut.details).exitCode,
						process.platform === "win32" ? 1 : 124,
					);
					assert.equal(readRecord(timedOut.details).timedOut, true);
					assert.equal(readRecord(timedOut.details).failureCategory, "timeout");
					assert.deepEqual(
						(await page.calls()).slice(offset).map((row) => row.args),
						[["--json", ...args]],
					);
					assert.deepEqual(
						{ ...(await page.state()), timeoutInfo: undefined },
						{ ...nativeBefore, timeoutInfo: undefined },
					);
					for (const key of [
						"sessionTabTarget",
						"sessionTabTargetUnknown",
						"refSnapshotInvalidation",
						"sessionTabReopenPending",
					]) {
						// Fixed cold/known/unknown/reopen and batch fixtures require different state assertions; common dispatch checks remain unconditional.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.deepEqual(
							readRecord(timedOut.details)[key],
							readRecord(before.details)[key],
							key,
						);
					}
					for (const key of [
						"timeoutPartialProgress",
						"artifacts",
						"artifactVerification",
						"browserWindow",
						"lifecycle",
						"data",
						"managedSessionOutcome",
					]) {
						// Fixed cold/known/unknown/reopen and batch fixtures require different state assertions; common dispatch checks remain unconditional.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readRecord(timedOut.details)[key], undefined, key);
					}
					const actions = readArray(readRecord(timedOut.details).nextActions);
					assert.deepEqual(
						actions.map((action) => ({
							id: readRecord(action).id,
							args: readRecord(readRecord(action).params).args,
						})),
						[{ id: "retry-session-info", args }],
					);
					const retried = await page.call({
						args: readArray(readRecord(readRecord(actions[0]).params).args).map(readString),
					});
					assert.equal(retried.isError, false, readString(readRecord(retried.content[0]).text));
					assert.equal(
						readRecord(readRecord(retried.details).data).piCleanupOwnership,
						state === "cold" ? "caller-owned" : "wrapper-managed",
					);
					assert.deepEqual(
						(await page.calls()).slice(offset).map((row) => row.args),
						[
							["--json", ...args],
							["--json", ...args],
						],
					);
					assert.deepEqual(
						{ ...(await page.state()), timeoutInfo: undefined },
						{ ...nativeBefore, timeoutInfo: undefined },
					);
					if (state === "unknown") {
						const blocked = await page.call({ args: [...prefix, "snapshot", "-i"] });
						// Fixed cold/known/unknown/reopen and batch fixtures require different state assertions; common dispatch checks remain unconditional.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(blocked.isError, true);
						// Fixed cold/known/unknown/reopen and batch fixtures require different state assertions; common dispatch checks remain unconditional.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.match(
							readString(readRecord(blocked.content[0]).text),
							/active page became unverified/,
						);
						// Fixed cold/known/unknown/reopen and batch fixtures require different state assertions; common dispatch checks remain unconditional.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal((await page.calls()).length, offset + 2);
					}
					if (state === "reopen") {
						const snapshot = await page.call({ args: [...prefix, "snapshot", "-i"] });
						// Fixed cold/known/unknown/reopen and batch fixtures require different state assertions; common dispatch checks remain unconditional.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(snapshot.isError, false, readString(readRecord(snapshot.content[0]).text));
						// Fixed cold/known/unknown/reopen and batch fixtures require different state assertions; common dispatch checks remain unconditional.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readRecord(readRecord(snapshot.details).data).origin, page.url);
					}
				},
				{ live: state === "known" || state === "unknown" },
			);
		},
	);
}

for (const prefix of [
	["tab", "list"],
	["read", "--timeout", "100", chosenUrl],
	["console", "--clear"],
]) {
	test(
		`cold reopen persists through non-page ${prefix.join(" ")} and transcript replay`,
		{ concurrency: false },
		async () => {
			await withPage(async (page) => {
				const first = await page.call({ args: prefix });
				assert.equal(first.isError, false, readString(readRecord(first.content[0]).text));
				assert.equal(
					(await page.state()).active,
					prefix[0] !== "read",
					"HTTP reads leave the cold managed daemon untouched",
				);
				assert.equal((await page.state()).browser, prefix[0] !== "read");
				assert.equal(
					(await page.state()).url,
					prefix[0] === "read" ? "about:blank" : new URL(page.url).origin + "/",
				);
				assert.equal(
					readRecord(first.details).sessionTabReopenPending,
					prefix[0] === "read" ? undefined : true,
				);
				assert.equal(
					readRecord(first.details?.sessionTabTarget ?? {}).url,
					prefix[0] === "read" ? undefined : page.url,
				);
				assert.equal(
					readRecord(first.details?.refSnapshotInvalidation ?? {}).reason,
					prefix[0] === "read" ? undefined : "page-transition",
				);
				assert.equal(
					(await page.calls()).some((row) => row.args.includes("open")),
					false,
				);
				await page.tree();
				await page.reload();
				const result = await page.call({ args: ["get", "url"] });
				assert.equal(result.isError, false, readString(readRecord(result.content[0]).text));
				assert.equal(readRecord(readRecord(result.details).data).url, page.url);
				const snapshot = await page.call({ args: ["snapshot", "-i"] });
				assert.equal(snapshot.isError, false, readString(readRecord(snapshot.content[0]).text));
				assert.equal(readRecord(readRecord(snapshot.details).data).origin, page.url);
				assert.deepEqual(
					(await page.calls())
						.filter((row) => row.args.includes("open"))
						.map((row) => extractUpstreamCommandTokens(row.args)),
					[["open", page.url]],
				);
			});
		},
	);
}

for (const options of [{ explicit: true }, { attached: true }, { restoreDisabled: true }]) {
	test(
		`cold boundary does not navigate outside automatic restore: ${JSON.stringify(options)}`,
		{ concurrency: false },
		async (t) => {
			await withPages(async (withRow) => {
				for (const inspectFirst of [false, true]) {
					// Each ownership variant needs independent native state and replay before inspecting.
					// oxlint-disable-next-line no-await-in-loop
					await t.test(`inspect first=${inspectFirst}`, () =>
						withRow(async (page) => {
							const inspected = inspectFirst
								? await page.call({ args: ["tab", "list"] })
								: undefined;
							assert.equal(
								inspected?.isError,
								inspectFirst ? false : undefined,
								JSON.stringify(inspected),
							);
							const snapshot = await page.call({ args: ["snapshot", "-i"] });
							assert.equal(snapshot.isError, !("explicit" in options), JSON.stringify(snapshot));
							assert.equal(
								readRecord(snapshot.details).failureCategory,
								"explicit" in options ? undefined : "tab-drift",
								JSON.stringify(snapshot),
							);
							const commands = new Set(
								(await page.calls()).map((row) => extractUpstreamCommandTokens(row.args)[0]),
							);
							assert.equal(
								commands.has("snapshot"),
								"explicit" in options,
								"only a verified caller-owned live page may dispatch the snapshot",
							);
							assert.equal(commands.has("open"), false);
						}),
					);
				}
			}, options);
		},
	);
}
