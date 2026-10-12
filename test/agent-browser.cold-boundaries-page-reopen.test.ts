import assert from "node:assert/strict";
import test from "node:test";
import { readRecord, readArray, readString } from "./helpers/assertions.js";
import { extractUpstreamCommandTokens } from "../extensions/agent-browser/lib/argv-descriptor.js";
import { chosenUrl, hashRouteUrl, withPage } from "./helpers/cold-boundaries-fixture.js";

for (const args of [["reload"], ["back"], ["forward"], ["pushstate", "/route"]]) {
	test(
		`cold current-page command reopens before ${args.join(" ")}`,
		{ concurrency: false },
		async () => {
			await withPage(async (page) => {
				const result = await page.call({ args });
				assert.equal(result.isError, false, readString(readRecord(result.content[0]).text));
				const commands = (await page.calls()).map((row) => extractUpstreamCommandTokens(row.args));
				assert.ok(
					commands.findIndex((row) => row[0] === "open") <
						commands.findIndex((row) => JSON.stringify(row) === JSON.stringify(args)),
					JSON.stringify(commands),
				);
				assert.deepEqual(
					commands.filter((row) => row[0] === "open"),
					[["open", page.url]],
				);
			});
		},
	);
}

for (const prefix of [
	["tab", "list"],
	["read", "--timeout", "100", chosenUrl],
	["session", "info"],
	["console", "--clear"],
]) {
	test(
		`cold batch finds the page dependency after ${prefix.join(" ")}`,
		{ concurrency: false },
		async () => {
			await withPage(async (page) => {
				const stdin = JSON.stringify([prefix, ["snapshot", "-i"]]);
				const result = await page.call({ args: ["batch", "--bail"], stdin });
				assert.equal(result.isError, false, readString(readRecord(result.content[0]).text));
				assert.equal(
					readRecord(readRecord(readArray(readRecord(result.details).data).at(-1)).result).origin,
					page.url,
				);
				const calls = await page.calls();
				assert.equal(calls.filter((row) => row.args.includes("batch")).length, 1);
				assert.equal(calls.find((row) => row.args.includes("batch"))?.stdin, stdin);
				assert.deepEqual(
					calls
						.filter((row) => row.args.includes("open"))
						.map((row) => extractUpstreamCommandTokens(row.args)),
					[["open", page.url]],
				);
			});
		},
	);
}

for (const params of [
	{ args: ["snapshot", "-i"] },
	{
		args: ["batch", "--bail"],
		stdin: JSON.stringify([
			["tab", "list"],
			["snapshot", "-i"],
		]),
	},
]) {
	test(
		`cold hash-router URL is reopened intact for ${params.args.join(" ")}`,
		{ concurrency: false },
		async () => {
			await withPage(
				async (page) => {
					const result = await page.call(params);
					assert.equal(result.isError, false, readString(readRecord(result.content[0]).text));
					assert.equal((await page.state()).url, hashRouteUrl);
					assert.deepEqual(
						(await page.calls())
							.filter((row) => extractUpstreamCommandTokens(row.args)[0] === "open")
							.map((row) => extractUpstreamCommandTokens(row.args)),
						[["open", hashRouteUrl]],
					);
					assert.equal(
						readRecord(readRecord(readRecord(result.details).refSnapshot).target).url,
						hashRouteUrl,
					);
				},
				{ url: hashRouteUrl },
			);
		},
	);
}

test(
	"cold current-URL network filtering reopens before its helper and persists ref invalidation",
	{ concurrency: false },
	async () => {
		await withPage(async (page) => {
			const result = await page.call({ args: ["network", "requests", "--current-url"] });
			assert.equal(result.isError, false, readString(readRecord(result.content[0]).text));
			assert.equal(
				readRecord(readRecord(result.details).networkRequestsPageFilter).currentUrl,
				page.url,
			);
			await page.reload();
			const stale = await page.call({ args: ["get", "value", "@e1"] });
			assert.equal(readRecord(stale.details).failureCategory, "stale-ref");
			assert.equal(
				(await page.calls()).some((row) => row.args.includes("value")),
				false,
			);
		});
	},
);

for (const reachedNavigation of [false, true]) {
	test(
		`cold pending reopen follows executed batch rows (navigation reached=${reachedNavigation})`,
		{ concurrency: false },
		async () => {
			await withPage(async (page) => {
				const tabs = await page.call({ args: ["tab", "list"] });
				assert.equal(tabs.isError, false, readString(readRecord(tabs.content[0]).text));
				await page.patch({ failNext: reachedNavigation ? "open" : "console" });
				const result = await page.call({
					args: ["batch", "--bail"],
					stdin: JSON.stringify([
						["console", "--clear"],
						["open", chosenUrl],
					]),
				});
				assert.equal(result.isError, true);

				assert.deepEqual(
					readArray(readRecord(result.details).batchSteps).map((row) => ({
						command: readRecord(row).command,
						success: readRecord(row).success,
					})),
					reachedNavigation
						? [
								{ command: ["console", "--clear"], success: true },
								{ command: ["open", chosenUrl], success: false },
							]
						: [{ command: ["console", "--clear"], success: false }],
				);
				await page.reload();
				const snapshot = await page.call({ args: ["snapshot", "-i"] });
				assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
				const expectedUrl = reachedNavigation ? new URL(page.url).origin + "/" : page.url;
				assert.equal(readRecord(readRecord(snapshot.details).data).origin, expectedUrl);
				assert.equal(readRecord(readRecord(snapshot.details).sessionTabTarget).url, expectedUrl);
				assert.equal(
					(await page.calls()).filter(
						(row) => extractUpstreamCommandTokens(row.args)[0] === "snapshot",
					).length,
					1,
					"the follow-up capture must dispatch against the verified resulting target",
				);
				assert.equal(
					(await page.calls()).filter((row) => extractUpstreamCommandTokens(row.args)[0] === "open")
						.length,
					reachedNavigation ? 0 : 1,
					"unreached navigation must not consume the obligation; attempted navigation must not trigger an unsolicited retry",
				);
			});
		},
	);
}
