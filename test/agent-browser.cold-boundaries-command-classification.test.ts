import assert from "node:assert/strict";
import test from "node:test";
import { readRecord, readArray, readString } from "./helpers/assertions.js";
import { extractUpstreamCommandTokens } from "../extensions/agent-browser/lib/argv-descriptor.js";
import {
	rememberedUrl,
	chosenUrl,
	hashRouteUrl,
	withPage,
	withPages,
} from "./helpers/cold-boundaries-fixture.js";

for (const boundary of [
	["open", chosenUrl],
	["close"],
	["tab", "new", chosenUrl],
	["state", "load", "fixture.json"],
]) {
	test(
		`cold batch respects non-page prefixes before ${boundary.join(" ")}`,
		{ concurrency: false },
		async () => {
			await withPage(async (page) => {
				const stdin = JSON.stringify([["tab", "list"], boundary, ["get", "url"]]);
				const result = await page.call({ args: ["batch", "--bail"], stdin });
				assert.equal(result.isError, false, readString(readRecord(result.content[0]).text));
				const calls = await page.calls();
				assert.equal(
					calls.some((row) => extractUpstreamCommandTokens(row.args)[0] === "open"),
					false,
					"do not reopen ahead of explicit context changes",
				);
				assert.equal(calls.find((row) => row.args.includes("batch"))?.stdin, stdin);
			});
		},
	);
}

for (const bail of [false, true]) {
	test(
		`cold preparation preserves native batch error continuation (bail=${bail})`,
		{ concurrency: false },
		async () => {
			await withPage(async (page) => {
				const args = ["batch", ...(bail ? ["--bail"] : [])];
				const stdin = JSON.stringify([["tab", "list"], ["not-a-command"], ["snapshot", "-i"]]);
				const result = await page.call({ args, stdin });
				assert.equal(result.isError, true);
				const rows = readArray(readRecord(result.details).batchSteps);
				assert.deepEqual(
					rows.map((row) => readRecord(row).success),
					bail ? [true, false] : [true, false, true],
				);
				const batches = (await page.calls()).filter((row) => row.args.includes("batch"));
				assert.equal(batches.length, 1);
				assert.deepEqual(extractUpstreamCommandTokens(batches[0].args), args);
				assert.equal(batches[0].stdin, stdin);
				if (!bail) {
					// Fixed cold/known/unknown/reopen and batch fixtures require different state assertions; common dispatch checks remain unconditional.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(
						readRecord(readRecord(readArray(readRecord(result.details).data).at(-1)).result).origin,
						page.url,
					);
				}
			});
		},
	);
}

test(
	"live hash-only changes retain fragment-insensitive ref freshness checks",
	{ concurrency: false },
	async () => {
		await withPage(
			async (page) => {
				await page.patch({ url: "http://127.0.0.1:43210/app#/other", refName: "Different field" });
				const result = await page.call({ args: ["get", "value", "@e1"] });
				assert.equal(readRecord(result.details).failureCategory, "stale-ref");
				assert.equal(
					(await page.calls()).some(
						(row) => row.args.includes("open") || row.args.includes("value"),
					),
					false,
				);
			},
			{ live: true, url: hashRouteUrl },
		);
	},
);

const explicitDestinations = [
	["read", "--timeout", "100", "--filter", "needle", chosenUrl],
	["read", "--llms", "full", chosenUrl],
	["a11y", "--tags", "wcag2a", "-s", "main", chosenUrl],
	["vitals", chosenUrl],
	["web-vitals", chosenUrl],
	["diff", "url", rememberedUrl, chosenUrl, "--selector", "main", "--wait-until", "load"],
	["window", "new"],
	["record", "start", "chosen.webm", chosenUrl],
];

