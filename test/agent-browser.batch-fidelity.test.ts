import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES, GLOBAL_VALUE_FLAGS, VALUE_FLAGS } from "../extensions/agent-browser/lib/argv-grammar.js";
import { TARGET_AGENT_BROWSER_VERSION } from "../scripts/agent-browser-target.mjs";
import { getGuardedRefUsage, shouldPinSessionTabForCommand } from "../extensions/agent-browser/lib/orchestration/browser-run/session-state.js";
import { getPageTargetValidationError } from "../extensions/agent-browser/lib/page-target-validation.js";
import { runAgentBrowserProcess } from "../extensions/agent-browser/lib/process.js";
import {
	createExtensionHarness,
	createToolBranchEntry,
	executeRegisteredTool,
	runExtensionEvent,
	runExtensionEventResults,
	startAgentBrowserContractFixtureServer,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

test("global argv flags match the audited upstream grammar baseline", async () => {
	const grammar = JSON.parse(await readFile(new URL("./fixtures/agent-browser-argv-grammar.json", import.meta.url), "utf8"));
	assert.equal(grammar.version, TARGET_AGENT_BROWSER_VERSION, "Re-audit flags.rs clean_args when rebaselining upstream");
	assert.deepEqual(new Set(GLOBAL_VALUE_FLAGS), new Set(grammar.globalValueFlags));
	assert.deepEqual(GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES, new Set(grammar.globalBooleanFlags));
	for (const flag of grammar.globalValueFlags) assert.equal(VALUE_FLAGS.has(flag), true, flag);
});

test("ref guards follow upstream selector slots, not literal operands or key/mouse data", () => {
	for (const ref of ["@e1", "e1", "ref=e1", " ref=e1 "]) {
		for (const args of [["fill", ref, "text"], ...["text", "html", "value", "attr", "box", "styles"].map((getter) => ["get", getter, ref]), ["drag", "#source", ref], ["click", "--new-tab", ref], ["scroll", "down", "--selector", ref], ["diff", "screenshot", "-s", ref]]) {
			assert.deepEqual(getGuardedRefUsage(args), ["e1"], JSON.stringify(args));
		}
	}
	for (const args of [
		["fill", "#field", "@e1"], ["type", "#field", "ref=e1"], ["select", "#field", "e1"],
		["download", "#link", "@e1"], ["upload", "#field", "@e1"], ["get", "attr", "#field", "@e1"],
		["press", "@e1"], ["key", "@e1"], ["keyboard", "inserttext", "@e1"], ["mouse", "wheel", "@e1"],
		["screenshot", "#field", "@e1"], ["diff", "screenshot", "-b", "@e1", "-o", "@e2"],
		["click", "@e1-suffix"], ["scroll", "@e1"], ["get", "url", "@e1"],
		["get", "count", "e999"], ["diff", "snapshot", "--selector", "e999"], ["diff", "snapshot", "-s", "@e999"],
	]) assert.deepEqual(getGuardedRefUsage(args), [], JSON.stringify(args));
});

test("tab pinning leaves explicit recovery available but still guards content after read-only batch prefixes", () => {
	for (const first of [["tab", "list"], ["tab"], ["session", "info"], ["get", "url"]]) {
		assert.equal(shouldPinSessionTabForCommand({ command: "batch", commandTokens: ["batch"], stdin: JSON.stringify([first, ["fill", "#field", "text"]]), pinningRequired: true, sessionName: "named" }), true);
	}
	for (const first of [["tab", "t1"], ["tab", "new", "about:blank"], ["open", "about:blank"], ["close"], ["connect", "9222"], ["state", "load", "state.json"]]) {
		assert.equal(shouldPinSessionTabForCommand({ command: "batch", commandTokens: ["batch"], stdin: JSON.stringify([first, ["get", "url"]]), pinningRequired: true, sessionName: "named" }), false);
	}
	for (const commandTokens of [["get", "url"], ["skills", "list"], ["auth", "save", "fixture", "--url", "https://example.test/", "--username", "fixture", "--password-stdin"], ["connect", "9222"], ["state", "load", "state.json"]]) {
		assert.equal(shouldPinSessionTabForCommand({ command: commandTokens[0], commandTokens, pinningRequired: true, sessionName: "named" }), false);
	}
});

test("history and page actions still require the intended tab", () => {
	for (const commandTokens of [["back"], ["forward"], ["reload"], ["click", "#field"], ["frame", "#child"]]) {
		assert.equal(shouldPinSessionTabForCommand({ command: commandTokens[0], commandTokens, pinningRequired: true, sessionName: "named" }), true);
	}
});

test("unsupported batch bail assignment explains raw argv precedence without recovering ignored stdin", () => {
	for (const pageUrlUnknown of [false, true]) {
		assert.match(getPageTargetValidationError({ args: ["batch", "--bail=true"], stdin: '[["get","url"]]', pageUrlUnknown }) ?? "", /exact.*--bail.*stdin.*ignored/i);
	}
	assert.equal(getPageTargetValidationError({ args: ["batch", "fill '#field' '--bail=true'"], pageUrlUnknown: false }), undefined);
});

const real = process.env.PI_AGENT_BROWSER_REAL_UPSTREAM === "1";
test("real upstream batch argv and ref fidelity for pinned and unpinned registered tools", { skip: !real, timeout: 180_000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "bf-"));
	const socketDir = join(dir, "s");
	await mkdir(socketDir, { mode: 0o700 });
	const browserBin = join(dir, "bin");
	await mkdir(browserBin);
	if (process.platform === "linux" && process.env.AGENT_BROWSER_EXECUTABLE_PATH) {
		await symlink(process.env.AGENT_BROWSER_EXECUTABLE_PATH, join(browserBin, "google-chrome"));
	}
	const fixture = await startAgentBrowserContractFixtureServer();
	const url = `${fixture.baseUrl}/contract`;
	const target = { title: "Agent Browser Contract Fixture", url };
	try {
		await withPatchedEnv({
			HOME: dir, USERPROFILE: dir, PI_CODING_AGENT_DIR: join(dir, "pi"),
			PI_AGENT_BROWSER_SOCKET_DIR: socketDir, AGENT_BROWSER_SOCKET_DIR: socketDir,
			AGENT_BROWSER_CONFIG: undefined, AGENT_BROWSER_NAMESPACE: undefined,
			AGENT_BROWSER_PROFILE: undefined, AGENT_BROWSER_RESTORE: undefined,
			AGENT_BROWSER_CDP: undefined, AGENT_BROWSER_AUTO_CONNECT: undefined,
			// Native browser discovery avoids passive launch flags reconfiguring the CDP fixture.
			AGENT_BROWSER_EXECUTABLE_PATH: undefined,
			PATH: `${browserBin}${delimiter}${process.env.PATH}`,
		}, async () => {
			for (const pinned of [false, true]) {
				const sessionName = `bf-${randomUUID().slice(0, 8)}`;
				const namespace = `bf-${randomUUID().slice(0, 8)}`;
				const prefix = ["--namespace", namespace, "--session", sessionName];
				const extraSessions: string[] = [];
				const direct = (args: string[], stdin?: string) => runAgentBrowserProcess({ args: ["--json", ...prefix, ...args], cwd: dir, stdin });
				const opened = await direct(["open", url]);
				assert.equal(opened.exitCode, 0, opened.stderr);
				const makeHarness = async (extraDetails: Record<string, unknown> = {}) => {
					const h = createExtensionHarness({ cwd: dir, sessionId: randomUUID(), branch: pinned ? [createToolBranchEntry({ details: { args: [...prefix, "open", url], command: "open", namespace, sessionName, sessionTabTarget: target, ...extraDetails }, isError: false })] : [] });
					await runExtensionEvent(h.handlers, "session_start", { reason: pinned ? "resume" : "new" }, h.ctx);
					return h;
				};
				let h = await makeHarness();
				if (pinned) await direct(["tab", "new", `${fixture.baseUrl}/next`]);
				const call = (args: string[], stdin?: string) => executeRegisteredTool(h.tool, h.ctx, { args: [...prefix, ...args], stdin });
				const keepActiveTab = async () => {
					const tabs = JSON.parse((await direct(["tab", "list"])).stdout).data.tabs;
					for (const tab of tabs) if (!tab.active) {
						const closed = await direct(["tab", "close", tab.tabId]);
						assert.equal(closed.exitCode, 0, JSON.stringify(closed));
					}
				};
				const label = pinned ? "pinned" : "unpinned";
				try {
					await t.test(`${label}: same-tab ref spellings remain usable and text stays literal`, async () => {
						const snapshot = await call(["snapshot", "-i"]);
						assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
						const refs = (snapshot.details?.refSnapshot as { refs: Record<string, { name: string }> }).refs;
						const id = Object.entries(refs).find(([, ref]) => ref.name === "Name")?.[0];
						assert.ok(id, JSON.stringify(refs));
						for (const ref of [`@${id}`, id, `ref=${id}`]) {
							const filled = await call(["fill", ref, "--bail"]);
							assert.equal(filled.isError, false, JSON.stringify(filled));
							assert.deepEqual(filled.details?.effectiveArgs, ["--json", ...prefix, "fill", ref, "--bail"]);
						}
						for (const text of ["@e999", "e999", "ref=e999", "--bail=true"]) {
							assert.equal((await call(["fill", "#name-input", text])).isError, false);
							const value = await direct(["get", "value", "#name-input"]);
							assert.equal(JSON.parse(value.stdout).data.value, text);
						}
					});
					await t.test(`${label}: mixed failures retain rows, failure category and native Pi hook`, async () => {
						for (const bail of [false, true]) {
							if (pinned) assert.equal((await direct(["tab", "new", `${fixture.baseUrl}/next`])).exitCode, 0);
							const steps = [["fill", "#name-input", "before"], ["not-a-command"], ["fill", "#name-input", "after"]];
							const result = await call(["batch", ...(bail ? ["--bail"] : [])], JSON.stringify(steps));
							assert.equal(result.isError, true, JSON.stringify(result));
							assert.equal(result.details?.resultCategory, "failure");
							const rows = result.details?.batchSteps as Array<{ index: number; success: boolean }>;
							assert.equal(rows?.length, bail ? 2 : 3, JSON.stringify(result));
							assert.deepEqual(rows.map((row) => row.success), bail ? [true, false] : [true, false, true]);
							assert.equal((result.details?.batchFailure as { failedStep: { index: number } }).failedStep.index, 1);
							assert.match(result.content[0]?.text ?? "", /Batch failed:/);
							const patches = await runExtensionEventResults<{ isError?: boolean }>(h.handlers, "tool_result", { toolName: "agent_browser", toolCallId: "fixture", input: { args: [...prefix, "batch"] }, ...result, isError: false }, h.ctx);
							assert.equal(patches[0]?.isError, true);
							assert.equal(JSON.parse((await direct(["get", "value", "#name-input"])).stdout).data.value, bail ? "before" : "after");
						}
					});
					await t.test(`${label}: global headers and explicit native pin preferences survive dispatch`, async () => {
						if (pinned) assert.equal((await direct(["tab", "new", `${fixture.baseUrl}/next`])).exitCode, 0);
						const args = ["--headers", '{"x-fixture":"batch-fidelity"}', "--no-pin-tab", "batch", "--bail"];
						const result = await call(args, JSON.stringify([["open", `${fixture.baseUrl}/headers`], ["get", "value", "#header-value"]]));
						assert.equal(result.isError, false, JSON.stringify(result));
						assert.deepEqual(result.details?.effectiveArgs, ["--json", ...prefix, ...args.map((arg) => arg.startsWith("{") ? "[REDACTED]" : arg)]);
						assert.equal(JSON.parse((await direct(["get", "value", "#header-value"])).stdout).data.value, "present");
						assert.equal((await call(["open", url])).isError, false);
					});
					await t.test(`${label}: raw argv wins over stdin and command timeout stays native`, async () => {
						const result = await call(["batch", "fill '#name-input' 'raw text'"], '[["fill","#name-input","ignored"]]');
						assert.equal(result.isError, false, JSON.stringify(result));
						assert.equal(JSON.parse((await direct(["get", "value", "#name-input"])).stdout).data.value, "raw text");
						const misplacedTimeout = await call(["--timeout", "50", "fill", "#name-input", "must-not-run"]);
						assert.equal(misplacedTimeout.isError, true, JSON.stringify(misplacedTimeout));
						assert.deepEqual(misplacedTimeout.details?.effectiveArgs, ["--json", ...prefix, "--timeout", "50", "fill", "#name-input", "must-not-run"]);
						assert.equal(JSON.parse((await direct(["get", "value", "#name-input"])).stdout).data.value, "raw text");
						const wait = await call(["wait", "--text", "not present in fixture", "--timeout", "50"]);
						assert.equal(wait.isError, true);
						assert.deepEqual(wait.details?.effectiveArgs, ["--json", ...prefix, "wait", "--text", "not present in fixture", "--timeout", "50"]);
						const bad = await call(["batch", "--bail=true"], '[["fill","#name-input","ignored"]]');
						assert.match(bad.content[0]?.text ?? "", /exact.*--bail.*stdin.*ignored/i);
						assert.equal(bad.details?.exitCode, undefined);
					});
					await t.test(`${label}: stale spellings reject before upstream and key/mouse literals are not refs`, async () => {
						await call(["snapshot", "-i"]);
						for (const ref of ["@e999", "e999", "ref=e999"]) {
							const stale = await call(["fill", ref, "wrong"]);
							assert.equal(stale.details?.failureCategory, "stale-ref", JSON.stringify(stale));
							assert.equal(stale.details?.exitCode, undefined);
						}
						await call(["focus", "#name-input"]);
						for (const args of [["keyboard", "inserttext", "@e999"], ["press", "@e999"], ["key", "@e999"], ["mouse", "wheel", "@e999"]]) {
							const result = await call(args);
							assert.notEqual(result.details?.failureCategory, "stale-ref", JSON.stringify(result));
							assert.equal(result.details?.agentBrowserStarted, true, JSON.stringify(result));
						}
					});
					await t.test(`${label}: CSS-only selectors remain literal while ref consumers stay guarded`, async (css) => {
						assert.equal((await call(["open", url])).isError, false);
						assert.equal((await direct(["eval", "document.body.insertAdjacentHTML('beforeend', '<e999><p>Literal subtree</p></e999>')"])).exitCode, 0);
						assert.equal((await call(["snapshot", "-i"])).isError, false);
						await css.test("get count treats bare eN as a CSS tag", async () => {
							for (const [selector, count] of [["e999", 1], ["e998", 0]] as const) {
								const native = await direct(["get", "count", selector]);
								assert.equal(native.exitCode, 0, native.stderr);
								assert.equal(JSON.parse(native.stdout).data.count, count);
								const counted = await call(["get", "count", selector]);
								assert.equal(counted.isError, false, JSON.stringify(counted));
								assert.equal((counted.details?.data as { count: number }).count, count);
							}
						});
						await css.test("diff snapshot treats bare eN as a CSS subtree", async () => {
							const args = ["diff", "snapshot", "--selector", "e999"];
							const native = await direct(args);
							assert.equal(native.exitCode, 0, native.stderr);
							assert.match(JSON.parse(native.stdout).data.diff, /Literal subtree/);
							const compared = await call(args);
							assert.equal(compared.isError, false, JSON.stringify(compared));
							assert.match((compared.details?.data as { diff: string }).diff, /Literal subtree/);
						});
						await css.test("ref-resolving getters and diff screenshot still reject absent refs", async () => {
							assert.equal((await call(["snapshot", "-i"])).isError, false);
							for (const args of [
								...["text", "html", "value", "box", "styles"].map((getter) => ["get", getter, "e999"]),
								["get", "attr", "e999", "id"],
								["diff", "screenshot", "--baseline", join(dir, "unused.png"), "--selector", "e999"],
							]) {
								const stale = await call(args);
								assert.equal(stale.details?.failureCategory, "stale-ref", JSON.stringify(stale));
								assert.equal(stale.details?.exitCode, undefined);
							}
						});
					});
					if (pinned) await t.test("pinned: same-URL tabs retain the known titled target", async () => {
						await keepActiveTab();
						await direct(["open", url]);
						const originalTabs = JSON.parse((await direct(["tab", "list"])).stdout).data.tabs;
						const originalTab = originalTabs.find((tab: { active: boolean }) => tab.active);
						const original = originalTab.tabId;
						h = await makeHarness({ sessionTabTarget: { title: originalTab.title, url } });
						await direct(["tab", "new", url]);
						await direct(["eval", "document.title = 'Different tab'"]);
						const duplicateTabs = JSON.parse((await direct(["tab", "list"])).stdout).data.tabs;
						const duplicate = duplicateTabs.find((tab: { active: boolean }) => tab.active).tabId;
						await direct(["tab", duplicate]); // Native selection refreshes the cached tab title.
						assert.equal(JSON.parse((await direct(["tab", "list"])).stdout).data.tabs.find((tab: { tabId: string }) => tab.tabId === duplicate).title, "Different tab");
						const filled = await call(["fill", "#name-input", "intended"]);
						assert.equal(filled.isError, false, JSON.stringify(filled));
						assert.equal((filled.details?.sessionTabCorrection as { selectedTab: string } | undefined)?.selectedTab, original, JSON.stringify({ original, duplicate, originalTabs, duplicateTabs, filled }));
						await direct(["tab", duplicate]);
						assert.equal(JSON.parse((await direct(["get", "value", "#name-input"])).stdout).data.value, "");
						await direct(["tab", original]);
					});
					if (pinned) await t.test("pinned: actual tab switch refreshes refs before same-page actions", async () => {
						const snapshot = await call(["snapshot", "-i"]);
						const refs = (snapshot.details?.refSnapshot as { refs: Record<string, { name: string }> }).refs;
						const id = Object.entries(refs).find(([, ref]) => ref.name === "Name")?.[0];
						assert.ok(id);
						await direct(["tab", "new", `${fixture.baseUrl}/next`]);
						const filled = await call(["fill", `ref=${id}`, "switched"]);
						assert.equal(filled.isError, false, JSON.stringify(filled));
						assert.ok(filled.details?.sessionTabCorrection);
						assert.equal(JSON.parse((await direct(["get", "value", "#name-input"])).stdout).data.value, "switched");
					});
					if (pinned && process.platform !== "win32") await t.test("pinned: native selection failure and post-selection mismatch execute zero user steps", async () => {
						const binary = execFileSync("which", ["agent-browser"], { encoding: "utf8" }).trim();
						const shimDir = join(dir, "shim");
						await mkdir(shimDir);
						const modeFile = join(shimDir, "fault");
						await writeFakeAgentBrowserBinary(shimDir, `const fs = require('node:fs'); const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2), input = fs.readFileSync(0, 'utf8'), i = args.indexOf('tab');
const run = (a) => spawnSync(${JSON.stringify(binary)}, a, { input, encoding: 'utf8' });
const fault = fs.existsSync(${JSON.stringify(modeFile)}) ? fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8') : '';
if (fault && i >= 0 && args[i+1] !== 'list' && args[i+1] !== 'new' && args[i+1] !== 'close') {
 fs.unlinkSync(${JSON.stringify(modeFile)});
 if (fault === 'gone') run([...args.slice(0, i), 'tab', 'close', args[i+1]]);
}
const result = run(args);
if (fault === 'mismatch' && i >= 0 && args[i+1] !== 'list') run([...args.slice(0,i), 'tab', 'new', ${JSON.stringify(`${fixture.baseUrl}/next`)}]);
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);`);
						for (const fault of ["mismatch", "gone"]) {
							await direct(["open", url]);
							h = await makeHarness();
							await direct(["tab", "new", `${fixture.baseUrl}/next`]);
							await writeFile(modeFile, fault);
							await withPatchedEnv({ PATH: `${shimDir}:${process.env.PATH}` }, async () => {
								const blocked = await call(["batch"], '[["eval","document.body.dataset.wrong=1"]]');
								assert.equal(blocked.details?.failureCategory, "tab-drift", JSON.stringify(blocked));
								assert.equal(blocked.details?.exitCode, undefined);
							});
							assert.equal(JSON.parse((await direct(["eval", "document.body.dataset.wrong || 'untouched'"])).stdout).data.result, "untouched");
						}
						await direct(["open", url]);
					});
					if (pinned) await t.test("pinned: explicit connect replaces the target and failed recovery preserves batch flow", async () => {
						assert.equal((await direct(["close"])).exitCode, 0);
						const sourceSession = `cdp-${randomUUID().slice(0, 8)}`;
						extraSessions.push(sourceSession);
						const source = (args: string[]) => runAgentBrowserProcess({ args: ["--json", "--namespace", namespace, "--session", sourceSession, ...args], cwd: dir });
						const openedSource = await source(["open", url]);
						assert.equal(openedSource.exitCode, 0, JSON.stringify(openedSource));
						const endpoint = JSON.parse((await source(["get", "cdp-url"])).stdout).data.cdpUrl;
						assert.equal(typeof endpoint, "string");
						h = await makeHarness({ sessionTabTarget: { url: `${fixture.baseUrl}/missing-target` } });
						const connected = await call(["connect", endpoint]);
						assert.equal(connected.isError, false, JSON.stringify(connected));
						assert.equal(connected.details?.refSnapshot, undefined);
						assert.equal((await call(["get", "url"])).isError, false);
						const attachedTabs = await call(["tab", "list"]);
						const attachedTab = (attachedTabs.details?.data as { tabs: Array<{ tabId: string; url: string }> }).tabs.find((tab) => tab.url === url);
						assert.ok(attachedTab, JSON.stringify(attachedTabs));
						assert.equal((await call(["tab", attachedTab.tabId])).isError, false);
						assert.equal((await call(["snapshot", "-i"])).isError, false);
						const filledConnected = await call(["fill", "#name-input", "connected"]);
						assert.equal(filledConnected.isError, false, JSON.stringify(filledConnected));
						assert.equal(JSON.parse((await source(["get", "value", "#name-input"])).stdout).data.value, "connected");
						const unsafe = await call(["batch"], JSON.stringify([["connect", "1"], ["fill", "#name-input", "must-not-run"]]));
						assert.match(String(unsafe.details?.validationError), /unverified|batch --bail/);
						assert.equal(unsafe.details?.exitCode, undefined);
						h = await makeHarness({ sessionTabTarget: { url: `${fixture.baseUrl}/missing-target` } });
						const failed = await call(["batch"], JSON.stringify([["connect", "1"], ["get", "url"]]));
						assert.equal(failed.isError, true);
						assert.deepEqual((failed.details?.batchSteps as Array<{ success: boolean }>).map((row) => row.success), [false, true]);
					});
					if (pinned) await t.test("pinned: explicit state replay verifies the new page without inventing fresh refs", async () => {
						await direct(["open", `${fixture.baseUrl}/next`]);
						const statePath = join(dir, "fixture-state.json");
						await writeFile(statePath, JSON.stringify({ cookies: [], origins: [{ origin: fixture.baseUrl, localStorage: [{ name: "fidelity", value: "loaded" }] }] }));
						h = await makeHarness({ sessionTabTarget: { url: `${fixture.baseUrl}/missing-target` } });
						const loaded = await call(["state", "load", statePath]);
						assert.equal(loaded.isError, false, JSON.stringify(loaded));
						assert.equal(loaded.details?.refSnapshot, undefined);
						assert.equal((await call(["get", "url"])).isError, false);
						assert.equal(JSON.parse((await direct(["eval", "localStorage.getItem('fidelity')"])).stdout).data.result, "loaded");
						const unsafe = await call(["batch"], JSON.stringify([["state", "load", `${statePath}.missing`], ["fill", "#name-input", "must-not-run"]]));
						assert.match(String(unsafe.details?.validationError), /unverified|batch --bail/);
						assert.equal(unsafe.details?.exitCode, undefined);
						h = await makeHarness({ sessionTabTarget: { url: `${fixture.baseUrl}/missing-target` } });
						const failed = await call(["batch"], JSON.stringify([["state", "load", `${statePath}.missing`], ["get", "url"]]));
						assert.equal(failed.isError, true);
						assert.deepEqual((failed.details?.batchSteps as Array<{ success: boolean }>).map((row) => row.success), [false, true]);
						h = await makeHarness({ sessionTabTarget: { url: `${fixture.baseUrl}/missing-target` } });
						const replay = await call(["batch", "--bail"], JSON.stringify([["state", "load", statePath], ["get", "url"], ["snapshot", "-i"]]));
						assert.equal(replay.isError, false, JSON.stringify(replay));
						assert.ok(replay.details?.refSnapshot);
					});
					if (pinned) await t.test("pinned: sessionless commands do not require the prior page", async (local) => {
						h = await makeHarness({ sessionTabTarget: { url: `${fixture.baseUrl}/missing-target` } });
						const skills = await call(["skills", "list"]);
						assert.equal(skills.isError, false, JSON.stringify(skills));
						assert.deepEqual(skills.details?.effectiveArgs, ["--json", ...prefix, "skills", "list"]);
						for (const readOnly of [undefined, ["tab", "list"], ["tab"], ["get", "url"]]) {
							await local.test(`then ${readOnly?.join(" ") ?? "direct fill"} preserves the intended tab`, async () => {
								await keepActiveTab();
								assert.equal((await direct(["open", url])).exitCode, 0);
								const intended = JSON.parse((await direct(["tab", "list"])).stdout).data.tabs.find((tab: { active: boolean }) => tab.active).tabId;
								assert.equal((await direct(["tab", "new", `${url}?other-tab`])).exitCode, 0);
								const other = JSON.parse((await direct(["tab", "list"])).stdout).data.tabs.find((tab: { active: boolean }) => tab.active).tabId;
								assert.equal((await direct(["fill", "#name-input", "untouched"])).exitCode, 0);
								h = await makeHarness();
								assert.equal((await call(["skills", "list"])).isError, false);
								const fill = ["fill", "#name-input", "intended"];
								const filled = readOnly ? await call(["batch"], JSON.stringify([readOnly, fill])) : await call(fill);
								assert.equal(filled.isError, false, JSON.stringify(filled));
								assert.equal((await direct(["tab", other])).exitCode, 0);
								assert.equal(JSON.parse((await direct(["get", "value", "#name-input"])).stdout).data.value, "untouched", "local success must not let a later action mutate the other tab");
								assert.equal((await direct(["tab", intended])).exitCode, 0);
								assert.equal(JSON.parse((await direct(["get", "value", "#name-input"])).stdout).data.value, "intended");
							});
						}
						await local.test("auth metadata cannot replace the intended page for a later action", async () => {
							await keepActiveTab();
							assert.equal((await direct(["open", url])).exitCode, 0);
							const intended = JSON.parse((await direct(["tab", "list"])).stdout).data.tabs.find((tab: { active: boolean }) => tab.active).tabId;
							assert.equal((await direct(["tab", "new", `${url}?other-tab`])).exitCode, 0);
							const other = JSON.parse((await direct(["tab", "list"])).stdout).data.tabs.find((tab: { active: boolean }) => tab.active).tabId;
							assert.equal((await direct(["fill", "#name-input", "untouched"])).exitCode, 0);
							h = await makeHarness();
							const saved = await call(["auth", "save", "fixture", "--url", `${fixture.baseUrl}/auth-metadata`, "--username", "synthetic-user", "--password-stdin"], "synthetic-password");
							assert.equal(saved.isError, false, JSON.stringify(saved));
							const filled = await call(["fill", "#name-input", "intended"]);
							assert.equal(filled.isError, false, JSON.stringify(filled));
							assert.equal((await direct(["tab", other])).exitCode, 0);
							assert.equal(JSON.parse((await direct(["get", "value", "#name-input"])).stdout).data.value, "untouched", "local auth metadata must not let a later action mutate the other tab");
							assert.equal((await direct(["tab", intended])).exitCode, 0);
							assert.equal(JSON.parse((await direct(["get", "value", "#name-input"])).stdout).data.value, "intended");
							assert.equal((saved.details?.sessionTabTarget as { url: string }).url, url);
						});
						await local.test("explicit get url chooses the live page for subsequent content", async () => {
							await keepActiveTab();
							assert.equal((await direct(["open", `${url}?chosen-page`])).exitCode, 0);
							h = await makeHarness();
							assert.equal((await call(["skills", "list"])).isError, false);
							const verified = await call(["get", "url"]);
							assert.equal(verified.isError, false, JSON.stringify(verified));
							assert.equal((verified.details?.sessionTabTarget as { url: string }).url, `${url}?chosen-page`);
							assert.equal((await call(["fill", "#name-input", "chosen"])).isError, false);
							assert.equal(JSON.parse((await direct(["get", "value", "#name-input"])).stdout).data.value, "chosen");
						});
					});
					if (pinned) await t.test("pinned: missing intended tab runs zero user steps", async () => {
						await keepActiveTab();
						h = await makeHarness();
						const changedPage = await direct(["open", `${fixture.baseUrl}/next`]);
						assert.equal(changedPage.exitCode, 0, JSON.stringify(changedPage));
						const blocked = await call(["batch"], '[["eval","document.body.dataset.wrong=1"]]');
						assert.equal(blocked.isError, true, JSON.stringify(blocked));
						assert.equal(blocked.details?.failureCategory, "tab-drift");
						assert.equal(blocked.details?.exitCode, undefined);
						assert.equal(JSON.parse((await direct(["eval", "document.body.dataset.wrong || 'untouched'"])).stdout).data.result, "untouched");
						const recovered = await call(["batch", "--bail"], JSON.stringify([["tab", "new", url], ["get", "url"], ["snapshot", "-i"]]));
						assert.equal(recovered.isError, false, JSON.stringify(recovered));
					});
				} finally {
					assert.equal((await direct(["close"])).exitCode, 0);
					for (const extraSession of extraSessions) await runAgentBrowserProcess({ args: ["--json", "--namespace", namespace, "--session", extraSession, "close"], cwd: dir });
					await runExtensionEvent(h.handlers, "session_shutdown", { reason: "quit" }, h.ctx);
				}
			}
		});
	} finally {
		await fixture.close();
		await rm(dir, { force: true, recursive: true });
	}
});
