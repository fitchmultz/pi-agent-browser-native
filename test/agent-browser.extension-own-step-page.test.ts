/**
 * Purpose: Verify that agent_browser checks the page itself after its own eval or reload.
 * Responsibilities: Assert that a confirmed page lets the next content command run, that a changed URL, an error page, or an unreadable URL is reported first in the same result, and that an unconfirmed page stays refused.
 * Scope: Registered-tool coverage through the extension harness with a stateful fake upstream.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-own-step-page.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: The fake mirrors native result shapes: eval reports `origin`, reload reports `url`, both read after the step.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest from "node:test";

import { readArray, readRecord, readString } from "./helpers/assertions.js";
import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
	type ExtensionHarness,
} from "./helpers/agent-browser-harness.js";

const START_URL = "https://example.test/a";
const OTHER_URL = "https://example.test/b";
const ERROR_URL = "chrome-error://chromewebdata/";
const UNVERIFIED = /active page became unverified/;

/** What the next eval or reload does to the fake page, and whether get url still answers after eval. */
interface FakePageScenario {
	readonly evalUrl?: string;
	readonly getUrlFailsAfterEval?: boolean;
	readonly reloadUrl?: string;
}

interface OwnStepFixture {
	readonly call: (
		args: readonly string[],
		stdin?: string,
	) => Promise<{
		readonly details: Record<string, unknown>;
		readonly isError: boolean;
		readonly text: string;
	}>;
	readonly nativeCommands: () => Promise<string[]>;
	readonly setScenario: (scenario: FakePageScenario) => Promise<void>;
}

function fakeUpstreamScript(paths: {
	readonly log: string;
	readonly scenario: string;
	readonly state: string;
}): string {
	return `const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const readJson = (path, fallback) => { try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return fallback; } };
const scenario = readJson(${JSON.stringify(paths.scenario)}, {});
const state = readJson(${JSON.stringify(paths.state)}, { url: "about:blank" });
const valueFlags = new Set(["--session", "--namespace", "--args", "--user-agent"]);
let commandIndex = 0;
while (commandIndex < args.length && args[commandIndex].startsWith("--")) commandIndex += valueFlags.has(args[commandIndex]) ? 2 : 1;
const tokens = args.slice(commandIndex);
fs.appendFileSync(${JSON.stringify(paths.log)}, JSON.stringify({ args: tokens, stdin }) + "\\n");
function run([command, sub, ...rest]) {
  if (command === "open") { state.url = sub; return { data: { title: "Fixture", url: state.url } }; }
  if (command === "reload") { state.url = scenario.reloadUrl ?? state.url; return { data: { url: state.url } }; }
  if (command === "back") return { data: { url: state.url } };
  if (command === "eval") { state.url = scenario.evalUrl ?? state.url; state.evaluated = true; return { data: { result: "done", origin: state.url } }; }
  if (command === "get" && sub === "url") return scenario.getUrlFailsAfterEval && state.evaluated ? { error: "CDP error: target closed" } : { data: { url: state.url } };
  if (command === "get" && sub === "title") return { data: { title: "Fixture" } };
  if (command === "get" && sub === "text") return { data: { text: "content of " + state.url, origin: state.url } };
  if (command === "snapshot") return { data: { origin: state.url, refs: { e1: { role: "button", name: "Go" } }, snapshot: '- button "Go" [ref=e1]' } };
  if (command === "tab" && sub === "list") return { data: { tabs: [{ tabId: "t1", targetId: "T1", url: state.url, active: true }] } };
  return { data: {} };
}
let out;
if (tokens[0] === "batch") {
  const rows = [];
  for (const step of JSON.parse(stdin)) {
    const result = run(step);
    rows.push(result.error ? { command: step, success: false, error: result.error } : { command: step, success: true, result: result.data });
    if (result.error && tokens.includes("--bail")) break;
  }
  out = { success: rows.every((row) => row.success), data: rows };
} else {
  const result = run(tokens);
  out = result.error ? { success: false, error: result.error } : { success: true, data: result.data };
}
fs.writeFileSync(${JSON.stringify(paths.state)}, JSON.stringify(state));
process.stdout.write(JSON.stringify(out));
if (!out.success) process.exitCode = 1;`;
}

async function callTool(
	harness: ExtensionHarness,
	args: readonly string[],
	stdin?: string,
): ReturnType<OwnStepFixture["call"]> {
	const result = await executeRegisteredTool(harness.tool, harness.ctx, {
		args: [...args],
		...(stdin === undefined ? {} : { stdin }),
	});
	return {
		details: readRecord(result.details),
		isError: result.isError === true,
		text: readString(readRecord(result.content.at(0)).text),
	};
}