test("live explicit-destination classification", { concurrency: false }, async (t) => {
	await withPages(
		async (withRow) => {
			for (const command of explicitDestinations) {
				for (const batch of [false, true]) {
					// Each row owns a fresh replay harness and native state, and completes cleanup before the next.
					// oxlint-disable-next-line no-await-in-loop
					await t.test(
						`live missing tab permits explicit destination ${command.join(" ")} (batch=${batch})`,
						async () => {
							await withRow(async (page) => {
								await page.patch({ url: "http://127.0.0.1:43210/other" });
								const args = batch ? ["batch"] : command;
								const stdin = batch ? JSON.stringify([command]) : undefined;
								const result = await page.call({ args, stdin });
								assert.equal(result.isError, false, readString(readRecord(result.content[0]).text));
								const calls = await page.calls();
								const userCalls = calls.filter(
									(row) => extractUpstreamCommandTokens(row.args)[0] === args[0],
								);
								assert.equal(userCalls.length, 1, "the requested command must actually dispatch");
								assert.deepEqual(extractUpstreamCommandTokens(userCalls[0].args), args);
								if (batch) {
									// Fixed cold/known/unknown/reopen and batch fixtures require different state assertions; common dispatch checks remain unconditional.
									// oxlint-disable-next-line node-test/no-conditional-assertion
									assert.equal(userCalls[0].stdin, stdin);
								}
								assert.equal(
									calls.some((row) => extractUpstreamCommandTokens(row.args)[0] === "open"),
									false,
								);
							});
						},
					);
				}
			}
		},
		{ live: true },
	);
});

test(
	"live raw explicit URL read ignores unused stdin without old-tab recovery",
	{ concurrency: false },
	async () => {
		await withPage(
			async (page) => {
				await page.patch({ url: "http://127.0.0.1:43210/other" });
				const raw = `read --timeout 100 ${chosenUrl}`;
				const stdin = JSON.stringify([["snapshot", "-i"]]);
				const args = ["--headers", '{"x-fixture":"boundary"}', "--no-pin-tab", "batch", raw];
				const result = await page.call({ args, stdin });
				assert.equal(result.isError, false, readString(readRecord(result.content[0]).text));
				const batch = (await page.calls()).find((row) => row.args.includes("batch"));
				assert.ok(batch);
				assert.deepEqual(batch.args.slice(-args.length), args);
				assert.equal(batch.stdin, stdin);
				assert.deepEqual(
					readArray(readRecord(result.details).batchSteps).map((row) => readRecord(row).command),
					[["read", "--timeout", "100", chosenUrl]],
				);
				assert.equal(
					(await page.calls()).some((row) =>
						["open", "tab", "snapshot"].includes(extractUpstreamCommandTokens(row.args)[0]),
					),
					false,
				);
			},
			{ live: true, explicit: true },
		);
	},
);

test("live page-dependent classification", { concurrency: false }, async (t) => {
	await withPages(
		async (withRow) => {
			for (const command of [
				["network", "requests", "--current-url"],
				["read", "--filter", chosenUrl],
				["read", "--llms", "full"],
				["a11y", "--selector", chosenUrl],
				["a11y", "--tags", "wcag2a"],
				["vitals"],
				["diff", "snapshot"],
				["record", "start", "chosen.webm"],
				["reload"],
				["pushstate", "/route"],
				["fill", "#name", "text"],
			]) {
				// Each row owns a fresh replay harness and native state, and completes cleanup before the next.
				// oxlint-disable-next-line no-await-in-loop
				await t.test(
					`live page-dependent ${command.join(" ")} still protects a missing tab`,
					async () => {
						await withRow(async (page) => {
							await page.patch({ url: "http://127.0.0.1:43210/other" });
							for (const params of [
								{ args: command },
								{ args: ["batch"], stdin: JSON.stringify([["read", chosenUrl], command]) },
							]) {
								// These dependent calls reuse the same page, restore state, and shutdown ownership.
								// oxlint-disable-next-line no-await-in-loop
								const result = await page.call(params);
								// Fixed cold/known/unknown/reopen and batch fixtures require different state assertions; common dispatch checks remain unconditional.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(readRecord(result.details).failureCategory, "tab-drift");
							}
							assert.equal(
								(await page.calls()).some(
									(row) => !["session", "tab"].includes(extractUpstreamCommandTokens(row.args)[0]),
								),
								false,
								"neither page actions nor unsolicited navigation may run",
							);
						});
					},
				);
			}
		},
		{ live: true },
	);
});