/** Opens START_URL in a fresh harness, then hands the test a tool caller and the native call log. */
async function withOwnStepFixture(run: (fixture: OwnStepFixture) => Promise<void>): Promise<void> {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-own-step-"));
	const paths = {
		log: join(tempDir, "invocations.log"),
		scenario: join(tempDir, "scenario.json"),
		state: join(tempDir, "page-state.json"),
	};
	await writeFakeAgentBrowserBinary(tempDir, fakeUpstreamScript(paths));
	try {
		await withPatchedEnv({ PATH: `${tempDir}:${process.env.PATH ?? ""}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Inspect a page." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const opened = await callTool(harness, ["open", START_URL]);
			assert.equal(opened.isError, false, opened.text);
			let seen = (await readInvocationLog(paths.log)).length;
			await run({
				call: (args, stdin) => callTool(harness, args, stdin),
				nativeCommands: async () => {
					const entries = await readInvocationLog(paths.log);
					const fresh = entries.slice(seen).map((entry) => entry.args.join(" "));
					seen = entries.length;
					return fresh.filter((command) => !command.startsWith("session"));
				},
				setScenario: (scenario) => writeFile(paths.scenario, JSON.stringify(scenario)),
			});
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
}

function nextActionIds(details: Record<string, unknown>): string[] {
	return readArray(details.nextActions ?? []).map((action) => readString(readRecord(action).id));
}

nodeTest(
	"agentBrowserExtension lets content follow a reload that reports its own URL",
	async () => {
		await withOwnStepFixture(async ({ call, nativeCommands }) => {
			const reloaded = await call(["reload"]);
			assert.equal(reloaded.isError, false, reloaded.text);
			assert.equal(reloaded.details.sessionTabTargetUnknown, undefined);
			assert.equal(reloaded.details.pageVerification, undefined);
			assert.ok(reloaded.text.startsWith(START_URL), reloaded.text);
			// The reload row already carries the URL, so no second URL read is spent on it.
			assert.deepEqual(await nativeCommands(), ["reload", "tab list"]);

			const content = await call(["get", "text", "#h"]);
			assert.equal(content.isError, false, content.text);
			assert.match(content.text, /content of https:\/\/example\.test\/a/);
		});
	},
);

nodeTest("agentBrowserExtension reports a URL changed by its own eval first", async () => {
	await withOwnStepFixture(async ({ call, setScenario }) => {
		await setScenario({ evalUrl: OTHER_URL });
		const evaluated = await call(["eval", "--stdin"], "location.href = '/b'");
		assert.equal(evaluated.isError, false, evaluated.text);
		assert.ok(
			evaluated.text.startsWith(
				`Page URL changed during this call: ${START_URL} -> ${OTHER_URL}. Later page commands act on the new page.\n\n`,
			),
			evaluated.text,
		);
		assert.deepEqual(evaluated.details.pageVerification, {
			command: "eval",
			priorUrl: START_URL,
			status: "changed",
			url: OTHER_URL,
		});

		const content = await call(["get", "text", "#h"]);
		assert.equal(content.isError, false, content.text);
		assert.match(content.text, /content of https:\/\/example\.test\/b/);
	});
});

nodeTest(
	"agentBrowserExtension keeps the page unverified when its own step ends on an error page",
	async (t) => {
		for (const step of [
			{ args: ["reload"], scenario: { reloadUrl: ERROR_URL } },
			{ args: ["eval", "--stdin"], scenario: { evalUrl: ERROR_URL }, stdin: "location.reload()" },
		] as const) {
			await t.test(step.args[0], async () => {
				await withOwnStepFixture(async ({ call, setScenario }) => {
					await setScenario(step.scenario);
					const result = await call(step.args, "stdin" in step ? step.stdin : undefined);
					assert.equal(result.isError, false, result.text);
					assert.ok(
						result.text.startsWith(
							`Page not verified: the browser shows an error page (${ERROR_URL}) after ${step.args[0]}. Run get url or navigate explicitly before page-content inspection.\n\n`,
						),
						result.text,
					);
					assert.equal(result.details.sessionTabTargetUnknown, true);
					assert.deepEqual(result.details.pageVerification, {
						command: step.args[0],
						status: "error-page",
						url: ERROR_URL,
					});
					// A snapshot would be refused, so the follow-up offered is the URL read.
					assert.deepEqual(nextActionIds(result.details), ["verify-page-target-after-own-step"]);

					const refused = await call(["get", "text", "body"]);
					assert.equal(refused.isError, true);
					assert.match(refused.text, UNVERIFIED);

					// The agent's own look at the URL still clears the guard.
					const url = await call(["get", "url"]);
					assert.equal(url.isError, false, url.text);
					assert.ok(url.text.startsWith(ERROR_URL), url.text);
					const allowed = await call(["get", "text", "body"]);
					assert.equal(allowed.isError, false, allowed.text);
				});
			});
		}
	},
);

nodeTest(
	"agentBrowserExtension keeps the page unverified when the URL cannot be read after its own step",
	async (t) => {
		for (const step of [
			{
				args: ["eval", "--stdin"],
				scenario: { getUrlFailsAfterEval: true },
				stdin: "document.title",
			},
			// Native reload reports an empty URL when its own URL read fails.
			{ args: ["reload"], scenario: { reloadUrl: "" } },
		] as const) {
			await t.test(step.args[0], async () => {
				await withOwnStepFixture(async ({ call, setScenario }) => {
					await setScenario(step.scenario);
					const result = await call(step.args, "stdin" in step ? step.stdin : undefined);
					assert.equal(result.isError, false, result.text);
					assert.ok(
						result.text.startsWith(
							`Page not verified: the current URL could not be read after ${step.args[0]}. Run get url or navigate explicitly before page-content inspection.\n\n`,
						),
						result.text,
					);
					assert.equal(result.details.sessionTabTargetUnknown, true);
					assert.deepEqual(result.details.pageVerification, {
						command: step.args[0],
						status: "unreadable",
					});

					const refused = await call(["get", "text", "#h"]);
					assert.equal(refused.isError, true);
					assert.match(refused.text, UNVERIFIED);
				});
			});
		}
	},
);

nodeTest("agentBrowserExtension puts the own-step page notice in JSON warnings", async () => {
	await withOwnStepFixture(async ({ call, setScenario }) => {
		await setScenario({ reloadUrl: ERROR_URL });
		const reloaded = await call(["--json", "reload"]);
		const payload = readRecord(JSON.parse(reloaded.text));
		assert.deepEqual(payload.warnings, [
			`Page not verified: the browser shows an error page (${ERROR_URL}) after reload. Run get url or navigate explicitly before page-content inspection.`,
		]);
	});
});

nodeTest(
	"agentBrowserExtension runs a --bail batch that reads content after its own eval or reload",
	async (t) => {
		for (const ownStep of [["eval", "document.title"], ["reload"]]) {
			const stdin = JSON.stringify([ownStep, ["get", "text", "#h"]]);
			await t.test(ownStep[0] ?? "", async () => {
				await withOwnStepFixture(async ({ call, nativeCommands }) => {
					const refused = await call(["batch"], stdin);
					assert.equal(refused.isError, true);
					assert.match(refused.text, /must use exact batch --bail/);
					assert.deepEqual(await nativeCommands(), []);

					const batch = await call(["batch", "--bail"], stdin);
					assert.equal(batch.isError, false, batch.text);
					assert.match(batch.text, /content of https:\/\/example\.test\/a/);
					assert.equal(batch.details.sessionTabTargetUnknown, undefined);
					assert.ok((await nativeCommands()).includes("batch --bail"));

					const content = await call(["get", "text", "#h"]);
					assert.equal(content.isError, false, content.text);
				});
			});
		}
	},
);

nodeTest(
	"agentBrowserExtension reports an error page reached inside a batch and keeps it unverified",
	async () => {
		await withOwnStepFixture(async ({ call, setScenario }) => {
			await setScenario({ reloadUrl: ERROR_URL });
			const batch = await call(
				["batch", "--bail"],
				JSON.stringify([["reload"], ["get", "text", "body"]]),
			);
			assert.ok(
				batch.text.startsWith(
					`Page not verified: the browser shows an error page (${ERROR_URL}) after reload.`,
				),
				batch.text,
			);
			assert.equal(batch.details.sessionTabTargetUnknown, true);
			const refused = await call(["get", "text", "body"]);
			assert.equal(refused.isError, true);
			assert.match(refused.text, UNVERIFIED);
		});
	},
);

nodeTest(
	"agentBrowserExtension leaves a batch with the agent's own get url row to that row",
	async () => {
		await withOwnStepFixture(async ({ call, setScenario }) => {
			await setScenario({ reloadUrl: ERROR_URL });
			const batch = await call(
				["batch", "--bail"],
				JSON.stringify([["reload"], ["get", "url"], ["get", "text", "body"]]),
			);
			assert.equal(batch.isError, false, batch.text);
			assert.equal(batch.details.pageVerification, undefined);
			assert.equal(batch.details.sessionTabTargetUnknown, undefined);
			assert.doesNotMatch(batch.text, /Page not verified/);
		});
	},
);

nodeTest("agentBrowserExtension invalidates refs taken before a reload", async () => {
	await withOwnStepFixture(async ({ call, nativeCommands }) => {
		const snapshot = await call(["snapshot", "-i"]);
		assert.equal(snapshot.isError, false, snapshot.text);
		assert.equal((await call(["reload"])).isError, false);
		await nativeCommands();

		const stale = await call(["click", "@e1"]);
		assert.equal(stale.isError, true);
		assert.match(stale.text, /Ref @e1 cannot be used yet\. A reload replaced the document/);
		assert.deepEqual(await nativeCommands(), []);
	});
});

nodeTest("agentBrowserExtension keeps the get url rule after a history step", async () => {
	await withOwnStepFixture(async ({ call }) => {
		const back = await call(["back"]);
		assert.equal(back.isError, false, back.text);
		assert.equal(back.details.sessionTabTargetUnknown, true);
		const content = await call(["get", "text", "#h"]);
		assert.equal(content.isError, true);
		assert.match(content.text, UNVERIFIED);
		const evaluated = await call(["eval", "document.title"]);
		assert.equal(evaluated.isError, true);
		assert.match(evaluated.text, UNVERIFIED);
	});
});
