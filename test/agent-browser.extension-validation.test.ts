/**
 * Purpose: Verify extension entrypoint metadata, diagnostics, TUI rendering, and bash-blocking contracts.
 * Responsibilities: Assert metadata, prompt injection, bash blocking, CLI validation, missing binary, malformed envelope, fallback error, and oversized parse-failure behavior.
 * Scope: Integration-style Node test-runner coverage around the extension harness before result presentation and tab lifecycle suites.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-validation.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { readRecord, readString, readArray } from "./helpers/assertions.js";
import { existsSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { Check } from "typebox/value";

import {
	canonicalizeExplicitArtifactDestination,
	getExplicitArtifactDestination,
} from "../extensions/agent-browser/lib/orchestration/browser-run/artifact-paths.js";

import {
	createExtensionHarness,
	getBrowserInstructions,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	runExtensionEventResults,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
	type AgentBrowserToolParams,
} from "./helpers/agent-browser-harness.js";

import {
	PLAIN_RENDER_THEME,
	createRenderContext,
	isTestPidAlive,
} from "./helpers/extension-validation-fixtures.js";

test(
	"built extension prompt doc pointers resolve to package-root docs",
	{ skip: !existsSync(resolve("dist/extensions/agent-browser/index.js")) },
	async () => {
		const extension: unknown = await import(
			pathToFileURL(resolve("dist/extensions/agent-browser/index.js")).href
		);
		let beforeStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
		const pi = {
			events: {
				on: () => () => {
					/* No event bus listeners are exercised by prompt composition. */
				},
			},
			on: (name: string, handler: typeof beforeStart) => {
				if (name === "before_agent_start") {
					beforeStart = handler;
				}
			},
			registerTool: () => {
				/* This fixture exercises prompt hooks, not tool registration. */
			},
		};
		const factory = readRecord(extension).default;
		assert.ok(typeof factory === "function");
		Reflect.apply(factory, undefined, [pi]);

		const sections: Record<string, string> = {};
		const event = { systemPromptOptions: { sections } };
		assert.ok(beforeStart);
		await beforeStart(event, { cwd: process.cwd(), isProjectTrusted: () => true });
		const guideline = event.systemPromptOptions.sections.agent_browser
			.split("\n")
			.find((line) => line.includes("COMMAND_REFERENCE.md"));
		assert.ok(guideline !== undefined && guideline !== "");
		assert.doesNotMatch(guideline, /\/dist\/docs\//);
		for (const docsPath of [
			resolve("README.md"),
			resolve("docs/COMMAND_REFERENCE.md"),
			resolve("docs/TOOL_CONTRACT.md"),
		]) {
			// Both fixed documentation links must appear in the prompt.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.match(guideline, new RegExp(docsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			// Both fixed documentation links must also resolve on disk.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(existsSync(docsPath), true, `missing docs path ${docsPath}`);
		}
	},
);

test("agentBrowserExtension uses project browser launch guidance when project config shadows global", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-browser-project-shadow-guidance-test-"));
	try {
		const cwd = join(root, "repo");
		const isolatedHome = join(root, "home");
		const globalConfigPath = join(
			isolatedHome,
			".pi",
			"config",
			"pi-agent-browser-native",
			"config.json",
		);
		const projectConfigPath = join(cwd, ".pi", "config", "pi-agent-browser-native", "config.json");
		await mkdir(dirname(globalConfigPath), { recursive: true });
		await mkdir(dirname(projectConfigPath), { recursive: true });
		await writeFile(
			globalConfigPath,
			JSON.stringify(
				{
					version: 1,
					browser: {
						defaultProfile: { name: "Global Profile", policy: "authenticated-only" },
						executablePath: "/Applications/Global Browser.app/Contents/MacOS/Global Browser",
					},
				},
				null,
				2,
			),
			"utf8",
		);
		await withPatchedEnv({ HOME: isolatedHome, PI_AGENT_BROWSER_CONFIG: undefined }, async () => {
			const globalHarness = createExtensionHarness({ cwd });
			const globalGuidance = await getBrowserInstructions(globalHarness);
			assert.match(globalGuidance, /Global Profile/);
			assert.match(
				globalGuidance,
				/\/Applications\/Global Browser\.app\/Contents\/MacOS\/Global Browser/,
			);
			assert.match(globalGuidance, /browser\.executablePath/);
			assert.match(globalGuidance, /--executable-path/);
			assert.match(globalGuidance, /profiles lists Chrome profiles only/);
		});
		await writeFile(
			projectConfigPath,
			JSON.stringify(
				{
					version: 1,
					browser: {
						defaultProfile: { name: "Project Profile", policy: "authenticated-only" },
						executablePath: "/tmp/project-browser",
					},
				},
				null,
				2,
			),
			"utf8",
		);
		const previousCwd = process.cwd();
		process.chdir(cwd);
		try {
			await withPatchedEnv({ HOME: isolatedHome, PI_AGENT_BROWSER_CONFIG: undefined }, async () => {
				const harness = createExtensionHarness({ cwd });
				const staticGuidelineText = harness.tool.promptGuidelines.join("\n");
				assert.doesNotMatch(staticGuidelineText, /Project Profile/);
				assert.doesNotMatch(staticGuidelineText, /\/tmp\/project-browser/);
				assert.equal(staticGuidelineText, "", "no eager configuration guidelines");
				const sections: Record<string, string> = {};
				const browserTurn = {
					prompt: "Open https://example.com in the signed-in browser.",
					systemPrompt: "Base system prompt",
					systemPromptOptions: { sections },
				};
				await runExtensionEvent(harness.handlers, "before_agent_start", browserTurn, harness.ctx);
				assert.match(browserTurn.systemPromptOptions.sections.agent_browser, /Project Profile/);
				assert.match(
					browserTurn.systemPromptOptions.sections.agent_browser,
					/\/tmp\/project-browser/,
				);
				const guidelineText = await getBrowserInstructions(harness);
				assert.match(guidelineText, /Project Profile/);
				assert.match(guidelineText, /\/tmp\/project-browser/);
			});
		} finally {
			process.chdir(previousCwd);
		}
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rejects unsupported public schema fields", () => {
	const harness = createExtensionHarness({ cwd: process.cwd() });
	const schema = harness.tool.parameters;
	assert.equal(harness.tool.name, "agent_browser");
	assert.match(harness.tool.description, /native agent-browser commands/);
	assert.match(harness.tool.promptSnippet, /native command batches/);
	assert.match(harness.tool.description, /agent_browser_tools for advanced capabilities/);
	const parameterProperties = readRecord(readRecord(schema).properties);
	assert.deepEqual(Object.keys(parameterProperties).sort(), [
		"args",
		"outputPath",
		"sessionMode",
		"stdin",
		"timeoutMs",
	]);
	assert.match(readString(readRecord(parameterProperties.args).description), /batch --bail/);
	assert.match(
		readString(readRecord(parameterProperties.stdin).description),
		/batch JSON, eval --stdin.*auth save --password-stdin/,
	);
	assert.match(
		harness.getTool("agent_browser_code")?.description ?? "",
		/persistent browser.*emitImage/,
	);
	assert.match(
		harness.getTool("agent_browser_tools")?.description ?? "",
		/adds tools.*preserves other active tools/,
	);
	const direct = {
		args: ["open", "https://example.test/"],
		outputPath: "logs/page.json",
		timeoutMs: 35_000,
	};
	assert.equal(Check(schema, direct), true);
	assert.equal(Check(schema, { ...direct, unknown: true }), false);
	assert.equal(Check(schema, { ...direct, outputPath: "" }), false);
	assert.equal(Check(schema, { ...direct, timeoutMs: 0 }), false);
	assert.equal(
		Check(schema, {
			...direct,
			semanticAction: { action: "click", locator: "text", value: "Open" },
		}),
		false,
	);
	assert.equal(Check(schema, { ...direct, sourceLookup: { selector: "main" } }), false);
	assert.equal(
		Check(schema, { ...direct, networkSourceLookup: { url: "https://example.test/api" } }),
		false,
	);
	assert.equal(
		Check(schema, {
			...direct,
			job: { steps: [{ action: "open", url: "https://example.test/" }] },
		}),
		false,
	);

	const actionTool = harness.getTool("agent_browser_action");
	const sourceTool = harness.getTool("agent_browser_source");
	const networkTool = harness.getTool("agent_browser_network_source");
	assert.ok(actionTool);
	assert.ok(sourceTool);
	assert.ok(networkTool);
	const click = { action: "click", locator: "role", role: "button", name: "Open" };
	const select = { action: "select", selector: "#flavor", value: "chocolate" };
	const source = { selector: "main" };
	const network = { namespace: "review", url: "https://example.test/api" };
	assert.equal(Check(actionTool.parameters, click), true);
	assert.equal(Check(actionTool.parameters, { ...click, unknown: true }), false);
	assert.equal(Check(actionTool.parameters, { ...click, values: ["nope"] }), false);
	assert.equal(Check(actionTool.parameters, select), true);
	assert.equal(Check(actionTool.parameters, { ...select, values: ["chocolate"] }), true);
	assert.equal(Check(sourceTool.parameters, source), true);
	assert.equal(Check(sourceTool.parameters, { ...source, unknown: true }), false);
	assert.equal(Check(networkTool.parameters, network), true);
	assert.equal(Check(networkTool.parameters, { ...network, unknown: true }), false);
});

test(
	"agentBrowserExtension rejects unsupported extra press/key args before upstream spawn",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-press-validation-"));
		const logPath = join(tempDir, "invocations.log");
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2) }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: {} }));`,
		);
		try {
			await withPatchedEnv(
				{ PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}` },
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const topLevel = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["press", "@e1", "Enter"],
					});
					assert.equal(topLevel.isError, true);
					assert.match(
						readString(readRecord(topLevel.content.at(0)).text),
						/accepts exactly one key argument/,
					);
					assert.equal(
						readRecord(topLevel.details).validationError,
						topLevel.content.at(0)?.text?.split("\n\nObservation:")[0],
					);

					const batch = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["batch"],
						stdin: JSON.stringify([
							["fill", "#todo", "alpha"],
							["key", "#todo", "Return"],
						]),
					});
					assert.equal(batch.isError, true);
					assert.match(
						readString(readRecord(batch.content.at(0)).text),
						/Unsupported batch step 2: agent-browser key\/press accepts exactly one key argument/,
					);
					assert.deepEqual(await readInvocationLog(logPath), []);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension rejects duplicate explicit artifact destinations inside one batch",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-duplicate-artifact-"));
		try {
			assert.equal(
				canonicalizeExplicitArtifactDestination(tempDir, "capture.png", "darwin"),
				canonicalizeExplicitArtifactDestination(tempDir, "CAPTURE.png", "darwin"),
			);
			assert.equal(
				canonicalizeExplicitArtifactDestination(tempDir, "é.png", "darwin"),
				canonicalizeExplicitArtifactDestination(tempDir, "e\u0301.png", "darwin"),
			);
			assert.equal(
				canonicalizeExplicitArtifactDestination(tempDir, "Straße.png", "darwin"),
				canonicalizeExplicitArtifactDestination(tempDir, "STRASSE.png", "darwin"),
			);
			assert.equal(
				canonicalizeExplicitArtifactDestination(tempDir, "Σ.png", "darwin"),
				canonicalizeExplicitArtifactDestination(tempDir, "ς.png", "darwin"),
			);
			assert.equal(
				getExplicitArtifactDestination([
					"diff",
					"screenshot",
					"--output",
					"safe.png",
					"--output",
					"final.png",
				]),
				"final.png",
			);
			assert.equal(
				getExplicitArtifactDestination([
					"diff",
					"screenshot",
					"--output",
					"safe.png",
					"-o",
					"short.png",
				]),
				"short.png",
			);
			assert.equal(
				getExplicitArtifactDestination([
					"diff",
					"screenshot",
					"-o",
					"short.png",
					"--output",
					"final.png",
				]),
				"final.png",
			);
			assert.equal(
				getExplicitArtifactDestination([
					"diff",
					"screenshot",
					"--output",
					"danger.png",
					"--baseline",
					"-o",
				]),
				"danger.png",
			);
			assert.equal(
				getExplicitArtifactDestination(["network", "har", "start", "ignored.har"]),
				undefined,
			);
			assert.equal(
				getExplicitArtifactDestination(["network", "har", "stop", "-capture.har"]),
				"-capture.har",
			);
			assert.equal(
				getExplicitArtifactDestination(["wait", "--timeout", "30000", "-d", "capture.csv"]),
				"capture.csv",
			);
			assert.equal(
				getExplicitArtifactDestination([
					"wait",
					"--timeout",
					"1",
					"--timeout",
					"--download",
					"capture.csv",
				]),
				"capture.csv",
			);
			assert.equal(
				getExplicitArtifactDestination(["wait", "--download", "capture.csv", "--url", "**/done"]),
				undefined,
			);
			assert.equal(
				getExplicitArtifactDestination(["wait", "-d", "capture.csv", "-t", "Ready"]),
				undefined,
			);
			assert.equal(
				getExplicitArtifactDestination(["screenshot", "--full=capture.png"]),
				"--full=capture.png",
			);
			assert.equal(
				getExplicitArtifactDestination(["screenshot", "main", "capture.png", "ignored.png"]),
				"capture.png",
			);
			assert.equal(getExplicitArtifactDestination(["screenshot", "--", "capture"]), "capture");
			assert.equal(
				getExplicitArtifactDestination(["screenshot", "--full", "true", "capture"]),
				"capture",
			);
			assert.equal(getExplicitArtifactDestination(["screenshot", "dir/file"]), "dir/file");
			assert.equal(
				getExplicitArtifactDestination(["screenshot", ".dogfood/run/capture.png"]),
				".dogfood/run/capture.png",
			);
			assert.equal(getExplicitArtifactDestination(["screenshot", "#card.png"]), undefined);
			assert.equal(getExplicitArtifactDestination(["screenshot", ".card.png"]), undefined);
			assert.equal(getExplicitArtifactDestination(["screenshot", "@e1.png"]), undefined);
			assert.equal(getExplicitArtifactDestination(["screenshot", "capture.PNG"]), undefined);
			await symlink(
				tempDir,
				join(tempDir, "alias"),
				process.platform === "win32" ? "junction" : "dir",
			);
			const harness = createExtensionHarness({ cwd: tempDir });
			const lexicalAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([
					["screenshot", "artifact.png"],
					["screenshot", "./artifact.png"],
				]),
			});
			assert.equal(lexicalAlias.isError, true);
			assert.match(
				readString(readRecord(lexicalAlias.content.at(0)).text),
				/artifact\.png is already written by step 1/,
			);

			const sentinelAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([
					["screenshot", "--", "capture"],
					["screenshot", "--", "capture"],
				]),
			});
			assert.equal(sentinelAlias.isError, true);
			assert.match(
				readString(readRecord(sentinelAlias.content.at(0)).text),
				/capture is already written by step 1/,
			);

			const slashPathAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([
					["screenshot", "dir/file"],
					["screenshot", "dir/file"],
				]),
			});
			assert.equal(slashPathAlias.isError, true);
			assert.match(
				readString(readRecord(slashPathAlias.content.at(0)).text),
				/dir\/file is already written by step 1/,
			);

			const symlinkAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([
					["screenshot", "artifact.png"],
					["screenshot", "alias/artifact.png"],
				]),
			});
			assert.equal(symlinkAlias.isError, true);
			assert.match(
				readString(readRecord(symlinkAlias.content.at(0)).text),
				/alias\/artifact\.png is already written by step 1/,
			);

			if (process.platform !== "win32") {
				await symlink("dangling-target.png", join(tempDir, "dangling-alias.png"));
				const danglingAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["screenshot", "dangling-target.png"],
						["screenshot", "dangling-alias.png"],
					]),
				});
				// The POSIX dangling-symlink variant must reject the duplicate destination.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(danglingAlias.isError, true);
				// The same supported-host variant must identify its conflicting artifact.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.match(
					readString(readRecord(danglingAlias.content.at(0)).text),
					/dangling-alias\.png is already written by step 1/,
				);
			}

			const argumentAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch", "screenshot argument.png", "screenshot ./argument.png"],
			});
			assert.equal(argumentAlias.isError, true);
			assert.match(
				readString(readRecord(argumentAlias.content.at(0)).text),
				/\.\/argument\.png is already written by step 1/,
			);

			if (process.platform !== "android") {
				await writeFile(join(tempDir, "hardlink-a.png"), "existing artifact");
				await link(join(tempDir, "hardlink-a.png"), join(tempDir, "hardlink-b.png"));
				const hardlinkAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["screenshot", "hardlink-a.png"],
						["screenshot", "hardlink-b.png"],
					]),
				});
				// Every non-Android host exercises the mandatory hardlink-alias rejection.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(hardlinkAlias.isError, true);
				// The same hardlink variant must identify its duplicate destination.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.match(
					readString(readRecord(hardlinkAlias.content.at(0)).text),
					/hardlink-b\.png is already written by step 1/,
				);
			}

			if (process.platform === "darwin") {
				const caseAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["screenshot", "case-artifact.png"],
						["screenshot", "CASE-ARTIFACT.png"],
					]),
				});
				// macOS supplies the case-insensitive alias exercised by this mandatory rejection.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(caseAlias.isError, true);
				// The same macOS variant must identify its duplicate destination.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.match(
					readString(readRecord(caseAlias.content.at(0)).text),
					/CASE-ARTIFACT\.png is already written by step 1/,
				);
				const unicodeAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["screenshot", "é.png"],
						["screenshot", "e\u0301.png"],
					]),
				});
				// macOS supplies the decomposed-Unicode alias exercised by this rejection.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(unicodeAlias.isError, true);
				// The same macOS Unicode variant must identify its duplicate destination.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.match(
					readString(readRecord(unicodeAlias.content.at(0)).text),
					/é\.png is already written by step 1/,
				);
				const fullFoldAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["screenshot", "Straße.png"],
						["screenshot", "STRASSE.png"],
					]),
				});
				// macOS supplies the full-case-fold alias exercised by this rejection.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(fullFoldAlias.isError, true);
				// The same macOS full-fold variant must identify its duplicate destination.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.match(
					readString(readRecord(fullFoldAlias.content.at(0)).text),
					/STRASSE\.png is already written by step 1/,
				);
			}

			const recordingAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([
					["record", "start", "capture.webm"],
					["record", "restart", "./capture.webm"],
				]),
			});
			assert.equal(recordingAlias.isError, true);
			assert.match(
				readString(readRecord(recordingAlias.content.at(0)).text),
				/capture\.webm is already written by step 1/,
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension handles bare wait commands through artifact preflight",
	{ concurrency: false },
	async () => {
		assert.equal(getExplicitArtifactDestination(["wait"]), undefined);
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-bare-wait-"));
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const command = args.find((token) => token === "wait" || token === "batch");
if (command === "batch") { fs.readFileSync(0, "utf8"); process.stdout.write("[]"); }
else process.stdout.write(JSON.stringify({ success: true, data: { waited: true } }));`,
		);
		try {
			await withPatchedEnv(
				{ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_PAGE_URL: "https://fixture.test/" },
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					for (const params of [
						{ args: ["wait"] },
						{ args: ["batch", "wait"] },
						{ args: ["batch"], stdin: JSON.stringify([["wait"]]) },
					]) {
						// Inspections share a harness whose session state evolves after each call.
						// oxlint-disable-next-line no-await-in-loop
						const result = await executeRegisteredTool(harness.tool, harness.ctx, params);
						// Every fixed provider-free inspection must succeed.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(result.isError, false);
					}
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension reports no-op scroll diagnostics with recovery next actions",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-noop-scroll-"));
		const logPath = join(tempDir, "invocations.log");
		const statePath = join(tempDir, "scroll-state.json");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const valueFlags = new Set(["--session", "--namespace", "--profile", "--state", "--session-name", "--restore-save", "--restore-check-url", "--restore-check-text", "--restore-check-fn", "--cdp", "--provider", "-p", "--device"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === "--json") continue;
  if (valueFlags.has(token)) { i += 1; continue; }
  if (token.startsWith("--")) continue;
  commandIndex = i;
  break;
}
const command = args[commandIndex];
const amount = args[commandIndex + 2];
let state = { moved: false };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (command === "scroll" && amount === "701") {
  state.moved = true;
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
}
const snapshot = {
  scrollX: 0,
  scrollY: state.moved ? 701 : 0,
  innerHeight: 600,
  innerWidth: 800,
  scrollHeight: 1600,
  scrollWidth: 800,
  containerCount: 1,
  containers: [{ id: "0:main.dashboard", scrollTop: state.moved ? 701 : 0, scrollLeft: 0 }]
};
const data = command === "eval" ? { result: snapshot } : { lifecycle: { launched: false }, scrolled: true };
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({
					cwd: tempDir,
					prompt: "Check scroll recovery diagnostics.",
				});
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const noopResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["scroll", "down", "700"],
					sessionMode: "fresh",
				});
				assert.equal(noopResult.isError, true);
				assert.equal(readRecord(noopResult.details).resultCategory, "failure");
				assert.equal(readRecord(noopResult.details).failureCategory, "upstream-error");
				assert.match(
					readString(readRecord(noopResult.content.at(0)).text),
					/Scroll diagnostic: no observed scroll movement/,
				);
				assert.match(readString(readRecord(noopResult.content.at(0)).text), /"scrolled": false/);
				assert.doesNotMatch(readString(readRecord(noopResult.content.at(0)).text), /lifecycle/);

				assert.doesNotMatch(
					readString(readRecord(noopResult.content.at(0)).text),
					/"scrolled": true/,
				);
				const noopDetails = readRecord(noopResult.details);
				const noopData = readRecord(noopDetails.data);
				const scrollNoop = readRecord(noopDetails.scrollNoop);
				const noopActions = readArray(noopDetails.nextActions).map(readRecord);
				assert.equal(noopData.scrolled, false);
				assert.equal(noopData.noMovement, true);
				assert.equal(scrollNoop.reason, "no-observed-scroll-position-change");
				assert.equal(
					readRecord(readArray(readRecord(scrollNoop.before).containers)[0]).id,
					"sample-0",
				);
				assert.deepEqual(
					noopActions
						.map((action) => action.id)
						.filter((id) => readString(id).includes("noop-scroll")),
					["inspect-after-noop-scroll", "verify-noop-scroll-visually"],
				);
				const scrollRecoveryActions = noopActions.filter((action) =>
					readString(action.id).includes("noop-scroll"),
				);
				assert.ok(
					scrollRecoveryActions.every(
						(action) => readArray(readRecord(action.params).args)[0] === "--session",
					),
				);
				assert.deepEqual(
					readArray(readRecord(noopDetails.pageChangeSummary).nextActionIds).filter((id) =>
						readString(id).includes("noop-scroll"),
					),
					["inspect-after-noop-scroll", "verify-noop-scroll-visually"],
				);

				const movedResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["scroll", "down", "701"],
				});
				assert.equal(movedResult.isError, false);
				const movedDetails = readRecord(movedResult.details);
				assert.equal(movedDetails.scrollNoop, undefined);
				assert.doesNotMatch(
					readString(readRecord(movedResult.content.at(0)).text),
					/Scroll diagnostic/,
				);

				const evalCallsBeforeLaunchScopedScroll = (await readInvocationLog(logPath)).filter(
					(entry) => entry.args.includes("eval"),
				).length;
				const launchScopedResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--profile", "Default", "scroll", "down", "700"],
					sessionMode: "fresh",
				});
				assert.equal(launchScopedResult.isError, false);
				assert.equal(readRecord(launchScopedResult.details).scrollNoop, undefined);
				const invocations = await readInvocationLog(logPath);
				assert.equal(
					invocations.filter((entry) => entry.args.includes("eval")).length,
					evalCallsBeforeLaunchScopedScroll,
				);
				assert.ok(
					invocations.some(
						(entry) => entry.args.includes("--profile") && entry.args.includes("scroll"),
					),
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension rejects unsupported text= scroll targets with executable native recovery",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-scroll-text-recovery-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("get") && args.includes("url")) process.stdout.write(JSON.stringify({ success: true, data: { result: "https://example.test/modal", url: "https://example.test/modal" } }));
else if (args.includes("get") && args.includes("title")) process.stdout.write(JSON.stringify({ success: true, data: { result: "Modal", title: "Modal" } }));
else process.stdout.write(JSON.stringify({ success: true, data: { title: "Modal", url: "https://example.test/modal" } }));`,
		);
		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				assert.equal(
					(
						await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["open", "https://example.test/modal"],
						})
					).isError,
					false,
				);
				const invalid = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["scrollintoview", "text=Target sentence"],
				});
				assert.equal(invalid.isError, true);
				assert.equal(readRecord(invalid.details).failureCategory, "validation-error");
				assert.match(
					readString(readRecord(invalid.content.at(0)).text),
					/CSS selector, xpath=.*current @e… ref/,
				);
				const actions = readArray(readRecord(invalid.details).nextActions).map(readRecord);
				const semanticRecovery = actions.find(
					(action) => action.id === "scroll-semantic-text-target",
				);
				assert.ok(semanticRecovery);
				const semanticParams = readRecord(semanticRecovery.params);
				assert.deepEqual(readArray(semanticParams.args).slice(-4), [
					"find",
					"text",
					"Target sentence",
					"hover",
				]);
				assert.match(
					readString(readRecord(invalid.content.at(0)).text),
					/scroll-semantic-text-target.*find.*text.*Target sentence.*hover/,
				);
				assert.match(
					readString(readRecord(invalid.content.at(0)).text),
					/refresh-refs-for-scroll-target.*snapshot.*-i/,
				);
				assert.equal(
					(await readInvocationLog(logPath)).some((entry) => entry.args.includes("scrollintoview")),
					false,
				);
				assert.ok(Object.keys(semanticParams).length > 0);
				const recovered = await executeRegisteredTool(harness.tool, harness.ctx, semanticParams);
				assert.equal(recovered.isError, false, JSON.stringify(recovered));

				const help = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["scrollintoview", "text=Target sentence", "--help"],
				});
				assert.equal(help.isError, false, JSON.stringify(help));
				assert.equal((await readInvocationLog(logPath)).at(-1)?.args.includes("--help"), true);

				const invocationsBeforeBatch = (await readInvocationLog(logPath)).length;
				const invalidBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch", "--bail"],
					stdin: JSON.stringify([["scrollintoview", "text=Target sentence"]]),
				});
				assert.equal(invalidBatch.isError, true);
				assert.match(
					readString(readRecord(invalidBatch.content.at(0)).text),
					/scroll-semantic-text-target.*find.*text.*Target sentence.*hover/,
				);
				assert.equal((await readInvocationLog(logPath)).length, invocationsBeforeBatch);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension bounds dialog recovery commands and exposes recovery actions",
	{ concurrency: false },
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-dialog-timeout-"));
		const logPath = join(tempDir, "invocations.log");
		const pidPath = join(tempDir, "pid");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
if (args.includes("dialog") || (args.includes("eval") && stdin.includes("confirm"))) {
  setInterval(() => {}, 60_000);
  fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
		);
		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_PAGE_URL: "https://fixture.test/",
					PI_AGENT_BROWSER_DIALOG_PROCESS_TIMEOUT_MS: "50",
					PI_AGENT_BROWSER_DIALOG_TRIGGER_PROCESS_TIMEOUT_MS: "60",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const realNow = Date.now;
					const realSetTimeout = setTimeout;
					const realClearTimeout = clearTimeout;
					const runTimedOut = async (params: AgentBrowserToolParams, timeoutMs: number) => {
						const before = (await readInvocationLog(logPath)).length;
						const controller = new AbortController();
						// Freeze coordination deadlines while native dispatch and child liveness remain real.
						t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: realNow() });
						let settled = false;
						const pending = executeRegisteredTool(
							harness.tool,
							harness.ctx,
							params,
							controller.signal,
						).then((result) => {
							settled = true;
							return result;
						});
						try {
							const deadline = realNow() + 5000;
							// The child must read stdin and enter the hang before the parent watchdog advances.
							// oxlint-disable-next-line no-await-in-loop
							while ((await readInvocationLog(logPath)).length <= before) {
								if (realNow() >= deadline) {
									throw new Error("dialog fixture did not dispatch");
								}
								// Observe real dispatch I/O without advancing the mocked watchdog.
								// oxlint-disable-next-line no-await-in-loop
								await new Promise((resolveDelay) => {
									realSetTimeout(resolveDelay, 5);
								});
							}
							t.mock.timers.tick(timeoutMs - 1);
							await new Promise((resolveDelay) => {
								realSetTimeout(resolveDelay, 0);
							});
							assert.equal(settled, false, "dialog must remain pending before its selected budget");
							t.mock.timers.tick(1);
							let deadlineTimer: NodeJS.Timeout | undefined;
							try {
								const result = await Promise.race([
									pending,
									new Promise<never>((_resolve, reject) => {
										deadlineTimer = realSetTimeout(
											() => reject(new Error("dialog watchdog did not settle")),
											5000,
										);
									}),
								]);
								assert.equal(
									isTestPidAlive(Number(await readFile(pidPath, "utf8"))),
									false,
									"timed-out child must be reaped",
								);
								return result;
							} finally {
								realClearTimeout(deadlineTimer);
							}
						} finally {
							t.mock.timers.reset();
							controller.abort();
							await Promise.allSettled([pending]);
						}
					};
					const result = await runTimedOut({ args: ["dialog", "status"] }, 50);
					assert.equal(result.isError, true);
					assert.equal(readRecord(result.details).failureCategory, "timeout");
					assert.equal(readRecord(result.details).timeoutMs, 50);
					const nextActions = readArray(readRecord(result.details).nextActions).map(readRecord);
					assert.ok(nextActions.some((action) => action.id === "inspect-dialog-after-timeout"));
					assert.ok(nextActions.some((action) => action.id === "dismiss-dialog-after-timeout"));
					assert.ok(
						nextActions.some(
							(action) =>
								action.id === "recover-fresh-session-after-dialog-timeout" &&
								readRecord(action.params).sessionMode === "fresh",
						),
					);

					const explicit = await runTimedOut({ args: ["dialog", "status"], timeoutMs: 75 }, 75);
					assert.equal(explicit.isError, true);
					assert.equal(readRecord(explicit.details).failureCategory, "timeout");
					assert.equal(readRecord(explicit.details).timeoutMs, 75);

					const triggered = await runTimedOut(
						{ args: ["eval", "--stdin"], stdin: "confirm('Continue?')" },
						60,
					);
					assert.equal(triggered.isError, true);
					assert.equal(readRecord(triggered.details).failureCategory, "timeout");
					assert.equal(readRecord(triggered.details).timeoutMs, 60);
					assert.ok(
						readArray(readRecord(triggered.details).nextActions)
							.map(readRecord)
							.some((action) => action.id === "inspect-dialog-after-timeout"),
					);
					assert.deepEqual(
						(await readInvocationLog(logPath)).map((entry) => ({
							args: entry.args.slice(-2),
							stdin: entry.stdin,
						})),
						[
							{ args: ["dialog", "status"], stdin: "" },
							{ args: ["dialog", "status"], stdin: "" },
							{ args: ["eval", "--stdin"], stdin: "confirm('Continue?')" },
						],
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension scrolls explicit CSS containers before falling back to page scroll",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-container-scroll-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  if (args.includes("eval") && stdin.includes("document.querySelector")) {
    process.stdout.write(JSON.stringify({ success: true, data: { result: {
      status: "scrolled",
      selector: "#virtualList",
      direction: "down",
      before: { scrollTop: 0, scrollLeft: 0, scrollHeight: 2500, clientHeight: 210, scrollWidth: 400, clientWidth: 400 },
      after: { scrollTop: 168, scrollLeft: 0, scrollHeight: 2500, clientHeight: 210, scrollWidth: 400, clientWidth: 400 }
    } } }));
    return;
  }
  if (args.includes("scroll")) {
    process.stdout.write(JSON.stringify({ success: true, data: { scrolled: "unexpected-page-scroll" } }));
    return;
  }
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
});`,
		);

		try {
			await withPatchedEnv(
				{ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_PAGE_URL: "https://fixture.test/" },
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["scroll", "#virtualList", "down"],
					});
					assert.equal(result.isError, false);
					assert.match(
						readString(readRecord(result.content.at(0)).text),
						/Scrolled container #virtualList down/,
					);
					assert.equal(readRecord(readRecord(result.details).data).status, "scrolled");
					assert.equal(
						readRecord(readRecord(readRecord(result.details).scrollContainer).request).selector,
						"#virtualList",
					);
					const invocations = await readInvocationLog(logPath);
					assert.equal(
						invocations.some((entry) => entry.args.includes("scroll")),
						false,
					);
					assert.equal(invocations.filter((entry) => entry.args.includes("eval")).length, 1);

					const surplus = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["scroll", "#virtualList", "down", "100", "unexpected"],
					});
					assert.equal(surplus.isError, false);
					assert.equal(readRecord(surplus.details).scrollContainer, undefined);
					assert.equal(
						readRecord(readRecord(surplus.details).data).scrolled,
						"unexpected-page-scroll",
					);
					const afterSurplus = await readInvocationLog(logPath);
					assert.deepEqual(
						afterSurplus
							.filter((entry) => entry.args.includes("scroll"))
							.map((entry) => entry.args.slice(3)),
						[["scroll", "#virtualList", "down", "100", "unexpected"]],
					);
					assert.equal(afterSurplus.filter((entry) => entry.args.includes("eval")).length, 1);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension scrolls the document directly before upstream wheel fallback",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-page-scroll-direction-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  if (args.includes("eval") && stdin.includes('target = "end"')) {
    process.stdout.write(JSON.stringify({ success: true, data: { result: {
      status: "scrolled", target: "end",
      before: { scrollTop: 0, scrollLeft: 0, scrollHeight: 5000, clientHeight: 500, scrollWidth: 800, clientWidth: 800 },
      after: { scrollTop: 4500, scrollLeft: 0, scrollHeight: 5000, clientHeight: 500, scrollWidth: 800, clientWidth: 800 }
    } } }));
    return;
  }
  if (args.includes("eval") && stdin.includes('direction = "down"')) {
    process.stdout.write(JSON.stringify({ success: true, data: { result: {
      status: "scrolled",
      direction: "down",
      amount: "700",
      before: { scrollTop: 0, scrollLeft: 0, scrollHeight: 5000, clientHeight: 500, scrollWidth: 800, clientWidth: 800 },
      after: { scrollTop: 700, scrollLeft: 0, scrollHeight: 5000, clientHeight: 500, scrollWidth: 800, clientWidth: 800 }
    } } }));
    return;
  }
  if (args.includes("scroll")) {
    process.stdout.write(JSON.stringify({ success: true, data: { scrolled: "unexpected-page-scroll" } }));
    return;
  }
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
});`,
		);

		try {
			await withPatchedEnv(
				{ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_PAGE_URL: "https://fixture.test/" },
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["scroll", "down", "700"],
					});
					assert.equal(result.isError, false, JSON.stringify(result));
					assert.match(
						readString(readRecord(result.content.at(0)).text),
						/Scrolled page down by 700/,
					);
					assert.equal(readRecord(readRecord(result.details).data).status, "scrolled");
					assert.equal(readRecord(result.details).exitCode, 0);
					assert.equal(
						readRecord(readRecord(readRecord(result.details).scrollPage).request).direction,
						"down",
					);

					const end = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["scroll", "to", "end"],
					});
					assert.equal(end.isError, false, JSON.stringify(end));
					assert.equal(readRecord(end.details).successCategory, "completed");
					assert.match(readString(readRecord(end.content.at(0)).text), /Scrolled page to end/);
					assert.equal(readRecord(readRecord(end.details).data).status, "scrolled");
					assert.equal(
						readRecord(readRecord(readRecord(end.details).scrollPage).request).target,
						"end",
					);
					assert.equal(
						(await readInvocationLog(logPath)).filter((entry) => entry.args.includes("scroll"))
							.length,
						0,
					);

					const endSelector = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["scroll", "to", "end", "--selector", "#panel"],
					});
					assert.equal(endSelector.isError, false);
					assert.equal(
						readRecord(readRecord(endSelector.details).data).scrolled,
						"unexpected-page-scroll",
					);
					const endTail = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["scroll", "to", "end", "unexpected"],
					});
					assert.equal(endTail.isError, false);
					assert.equal(readRecord(endTail.details).scrollPage, undefined);
					const topTail = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["scroll", "to", "top", "unexpected"],
					});
					assert.equal(topTail.isError, false);
					assert.equal(readRecord(topTail.details).scrollPage, undefined);

					const selectorScroll = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["scroll", "down", "250", "--selector", "#panel"],
					});
					assert.equal(selectorScroll.isError, false);
					assert.equal(
						readRecord(readRecord(selectorScroll.details).data).scrolled,
						"unexpected-page-scroll",
					);
					const trailingTokenScroll = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["scroll", "down", "250", "unexpected"],
					});
					assert.equal(trailingTokenScroll.isError, false);

					const invocations = await readInvocationLog(logPath);
					assert.deepEqual(
						invocations
							.filter((entry) => entry.args.includes("scroll"))
							.map((entry) => entry.args.slice(3)),
						[
							["scroll", "to", "end", "--selector", "#panel"],
							["scroll", "to", "end", "unexpected"],
							["scroll", "to", "top", "unexpected"],
							["scroll", "down", "250", "--selector", "#panel"],
							["scroll", "down", "250", "unexpected"],
						],
					);
					assert.equal(invocations.filter((entry) => entry.args.includes("eval")).length, 2);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension filters snapshot refs with wrapper search and role flags",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-snapshot-filter-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://dense.example/",
    refs: {
      e1: { role: "link", name: "Cart" },
      e2: { role: "button", name: "Checkout" },
      e3: { role: "combobox", name: "Theme" }
    },
    snapshot: ['- link "Cart" [ref=e1]', '- button "Checkout" [ref=e2]', '- combobox "Theme" [ref=e3]'].join('\\n')
  } }));
  return;
}
process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_PAGE_URL: "https://dense.example/",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i", "--search", "checkout"],
					});
					assert.equal(result.isError, false, JSON.stringify(result));
					assert.match(
						readString(readRecord(result.content.at(0)).text),
						/Snapshot filter: 1\/3 direct refs matched search "checkout"; 1 surrounding snapshot line shown\./,
					);
					assert.match(readString(readRecord(result.content.at(0)).text), /Checkout/);
					assert.doesNotMatch(readString(readRecord(result.content.at(0)).text), /Theme/);
					assert.equal(readRecord(readRecord(result.details).snapshotFilter).search, "checkout");
					assert.equal(readRecord(readRecord(result.details).snapshotFilter).matchedRefs, 1);
					assert.deepEqual(readRecord(readRecord(result.details).refSnapshot).refIds, [
						"e1",
						"e2",
						"e3",
					]);
					const jsonResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--json", "snapshot", "-i", "--filter", "role=button"],
						outputPath: join(tempDir, "filtered.json"),
					});
					assert.equal(jsonResult.isError, false);
					const envelope = readRecord(
						JSON.parse(readString(readRecord(jsonResult.content.at(0)).text)),
					);
					assert.equal(envelope.success, true);
					assert.deepEqual(envelope.data, readRecord(jsonResult.details).data);
					assert.deepEqual(readRecord(envelope.data).refs, {
						e2: { role: "button", name: "Checkout" },
					});
					assert.deepEqual(
						JSON.parse(await readFile(join(tempDir, "filtered.json"), "utf8")),
						envelope.data,
					);
					const invocations = await readInvocationLog(logPath);
					assert.equal(
						invocations.some((entry) => entry.args.includes("--search")),
						false,
					);
					assert.ok(
						invocations.some(
							(entry) => entry.args.includes("snapshot") && entry.args.includes("-i"),
						),
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension surfaces rendered text missing from the accessibility snapshot",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-snapshot-rendered-search-"));
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://app.example/settings",
    refs: { e1: { role: "button", name: "Save" }, e2: { role: "button", name: "Add Channel" } },
    snapshot: '- button "Save" [ref=e1]'
  } }));
  return;
}
if (args.includes("eval")) {
  const source = fs.readFileSync(0, "utf8");
  const result = source.includes("does not match")
    ? { matches: [{ kind: "validation", offscreen: true, role: "alert", tagName: "div", text: "This destination does not match any configured notification channel." }], totalMatches: 1, truncated: false }
    : { matches: [{ kind: "text", name: "Add Channel", offscreen: false, tagName: "button", text: "Add Channel" }], totalMatches: 1, truncated: false };
  process.stdout.write(JSON.stringify({ success: true, data: { result } }));
  return;
}
process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_PAGE_URL: "https://app.example/settings",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const warning = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i", "--search", "does not match"],
					});
					assert.equal(warning.isError, false, JSON.stringify(warning));
					assert.match(
						readString(readRecord(warning.content.at(0)).text),
						/Rendered page text matches:/,
					);
					assert.match(
						readString(readRecord(warning.content.at(0)).text),
						/does not match any configured notification channel/,
					);
					assert.match(
						readString(readRecord(warning.content.at(0)).text),
						/validation, outside viewport, alert, div/,
					);
					const warningFilter = readRecord(readRecord(warning.details).snapshotFilter);
					assert.equal(warningFilter.matchedRefs, 0);
					assert.deepEqual(warningFilter.renderedTextMatches, [
						{
							kind: "validation",
							offscreen: true,
							role: "alert",
							tagName: "div",
							text: "This destination does not match any configured notification channel.",
						},
					]);

					const label = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i", "--search", "Add Channel"],
					});
					assert.equal(label.isError, false, JSON.stringify(label));
					assert.match(
						readString(readRecord(label.content.at(0)).text),
						/Add Channel.*button, @e2/,
					);
					const labelMatches = readArray(
						readRecord(readRecord(label.details).snapshotFilter).renderedTextMatches,
					);
					assert.equal(readRecord(labelMatches[0]).ref, "e2");
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension reports wrapper snapshot diffs against previous refs",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-snapshot-diff-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const prior = fs.existsSync(${JSON.stringify(logPath)}) ? fs.readFileSync(${JSON.stringify(logPath)}, "utf8").trim().split("\\n").filter(Boolean).length : 0;
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
  const first = prior === 0;
  const data = first
    ? { origin: "https://dense.example/", refs: { e1: { role: "link", name: "Cart" }, e2: { role: "button", name: "Checkout" } }, snapshot: ['- link "Cart" [ref=e1]', '- button "Checkout" [ref=e2]'].join('\\n') }
    : { origin: "https://dense.example/", refs: { e1: { role: "link", name: "Basket" }, e3: { role: "button", name: "Pay" } }, snapshot: ['- link "Basket" [ref=e1]', '- button "Pay" [ref=e3]'].join('\\n') };
  process.stdout.write(JSON.stringify({ success: true, data }));
  return;
}
process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_PAGE_URL: "https://dense.example/",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const first = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i", "--search", "Cart"],
					});
					assert.equal(first.isError, false, JSON.stringify(first));
					const second = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i", "--diff"],
					});
					assert.equal(second.isError, false, JSON.stringify(second));
					assert.match(
						readString(readRecord(second.content.at(0)).text),
						/Snapshot diff: \+1 \/ -1 \/ Δ1 refs/,
					);
					const diff = readRecord(readRecord(second.details).snapshotDiff);
					assert.deepEqual(diff.addedRefs, ["e3"]);
					assert.deepEqual(diff.changedRefs, ["e1"]);
					assert.deepEqual(diff.removedRefs, ["e2"]);
					const invocations = await readInvocationLog(logPath);
					assert.equal(
						invocations.some((entry) => entry.args.includes("--diff")),
						false,
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension reports wrapper snapshot viewport metadata",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-snapshot-viewport-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { scrollX: 0, scrollY: 240, innerHeight: 900, innerWidth: 1440, scrollHeight: 3000, scrollWidth: 1440, containerCount: 1, containers: [{ id: "0:main", scrollTop: 12, scrollLeft: 0 }] } } }));
  return;
}
if (args.includes("snapshot")) {
  const refs = Object.fromEntries(Array.from({ length: 90 }, (_, index) => ["e" + (index + 1), { role: "button", name: "Checkout " + (index + 1) }]));
  const snapshot = Array.from({ length: 90 }, (_, index) => '- button "Checkout ' + (index + 1) + '" [ref=e' + (index + 1) + ']').join('\\n');
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "https://dense.example/", refs, snapshot } }));
  return;
}
process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_PAGE_URL: "https://dense.example/",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i", "--viewport"],
					});
					assert.equal(result.isError, false, JSON.stringify(result));
					assert.match(
						readString(readRecord(result.content.at(0)).text),
						/Viewport: 1440×900, scroll 0,240/,
					);
					const viewport = readRecord(readRecord(result.details).snapshotViewport);
					assert.equal(viewport.innerHeight, 900);
					assert.equal(viewport.scrollY, 240);
					assert.equal(typeof readRecord(result.details).fullOutputPath, "string");
					assert.equal(
						readArray(readRecord(readRecord(result.details).artifactManifest).entries).length,
						1,
					);
					const invocations = await readInvocationLog(logPath);
					assert.equal(
						invocations.some((entry) => entry.args.includes("--viewport")),
						false,
					);
					assert.ok(
						invocations.some(
							(entry) => entry.args.includes("eval") && entry.args.includes("--stdin"),
						),
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension filters network requests to the current page origin",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-network-filter-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://shop.example/products" } }));
  return;
}
if (args.includes("network") && args.includes("requests")) {
  process.stdout.write(JSON.stringify({ success: true, data: { requests: [
    { id: "1", method: "GET", status: 200, url: "https://shop.example/app.js", headers: { Authorization: "Bearer filter-header-secret" } },
    { id: "2", method: "GET", status: 200, url: "https://cdn.example/lib.js" },
    { id: "3", method: "POST", status: 500, url: "https://shop.example/api/cart?access_token=filter-url-secret" }
  ] } }));
  return;
}
process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--namespace", "review", "network", "requests", "--current-page"],
				});
				assert.equal(result.isError, false, JSON.stringify(result));
				assert.match(readString(readRecord(result.content.at(0)).text), /2\/3 rows matched/);
				assert.match(readString(readRecord(result.content.at(0)).text), /shop\.example\/app\.js/);
				assert.doesNotMatch(readString(readRecord(result.content.at(0)).text), /cdn\.example/);
				assert.equal(readRecord(result.details).namespace, "review");
				const filter = readRecord(readRecord(result.details).networkRequestsPageFilter);
				assert.equal(filter.matchedRows, 2);
				assert.equal(filter.totalRows, 3);
				const data = readRecord(readRecord(result.details).data);
				assert.deepEqual(
					readArray(data.requests).map((request) => readRecord(request).url),
					[
						"https://shop.example/app.js",
						"https://shop.example/api/cart?access_token=%5BREDACTED%5D",
					],
				);
				assert.doesNotMatch(JSON.stringify(result), /filter-header-secret|filter-url-secret/);
				const path = join(tempDir, "filtered-network.json");
				const jsonResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [
						"--json",
						"--namespace",
						"review",
						"network",
						"requests",
						"--current-page",
						"--filter",
						"https://shop.example/api/cart?access_token=filter-url-secret",
					],
					outputPath: path,
				});
				assert.equal(jsonResult.isError, false);
				assert.doesNotMatch(JSON.stringify(jsonResult), /filter-header-secret|filter-url-secret/);
				const exported = await readFile(path, "utf8");
				assert.doesNotMatch(exported, /filter-header-secret|filter-url-secret/);
				assert.deepEqual(JSON.parse(exported), readRecord(result.details).data);
				assert.deepEqual(
					readRecord(JSON.parse(readString(readRecord(jsonResult.content.at(0)).text))).data,
					readRecord(result.details).data,
				);
				const invocations = await readInvocationLog(logPath);
				assert.equal(
					invocations.some((entry) => entry.args.includes("--current-page")),
					false,
				);
				assert.ok(
					invocations.every(
						(entry) => entry.args.includes("--namespace") && entry.args.includes("review"),
					),
				);
				assert.ok(
					invocations.some(
						(entry) =>
							entry.args.includes("network") &&
							entry.args.includes("requests") &&
							entry.args.includes("https://shop.example/api/cart?access_token=filter-url-secret"),
					),
					"redact presentation only; native filters must retain their literal value",
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension reports focused combobox diagnostics with option-opening next actions",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-combobox-focus-"));
		const statePath = join(tempDir, "combobox-state.json");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const valueFlags = new Set(["--session"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === "--json") continue;
  if (valueFlags.has(token)) { i += 1; continue; }
  if (token.startsWith("--")) continue;
  commandIndex = i;
  break;
}
const command = args[commandIndex];
const target = args[commandIndex + 1];
const value = args[commandIndex + 2];
const action = args[commandIndex + 3];
const nameIndex = args.indexOf("--name");
const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
let state = { mode: "none" };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (command === "find" && target === "role" && value === "combobox" && action === "click") {
  state.mode = name === "MissingExpanded" ? "combo-missing" : name === "Open" ? "combo-open" : name === "OptionsVisible" ? "combo-options" : "combo";
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
} else if (command === "click") {
  state.mode = "textbox";
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
}
let result = { ok: true, command, target };
if (command === "eval") {
  result = state.mode === "combo"
    ? { comboboxLike: true, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "combobox", expanded: "false", hasPopup: "listbox", name: "Datasource", tagName: "input" } }
    : state.mode === "combo-missing"
      ? { comboboxLike: true, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "combobox", hasPopup: "listbox", name: "MissingExpanded", tagName: "input" } }
      : state.mode === "combo-open"
        ? { comboboxLike: true, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "combobox", expanded: "true", hasPopup: "listbox", name: "Open", tagName: "input" } }
        : state.mode === "combo-options"
          ? { comboboxLike: true, visibleListboxCount: 1, visibleOptionCount: 2, activeElement: { role: "combobox", expanded: "false", hasPopup: "listbox", name: "OptionsVisible", tagName: "input" } }
          : { comboboxLike: false, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "textbox", name: "Search", tagName: "input" } };
}
process.stdout.write(JSON.stringify({ success: true, data: command === "eval" ? { result } : result }));`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({
					cwd: tempDir,
					prompt: "Check combobox recovery diagnostics.",
				});
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const comboboxResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					semanticAction: {
						action: "click",
						locator: "role",
						value: "combobox",
						name: "Datasource",
					},
					sessionMode: "fresh",
				});
				assert.equal(comboboxResult.isError, false);
				assert.match(
					readString(readRecord(comboboxResult.content.at(0)).text),
					/Combobox diagnostic: focused combobox did not expose visible options/,
				);
				const details = readRecord(comboboxResult.details);
				const focus = readRecord(details.comboboxFocus);
				const activeElement = readRecord(focus.activeElement);
				const focusActions = readArray(details.nextActions).map(readRecord);
				assert.equal(focus.reason, "focused-combobox-without-visible-options");
				assert.equal(activeElement.role, "combobox");
				assert.equal(activeElement.name, "Datasource");
				const comboboxActionIds = focusActions
					.map((action) => action.id)
					.filter((id) => readString(id).includes("combobox"));
				assert.deepEqual(comboboxActionIds, [
					"inspect-focused-combobox",
					"try-open-combobox-with-arrow",
					"try-open-combobox-with-enter",
				]);
				assert.ok(
					focusActions
						.filter((action) => readString(action.id).includes("combobox"))
						.every((action) => readArray(readRecord(action.params).args)[0] === "--session"),
				);
				const openComboboxResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					semanticAction: { action: "click", locator: "role", value: "combobox", name: "Open" },
				});
				assert.equal(openComboboxResult.isError, false);
				assert.match(
					readString(readRecord(openComboboxResult.content.at(0)).text),
					/Combobox diagnostic: focused combobox did not expose visible options/,
				);
				assert.equal(
					readRecord(readRecord(readRecord(openComboboxResult.details).comboboxFocus).activeElement)
						.name,
					"Open",
				);
				assert.equal(
					readRecord(readRecord(readRecord(openComboboxResult.details).comboboxFocus).activeElement)
						.expanded,
					"true",
				);

				for (const name of ["MissingExpanded", "OptionsVisible"]) {
					// Both probes observe one page before later actions.
					// oxlint-disable-next-line no-await-in-loop
					const negativeComboboxResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						semanticAction: { action: "click", locator: "role", value: "combobox", name },
					});
					// Both fixed negative combobox states must remain successful no-recovery actions.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(negativeComboboxResult.isError, false, name);
					// Neither fixed negative state may fabricate focus recovery.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(readRecord(negativeComboboxResult.details).comboboxFocus, undefined, name);
					// Neither fixed negative state may claim a combobox diagnostic.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.doesNotMatch(
						readString(readRecord(negativeComboboxResult.content.at(0)).text),
						/Combobox diagnostic/,
						name,
					);
				}

				const textboxResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@text"],
				});
				assert.equal(textboxResult.isError, false);
				assert.equal(readRecord(textboxResult.details).comboboxFocus, undefined);
				assert.doesNotMatch(
					readString(readRecord(textboxResult.content.at(0)).text),
					/Combobox diagnostic/,
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension preserves combobox diagnostics after semanticAction visible-ref resolution",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-combobox-visible-ref-"));
		const logPath = join(tempDir, "invocations.log");
		const statePath = join(tempDir, "combobox-visible-ref-state.json");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const valueFlags = new Set(["--session"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === "--json") continue;
  if (valueFlags.has(token)) { i += 1; continue; }
  if (token.startsWith("--")) continue;
  commandIndex = i;
  break;
}
const command = args[commandIndex];
let state = { mode: "none" };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (command === "open") {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Grafana", url: "https://grafana.example.test/" } }));
} else if (command === "snapshot") {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://grafana.example.test/",
    refs: { e65: { role: "combobox", name: "Job" } },
    snapshot: '- combobox "Job" [ref=e65]'
  } }));
} else if (command === "click") {
  state.mode = args[commandIndex + 1] === "@e65" ? "combo" : "other";
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args[commandIndex + 1] } }));
} else if (command === "eval") {
  const result = state.mode === "combo"
    ? { comboboxLike: true, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "combobox", expanded: "true", hasPopup: "listbox", name: "Job", tagName: "input" } }
    : { comboboxLike: false, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "textbox", name: "Other", tagName: "input" } };
  process.stdout.write(JSON.stringify({ success: true, data: { result } }));
} else if (command === "get" && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Grafana" } }));
} else if (command === "get" && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://grafana.example.test/" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({
					cwd: tempDir,
					prompt: "Check visible-ref combobox recovery diagnostics.",
				});
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const open = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://grafana.example.test/"],
				});
				assert.equal(open.isError, false);
				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					semanticAction: { action: "click", locator: "role", value: "combobox", name: "Job" },
				});
				assert.equal(result.isError, false);
				assert.match(
					readString(readRecord(result.content.at(0)).text),
					/Combobox diagnostic: focused combobox did not expose visible options/,
				);
				assert.deepEqual(readArray(readRecord(result.details).effectiveArgs).slice(-2), [
					"click",
					"@e65",
				]);
				assert.equal(
					readRecord(readRecord(readRecord(result.details).comboboxFocus).activeElement).role,
					"combobox",
				);
				assert.equal(
					readRecord(readRecord(readRecord(result.details).comboboxFocus).activeElement).name,
					"Job",
				);
				const invocations = await readInvocationLog(logPath);
				assert.ok(invocations.some((entry) => entry.args.includes("snapshot")));
				assert.ok(
					invocations.some(
						(entry) => entry.args.at(-2) === "click" && entry.args.at(-1) === "@e65",
					),
				);
				assert.equal(
					invocations.some((entry) => entry.args.includes("find")),
					false,
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension keeps a direct restart pending through outer manifest merge and replay",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-restart-manifest-"));
		const nodeBinDir = dirname(process.execPath);
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const valueFlags = new Set(["--namespace", "--session"]);
let commandIndex = -1;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--json") continue;
  if (valueFlags.has(args[index])) { index += 1; continue; }
  if (args[index].startsWith("--")) continue;
  commandIndex = index;
  break;
}
const command = args[commandIndex];
const subcommand = args[commandIndex + 1];
const path = args[commandIndex + 2];
if (command === "record" && subcommand === "restart") fs.writeFileSync(${JSON.stringify(join(tempDir, "z-previous.webm"))}, "finished recording");
const data = command === "get" && subcommand === "url"
  ? { result: "https://safe.example/", url: "https://safe.example/" }
  : { command, path, subcommand, ...(command === "record" && subcommand === "restart" ? { restarted: true } : {}) };
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}${delimiter}${nodeBinDir}` }, async () => {
				const sessionName = "restart-session";
				const harness = createExtensionHarness({
					cwd: tempDir,
					prompt: "Restart a browser recording.",
				});
				const started = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", sessionName, "record", "start", "z-previous.webm"],
				});
				assert.equal(started.isError, false, started.content.at(0)?.text);
				const restarted = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", sessionName, "record", "restart", "a-current.webm"],
				});
				assert.equal(restarted.isError, false, restarted.content.at(0)?.text);
				const manifest = readRecord(readRecord(restarted.details).artifactManifest);
				assert.equal(
					readArray(manifest.entries)
						.map(readRecord)
						.some(
							(entry) =>
								entry.path === "z-previous.webm" && entry.subcommand === "restart-previous",
						),
					true,
				);
				assert.equal(
					readArray(manifest.entries)
						.map(readRecord)
						.some((entry) => entry.path === "a-current.webm" && entry.subcommand === "restart"),
					true,
				);

				const replayHarness = createExtensionHarness({
					branch: [
						...harness.appendedEntries.map((entry) => ({ type: "custom", ...entry })),
						{
							type: "message",
							message: {
								details: restarted.details,
								isError: restarted.isError,
								toolName: "agent_browser",
							},
						},
					],
					cwd: tempDir,
				});
				await runExtensionEvent(
					replayHarness.handlers,
					"session_start",
					{ reason: "resume" },
					replayHarness.ctx,
				);
				const reservedAfterReplay = await executeRegisteredTool(
					replayHarness.tool,
					replayHarness.ctx,
					{ args: ["pdf", "a-current.webm"] },
				);
				assert.equal(reservedAfterReplay.isError, true);
				assert.match(
					readString(readRecord(reservedAfterReplay.content.at(0)).text),
					/a-current\.webm is reserved by an active recording/,
				);
				await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", sessionName, "close"],
				});
				await executeRegisteredTool(replayHarness.tool, replayHarness.ctx, {
					args: ["--session", sessionName, "close"],
				});
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension makes close --all exclusive within its namespace",
	{ concurrency: false },
	async (t) => {
		for (const scenario of [
			{
				label: "caller-default",
				named: false,
				callerOwned: true,
				override: undefined,
				batch: false,
				ambient: undefined,
				fresh: false,
			},
			{
				label: "current-named",
				named: true,
				callerOwned: false,
				override: undefined,
				batch: false,
				ambient: undefined,
				fresh: false,
			},
			{
				label: "current-named-batch",
				named: true,
				callerOwned: false,
				override: undefined,
				batch: true,
				ambient: undefined,
				fresh: false,
			},
			{
				label: "explicit-default",
				named: true,
				callerOwned: false,
				override: "",
				batch: false,
				ambient: undefined,
				fresh: false,
			},
			{
				label: "explicit-other",
				named: true,
				callerOwned: false,
				override: "other",
				batch: false,
				ambient: undefined,
				fresh: false,
			},
			{
				label: "fresh-ambient",
				named: true,
				callerOwned: false,
				override: undefined,
				batch: false,
				ambient: "Review Space",
				fresh: true,
			},
			{
				label: "current-default-ambient",
				named: false,
				callerOwned: false,
				override: undefined,
				batch: false,
				ambient: "Review Space",
				fresh: false,
			},
		]) {
			// Each namespace scenario owns its gates, environment, and shutdown; do not overlap them.
			// oxlint-disable-next-line no-await-in-loop
			await t.test(scenario.label, async () => {
				const openingNamespace = scenario.named ? "review-space" : "";
				const openingPrefix = scenario.named ? ["--namespace", "Review Space"] : [];
				const openingMode = scenario.callerOwned ? "auto" : "fresh";
				const openingSessionPattern = scenario.callerOwned ? /^pi-root-/ : /^piab-/;
				const namespace = scenario.override ?? openingNamespace;
				const matchingPrefix =
					namespace !== "" || (scenario.ambient !== undefined && scenario.ambient !== "")
						? ["--namespace", namespace]
						: [];
				const closeNamespacePrefix =
					scenario.override !== undefined ? ["--namespace", scenario.override] : [];
				const closeCommand = scenario.batch ? ["batch", "close --all"] : ["close", "--all"];
				const closeMode = scenario.fresh ? "fresh" : "auto";
				const reportedNamespace = scenario.override ?? (namespace === "" ? undefined : namespace);
				const tempDir = await mkdtemp(join(tmpdir(), "piab-close-all-queue-"));
				const cwd = join(tempDir, "g");
				await mkdir(cwd);
				const logPath = join(tempDir, "events.log");
				const openGate = join(tempDir, "release-open");
				const waitGate = join(tempDir, "release-wait");
				const closeGate = join(tempDir, "release-close");
				const nodeBinDir = dirname(process.execPath);
				await writeFakeAgentBrowserBinary(
					tempDir,
					`const fs = require("node:fs");
const args = process.argv.slice(2);
const valueFlags = new Set(["--allow-file-access", "--args", "--namespace", "--session"]);
let commandIndex = -1;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--json") continue;
  if (valueFlags.has(args[index])) { index += 1; continue; }
  if (args[index].startsWith("--")) continue;
  commandIndex = index;
  break;
}
const commandArgs = args.slice(commandIndex);
const command = commandArgs[0];
const namespaceIndex = args.indexOf("--namespace");
const namespace = (namespaceIndex >= 0 ? args[namespaceIndex + 1] : process.env.AGENT_BROWSER_NAMESPACE ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const sessionIndex = args.indexOf("--session");
const sessionName = sessionIndex >= 0 ? args[sessionIndex + 1] : process.env.AGENT_BROWSER_SESSION || "default";
const writeEvent = (event) => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, event, namespace, sessionName }) + "\\n");
const waitForGate = (gate) => {
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(gate)) {
    if (Date.now() > deadline) throw new Error("gate was not released: " + gate);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};
const closesAll = (command === "close" && commandArgs.includes("--all")) || (command === "batch" && commandArgs.includes("close --all"));
if (closesAll) {
  writeEvent("close-start");
  waitForGate(${JSON.stringify(closeGate)});
  writeEvent("close-end");
} else {
  writeEvent(command + "-start");
  if (command === "open") waitForGate(${JSON.stringify(openGate)});
  if (command === "wait") { waitForGate(${JSON.stringify(waitGate)}); writeEvent("wait-end"); }
}
const data = command === "get" ? { result: "https://safe.example/", url: "https://safe.example/" }
  : command === "tab" ? { tabs: [] } : command === "close" ? { closed: true } : { url: "https://safe.example/" };
process.stdout.write(JSON.stringify(command === "batch"
  ? [{ command: ["close", "--all"], data: { closed: true }, success: true }]
  : { success: true, data }));`,
				);
				const readEvents = async () =>
					(await readInvocationLog(logPath)).map((entry) => ({
						args: entry.args,
						event: readString(entry.event),
						namespace: readString(readRecord(entry).namespace),
						sessionName: readString(entry.sessionName),
					}));
				const waitForEvent = async (event: string) => {
					const deadline = Date.now() + 15_000;
					while (Date.now() <= deadline) {
						// Observe the independently appended event before a deadline-limited retry.
						// oxlint-disable-next-line no-await-in-loop
						const found = (await readEvents()).find((entry) => entry.event === event);
						if (found) {
							return found;
						}
						// Wait between observations rather than overlapping native event reads.
						// oxlint-disable-next-line no-await-in-loop
						await new Promise((resolveDelay) => {
							setTimeout(resolveDelay, 10);
						});
					}
					assert.fail(`${scenario.label}: ${event} did not dispatch`);
				};
				try {
					await withPatchedEnv(
						{
							AGENT_BROWSER_NAMESPACE: scenario.ambient,
							AGENT_BROWSER_SESSION: undefined,
							PATH: `${tempDir}${delimiter}${nodeBinDir}`,
						},
						async () => {
							const harness = createExtensionHarness({
								cwd,
								prompt: "Exercise global close ordering.",
							});
							await runExtensionEvent(
								harness.handlers,
								"session_start",
								{ reason: "new" },
								harness.ctx,
							);
							const pending: Array<ReturnType<typeof executeRegisteredTool>> = [];
							try {
								const open = executeRegisteredTool(harness.tool, harness.ctx, {
									args: [...openingPrefix, "open", "https://safe.example/"],
									sessionMode: openingMode,
								});
								pending.push(open);
								const openStarted = await Promise.race([
									waitForEvent("open-start"),
									open.then((result) =>
										assert.fail(
											`${scenario.label}: open ended before the fixture gate: ${readString(readRecord(result.content.at(0)).text)}`,
										),
									),
								]);
								assert.match(openStarted.sessionName, openingSessionPattern);
								assert.equal(openStarted.namespace, openingNamespace);
								let closeSessionName = openStarted.sessionName;
								if (scenario.callerOwned) {
									closeSessionName = "caller-owned";
								}
								if (scenario.fresh) {
									closeSessionName = "default";
								}
								const wait = executeRegisteredTool(harness.tool, harness.ctx, {
									args: [...matchingPrefix, "--session", "already-running", "wait", "1"],
								});
								pending.push(wait);
								const waitStarted = await waitForEvent("wait-start");
								assert.equal(waitStarted.namespace, namespace);
								const closeAll = executeRegisteredTool(harness.tool, harness.ctx, {
									args: [
										...closeNamespacePrefix,
										...(scenario.fresh ? [] : ["--session", closeSessionName]),
										...closeCommand,
									],
									sessionMode: closeMode,
								});
								pending.push(closeAll);
								await writeFile(openGate, "go");
								const openResult = await open;
								assert.equal(openResult.isError, false, JSON.stringify(openResult));
								assert.equal(readRecord(openResult.details).sessionName, openStarted.sessionName);
								const beforeDrain = await executeRegisteredTool(harness.tool, harness.ctx, {
									args: ["--namespace", "unrelated", "--session", "drain-control", "tab", "list"],
								});
								assert.equal(beforeDrain.isError, false, JSON.stringify(beforeDrain));
								assert.equal(
									(await readEvents()).some((entry) => entry.event === "close-start"),
									false,
									scenario.label,
								);
								await writeFile(waitGate, "go");
								const waitResult = await wait;
								assert.equal(waitResult.isError, false, JSON.stringify(waitResult));
								const closeStarted = await waitForEvent("close-start");
								assert.equal(closeStarted.namespace, namespace, scenario.label);
								assert.equal(closeStarted.sessionName, closeSessionName);
								if (scenario.fresh) {
									// Only the fixed fresh-launch variant emits this replacement close receipt.
									// oxlint-disable-next-line node-test/no-conditional-assertion
									assert.deepEqual(closeStarted.args, ["--json", "close", "--all"]);
								}
								const atCloseStart = (await readEvents()).length;
								const overlappingCaller = executeRegisteredTool(harness.tool, harness.ctx, {
									args: [...matchingPrefix, "--session", "same-namespace", "tab", "list"],
								});
								const overlappingManaged = executeRegisteredTool(harness.tool, harness.ctx, {
									args: ["get", "url"],
								});
								pending.push(overlappingCaller, overlappingManaged);
								const otherNamespace = await executeRegisteredTool(harness.tool, harness.ctx, {
									args: ["--namespace", "unrelated", "--session", "other-session", "tab", "list"],
								});
								assert.equal(otherNamespace.isError, false, JSON.stringify(otherNamespace));
								const whileClosed = (await readEvents()).slice(atCloseStart);
								assert.equal(
									whileClosed.some(
										(entry) =>
											entry.sessionName === "same-namespace" ||
											entry.sessionName.startsWith("piab-") ||
											entry.sessionName.startsWith("pi-root-"),
									),
									false,
									`${scenario.label}: ${JSON.stringify(whileClosed)}`,
								);
								await writeFile(closeGate, "go");
								const [closeResult, callerResult, overlapResult] = await Promise.all([
									closeAll,
									overlappingCaller,
									overlappingManaged,
								]);
								assert.equal(closeResult.isError, false, JSON.stringify(closeResult));
								assert.equal(readRecord(closeResult.details).closeAllApplied, true, scenario.label);
								assert.equal(
									readRecord(closeResult.details).namespace,
									reportedNamespace,
									scenario.label,
								);
								assert.equal(
									readRecord(closeResult.details).sessionName,
									scenario.fresh ? undefined : closeStarted.sessionName,
								);
								assert.equal(callerResult.isError, false, JSON.stringify(callerResult));
								assert.equal(overlapResult.isError, false, JSON.stringify(overlapResult));
								const events = await readEvents();
								const waitEnd = events.findIndex((entry) => entry.event === "wait-end");
								const closeStart = events.findIndex((entry) => entry.event === "close-start");
								const closeEnd = events.findIndex((entry) => entry.event === "close-end");
								const otherStart = events.findIndex(
									(entry) => entry.sessionName === "other-session" && entry.event === "tab-start",
								);
								const lateStart = events.findIndex(
									(entry) => entry.sessionName === "same-namespace" && entry.event === "tab-start",
								);
								const managedStart = events.findIndex(
									(entry) =>
										entry.sessionName === readRecord(overlapResult.details).sessionName &&
										entry.event === "get-start",
								);
								assert.ok(waitEnd >= 0 && closeStart > waitEnd, JSON.stringify(events));
								assert.ok(otherStart > closeStart && otherStart < closeEnd, JSON.stringify(events));
								assert.ok(lateStart > closeEnd && managedStart > closeEnd, JSON.stringify(events));
							} finally {
								await Promise.all(
									[openGate, waitGate, closeGate].map((gate) => writeFile(gate, "go")),
								);
								await Promise.allSettled(pending);
								await runExtensionEvent(
									harness.handlers,
									"session_shutdown",
									{ reason: "quit" },
									harness.ctx,
								);
							}
						},
					);
				} finally {
					await rm(tempDir, { force: true, recursive: true });
				}
			});
		}
	},
);

// These PDFs deliberately do not create files: the native receipt proves admission, not artifact success.
function assertReleasedPdf(result: {
	readonly isError?: boolean;
	readonly details?: Readonly<Record<string, unknown>>;
}): void {
	assert.equal(result.isError, true);
	const details = readRecord(result.details);
	assert.equal(details.failureCategory, "artifact-missing");
	assert.equal(readRecord(details.data).command, "pdf");
}

// Each recording contract gets isolated state, an ffmpeg-free PATH, and a one-row manifest cap.
type RecordingReservationHarnessView = Pick<
	ReturnType<typeof createExtensionHarness>,
	"ctx" | "getTool" | "tool"
> & {
	readonly appendedEntries: readonly Readonly<
		ReturnType<typeof createExtensionHarness>["appendedEntries"][number]
	>[];
	readonly handlers: Parameters<typeof runExtensionEvent>[0];
};

async function withRecordingReservationHarness(
	slug: string,
	prompt: string,
	run: (
		harness: RecordingReservationHarnessView,
		context: { readonly noRecordingMarker: string; readonly tempDir: string },
	) => Promise<void>,
): Promise<void> {
	const tempDir = await mkdtemp(join(tmpdir(), `pi-agent-browser-recording-${slug}-`));
	const noRecordingMarker = join(tempDir, "no-recording");
	const missingFfmpegPath =
		process.platform === "android" ? join(tempDir, "node-only") : dirname(process.execPath);
	if (process.platform === "android") {
		await mkdir(missingFfmpegPath);
		await symlink(process.execPath, join(missingFfmpegPath, "node"), "file");
	}
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const valueFlags = new Set(["--namespace", "--session"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === "--json") continue;
  if (valueFlags.has(token)) { i += 1; continue; }
  if (token.startsWith("--")) continue;
  commandIndex = i;
  break;
}
const commandArgs = args.slice(commandIndex).filter((token) => token !== "--json" && token !== "--quiet");
const command = commandArgs[0];
const subcommand = commandArgs[1];
const path = command === "pdf" ? commandArgs[1] : commandArgs[2];
if (command === "record" && subcommand === "stop" && fs.existsSync(${JSON.stringify(noRecordingMarker)})) {
  process.stdout.write(JSON.stringify({ success: false, error: "No recording in progress" }));
  process.exit(1);
}
if (command === "find") {
  process.stdout.write(JSON.stringify({ success: false, error: "No element found by text 'Missing Control'" }));
  process.exit(1);
}
const batchInput = command === "batch" ? fs.readFileSync(0, "utf8") : "";
const batchSteps = batchInput
  ? JSON.parse(batchInput)
  : commandArgs.slice(1).filter((value) => value !== "--bail" && !value.startsWith("--bail=")).map((value) => value.split(" "));
const closeStepIndex = batchSteps.findIndex((step) => step[0] === "close");
const postCloseStopIndex = batchSteps.findIndex((step, index) => index > closeStepIndex && step[0] === "record" && step[1] === "stop");
const postCloseStopPath = ${JSON.stringify(join(tempDir, "post-close-stop.webm"))};
if (postCloseStopIndex >= 0 && !fs.existsSync(${JSON.stringify(noRecordingMarker)})) fs.writeFileSync(postCloseStopPath, "recording");
const firstCallFailure = command === "batch" && batchSteps.some((step) => step[0] === "click" && step[1] === "#missing-after-close");
const data = command === "batch"
  ? batchSteps.map((step, index) => step[0] === "click" && step[1] === "#missing-after-close"
    ? { command: step, success: false, error: "Element not found after browser launch" }
    : step[0] === "open" && step[1] === "fail-after-close"
      ? { command: step, success: false, error: "Navigation failed after browser launch", result: { lifecycle: { effectiveLaunch: { browserLaunched: true } } } }
    : step[0] === "record" && step[1] === "stop" && fs.existsSync(${JSON.stringify(noRecordingMarker)})
      ? { command: step, success: false, error: "No recording in progress" }
      : { command: step, success: true, result: {
      command: step[0],
      path: index === postCloseStopIndex ? postCloseStopPath : step[2],
      subcommand: step[1],
        ...(index === postCloseStopIndex
          ? { lifecycle: { effectiveLaunch: { browserLaunched: true } } }
          : step[0] === "stream" && step[1] === "status"
            ? { lifecycle: { effectiveLaunch: { browserLaunched: false } } }
            : {}),
      } })
  : command === "get" && subcommand === "url"
    ? { command, subcommand, url: "https://safe.example/" }
    : { command, subcommand, path };
process.stdout.write(JSON.stringify({ success: !firstCallFailure, data }));
if (firstCallFailure) process.exit(1);`,
	);
	try {
		await withPatchedEnv(
			{
				PATH: `${tempDir}${delimiter}${missingFfmpegPath}`,
				PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "1",
			},
			async () => {
				const harness = createExtensionHarness({
					cwd: tempDir,
					prompt,
					sessionFile: join(tempDir, "session.jsonl"),
				});
				await run(harness, { noRecordingMarker, tempDir });
			},
		);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
}

test(
	"agentBrowserExtension keeps browser ownership when the first managed batch call fails after close",
	{ concurrency: false },
	async () => {
		await withRecordingReservationHarness(
			"first-call",
			"Test failed post-close launch ownership.",
			async (firstCallHarness) => {
				const failedFirstCall = await executeRegisteredTool(
					firstCallHarness.tool,
					firstCallHarness.ctx,
					{
						sessionMode: "fresh",
						args: ["batch"],
						stdin: JSON.stringify([["close"], ["click", "#missing-after-close"]]),
					},
				);
				assert.equal(failedFirstCall.isError, true, failedFirstCall.content.at(0)?.text);
				assert.equal(
					readRecord(readRecord(failedFirstCall.details).managedSessionOutcome).activeAfter,
					true,
				);
				assert.equal(typeof readRecord(failedFirstCall.details).sessionName, "string");
				const recoveredFirstCall = await executeRegisteredTool(
					firstCallHarness.tool,
					firstCallHarness.ctx,
					{ args: ["get", "url"] },
				);
				assert.equal(recoveredFirstCall.isError, false, recoveredFirstCall.content.at(0)?.text);
				assert.equal(
					readRecord(recoveredFirstCall.details).sessionName,
					readRecord(failedFirstCall.details).sessionName,
				);
				const closeAllFirstCall = await executeRegisteredTool(
					firstCallHarness.tool,
					firstCallHarness.ctx,
					{ args: ["--session", "caller-owned", "close", "--all"] },
				);
				assert.equal(readRecord(closeAllFirstCall.details).closeAllApplied, true);
				assert.equal(
					readRecord(readRecord(closeAllFirstCall.details).managedSessionOutcome).activeAfter,
					false,
				);
				const rotatedAfterCloseAll = await executeRegisteredTool(
					firstCallHarness.tool,
					firstCallHarness.ctx,
					{ args: ["get", "url"] },
				);
				assert.notEqual(
					readRecord(rotatedAfterCloseAll.details).sessionName,
					readRecord(failedFirstCall.details).sessionName,
				);
				await executeRegisteredTool(firstCallHarness.tool, firstCallHarness.ctx, {
					args: ["close"],
				});
			},
		);
	},
);

test(
	"agentBrowserExtension releases recording reservations by namespace on close --all",
	{ concurrency: false },
	async () => {
		await withRecordingReservationHarness(
			"namespace-close",
			"Record a browser workflow.",
			async (harness, { tempDir }) => {
				await mkdir(join(tempDir, "ffmpeg"));
				const globalOne = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "global-one", "record", "start", "global-one.webm"],
				});
				assert.equal(globalOne.isError, false, globalOne.content.at(0)?.text);
				const globalTwo = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "global-two", "record", "start", "global-two.webm"],
				});
				assert.equal(globalTwo.isError, false, globalTwo.content.at(0)?.text);
				const otherNamespaceRecording = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [
						"--namespace",
						"other",
						"--session",
						"global-three",
						"record",
						"start",
						"global-three.webm",
					],
				});
				assert.equal(
					otherNamespaceRecording.isError,
					false,
					otherNamespaceRecording.content.at(0)?.text,
				);
				assert.equal(readRecord(otherNamespaceRecording.details).namespace, "other");
				const globalClose = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["close", "--all"],
				});
				assert.equal(readRecord(globalClose.details).closeAllApplied, true);
				assert.equal(readRecord(globalClose.details).namespace, undefined);
				const releasedGlobalOne = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["pdf", "global-one.webm"],
				});
				const releasedGlobalTwo = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["pdf", "global-two.webm"],
				});
				assertReleasedPdf(releasedGlobalOne);
				assertReleasedPdf(releasedGlobalTwo);
				const retainedOtherNamespace = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["pdf", "global-three.webm"],
				});
				assert.match(
					readString(readRecord(retainedOtherNamespace.content.at(0)).text),
					/reserved by an active recording/,
				);
				await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--namespace", "other", "close", "--all"],
				});
			},
		);
	},
);

test(
	"agentBrowserExtension warns about a pending recording when ffmpeg is missing and stops warning once ffmpeg is installed",
	{ concurrency: false },
	async () => {
		await withRecordingReservationHarness(
			"ffmpeg-missing",
			"Record a browser workflow.",
			async (harness, { tempDir }) => {
				await mkdir(join(tempDir, "ffmpeg"));
				const missingResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["record", "--quiet", "start", "demo.webm"],
					sessionMode: "fresh",
				});
				assert.equal(missingResult.isError, false);
				assert.equal(readRecord(missingResult.details).successCategory, "artifact-pending");
				const stopAction = readArray(readRecord(missingResult.details).nextActions)
					.map(readRecord)
					.find((action) => action.id === "stop-pending-recording");
				assert.ok(stopAction);
				assert.deepEqual(readArray(readRecord(stopAction.params).args).slice(-2), [
					"record",
					"stop",
				]);
				assert.match(
					readString(readRecord(missingResult.content.at(0)).text),
					/Recording dependency warning: ffmpeg not found on PATH/,
				);
				assert.match(
					readString(readRecord(missingResult.content.at(0)).text),
					/Exists: pending until record stop/,
				);
				assert.match(readString(readRecord(missingResult.content.at(0)).text), /Status: pending/);
				assert.doesNotMatch(
					readString(readRecord(missingResult.content.at(0)).text),
					/Status: missing/,
				);
				const missingArtifacts = readArray(readRecord(missingResult.details).artifacts).map(
					readRecord,
				);
				assert.equal(missingArtifacts[0].exists, undefined);
				assert.equal(missingArtifacts[0].status, "pending");
				assert.equal(missingArtifacts[0].recordingState, "openRecording");
				assert.equal(missingArtifacts[0].willExistOnStop, true);
				const missingVerification = readRecord(
					readRecord(missingResult.details).artifactVerification,
				);
				const verifiedArtifact = readRecord(readArray(missingVerification.artifacts)[0]);
				assert.equal(missingVerification.pendingCount, 1);
				assert.equal(missingVerification.missingCount, 0);
				assert.equal(verifiedArtifact.state, "pending");
				assert.equal(verifiedArtifact.status, "pending");
				assert.equal(verifiedArtifact.willExistOnStop, true);
				const failedWhileRecording = await executeRegisteredTool(harness.tool, harness.ctx, {
					semanticAction: { action: "click", locator: "text", value: "Missing Control" },
				});
				assert.equal(failedWhileRecording.isError, true);
				assert.equal(
					readRecord(failedWhileRecording.details).failureCategory,
					"selector-not-found",
				);
				const stopAfterFailure = readArray(readRecord(failedWhileRecording.details).nextActions)
					.map(readRecord)
					.find((action) => action.id === "stop-pending-recording");
				assert.ok(stopAfterFailure);
				assert.deepEqual(readRecord(stopAfterFailure.params).args, [
					"--session",
					readRecord(missingResult.details).sessionName,
					"record",
					"stop",
				]);
				assert.match(
					readString(readRecord(failedWhileRecording.content.at(0)).text),
					/active recording remains open.*stop-pending-recording/is,
				);

				const missingDetails = readRecord(missingResult.details);
				assert.deepEqual(missingDetails.recordingDependencyWarning, {
					command: "record start",
					dependency: "ffmpeg",
					message:
						"record start reported a pending recording, but ffmpeg is not on PATH. Its output is unverified; install ffmpeg before starting a new recording.",
					reason: "ffmpeg-missing-for-recording",
					recommendations: [
						"Install ffmpeg before recording; on macOS with Homebrew, brew install ffmpeg or brew install ffmpeg-full.",
						"Stop this recording, check the result, and start a new recording after ensuring Pi can find ffmpeg on PATH.",
					],
				});

				await rm(join(tempDir, "ffmpeg"), { recursive: true, force: true });
				const ffmpeg = join(tempDir, process.platform === "win32" ? "ffmpeg.cmd" : "ffmpeg");
				await writeFile(
					ffmpeg,
					process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
					"utf8",
				);
				if (process.platform !== "win32") {
					await chmod(ffmpeg, 0o755);
				}
				const presentResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["record", "start", "present.webm"],
					sessionMode: "fresh",
				});
				assert.equal(presentResult.isError, false);
				assert.equal(readRecord(presentResult.details).recordingDependencyWarning, undefined);
				assert.doesNotMatch(
					readString(readRecord(presentResult.content.at(0)).text),
					/Recording dependency warning/,
				);
				const reservationEntryCount = harness.appendedEntries.length;
				await runExtensionEvent(
					harness.handlers,
					"session_shutdown",
					{ reason: "quit" },
					harness.ctx,
				);
				assert.ok(
					harness.appendedEntries
						.slice(reservationEntryCount)
						.some(
							(entry) =>
								entry.customType === "agent-browser-recording-reservation" &&
								readRecord(entry.data).sessionName ===
									readRecord(presentResult.details).sessionName &&
								readRecord(entry.data).state === "closed",
						),
				);
				const resumedHarness = createExtensionHarness({
					branch: harness.appendedEntries.map((entry) => ({ type: "custom", ...entry })),
					cwd: tempDir,
					prompt: "Resume after cleanup.",
				});
				await runExtensionEvent(
					resumedHarness.handlers,
					"session_start",
					{ reason: "resume" },
					resumedHarness.ctx,
				);
				const releasedAfterResume = await executeRegisteredTool(
					resumedHarness.tool,
					resumedHarness.ctx,
					{ args: ["pdf", "present.webm"] },
				);
				assertReleasedPdf(releasedAfterResume);
			},
		);
	},
);

test(
	"agentBrowserExtension reserves pending recording destinations across flag spellings and output paths",
	{ concurrency: false },
	async () => {
		await withRecordingReservationHarness(
			"reservation-destinations",
			"Record a browser workflow.",
			async (harness, { tempDir }) => {
				await mkdir(join(tempDir, "ffmpeg"));
				const missingResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["record", "--quiet", "start", "demo.webm"],
					sessionMode: "fresh",
				});
				assert.equal(missingResult.isError, false);

				const noise = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["pdf", "noise.pdf"],
				});
				assert.equal(noise.isError, true);
				const reservedExtraPositionalScreenshot = await executeRegisteredTool(
					harness.tool,
					harness.ctx,
					{ args: ["screenshot", "main", "demo.webm", "ignored.png"] },
				);
				assert.equal(reservedExtraPositionalScreenshot.isError, true);
				assert.match(
					readString(readRecord(reservedExtraPositionalScreenshot.content.at(0)).text),
					/demo\.webm is reserved by an active recording/,
				);
				if (process.platform !== "win32") {
					await symlink("demo.webm", join(tempDir, "--full=demo.png"));
					const reservedEqualsScreenshot = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["screenshot", "--full=demo.png"],
					});
					// This POSIX symlink variant must reject the reserved recording destination.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(reservedEqualsScreenshot.isError, true);
					// The same supported-host variant must identify the reserved equals-spelled operand.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(
						readString(readRecord(reservedEqualsScreenshot.content.at(0)).text),
						/--full=demo\.png is reserved by an active recording/,
					);
				}
				const reservedGlobalPdf = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["pdf", "--json", "demo.webm"],
				});
				assert.equal(reservedGlobalPdf.isError, true);
				assert.match(
					readString(readRecord(reservedGlobalPdf.content.at(0)).text),
					/demo\.webm is reserved by an active recording/,
				);
				const reservedQuickPdf = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["pdf", "--quick", "demo.webm"],
				});
				assert.equal(reservedQuickPdf.isError, true);
				assert.match(
					readString(readRecord(reservedQuickPdf.content.at(0)).text),
					/demo\.webm is reserved by an active recording/,
				);
				const noiseManifest = readRecord(readRecord(noise.details).artifactManifest ?? {});
				assert.equal(
					readArray(noiseManifest.entries ?? [])
						.map(readRecord)
						.some((entry) => entry.subcommand === "start"),
					false,
				);
				const reservedOutputPath = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "title"],
					outputPath: "demo.webm",
				});
				assert.equal(reservedOutputPath.isError, true);
				assert.match(
					readString(readRecord(reservedOutputPath.content.at(0)).text),
					/Unsupported outputPath: demo\.webm is reserved by an active recording/,
				);
				const reservedAtOutputPath = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "title"],
					outputPath: "@demo.webm",
				});
				assert.equal(reservedAtOutputPath.isError, true);
				assert.match(
					readString(readRecord(reservedAtOutputPath.content.at(0)).text),
					/@demo\.webm is reserved by an active recording/,
				);
				const codeTool = harness.getTool("agent_browser_code");
				assert.ok(codeTool);
				const reservedScriptOutputPath = await executeRegisteredTool(codeTool, harness.ctx, {
					code: "emit({ ok: true });",
					outputPath: "demo.webm",
				});
				assert.equal(reservedScriptOutputPath.isError, true);
				assert.match(
					readString(readRecord(reservedScriptOutputPath.content.at(0)).text),
					/demo\.webm is reserved by an active recording/,
				);
				const reservedElectronOutputPath = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "status", all: true },
					outputPath: "demo.webm",
				});
				assert.equal(reservedElectronOutputPath.isError, true);
				assert.match(
					readString(readRecord(reservedElectronOutputPath.content.at(0)).text),
					/demo\.webm is reserved by an active recording/,
				);
				const reservedWaitDownload = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["wait", "--download", "demo.webm"],
				});
				assert.equal(reservedWaitDownload.isError, true);
				assert.match(
					readString(readRecord(reservedWaitDownload.content.at(0)).text),
					/demo\.webm is reserved by an active recording/,
				);
				const reservedShortWaitDownload = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["wait", "-d", "demo.webm"],
				});
				assert.equal(reservedShortWaitDownload.isError, true);
				assert.match(
					readString(readRecord(reservedShortWaitDownload.content.at(0)).text),
					/demo\.webm is reserved by an active recording/,
				);
				const reservedReorderedWaitDownload = await executeRegisteredTool(
					harness.tool,
					harness.ctx,
					{ args: ["wait", "--timeout", "30000", "--download", "demo.webm"] },
				);
				assert.equal(reservedReorderedWaitDownload.isError, true);
				assert.match(
					readString(readRecord(reservedReorderedWaitDownload.content.at(0)).text),
					/demo\.webm is reserved by an active recording/,
				);
				const reservedRepeatedTimeoutDownload = await executeRegisteredTool(
					harness.tool,
					harness.ctx,
					{ args: ["wait", "--timeout", "1", "--timeout", "--download", "demo.webm"] },
				);
				assert.equal(reservedRepeatedTimeoutDownload.isError, true);
				assert.match(
					readString(readRecord(reservedRepeatedTimeoutDownload.content.at(0)).text),
					/demo\.webm is reserved by an active recording/,
				);
				const unsupportedInlineWaitDownload = await executeRegisteredTool(
					harness.tool,
					harness.ctx,
					{ args: ["wait", "--download=demo.webm"] },
				);
				assert.equal(unsupportedInlineWaitDownload.isError, true);
				assert.match(
					readString(readRecord(unsupportedInlineWaitDownload.content.at(0)).text),
					/does not support `wait --download=<path>`/,
				);
				const reservedLastOutput = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["diff", "screenshot", "--output", "safe.png", "--output", "demo.webm"],
				});
				assert.equal(reservedLastOutput.isError, true);
				assert.match(
					readString(readRecord(reservedLastOutput.content.at(0)).text),
					/demo\.webm is reserved by an active recording/,
				);
				const reservedShortOutput = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["diff", "screenshot", "--output", "safe.png", "-o", "demo.webm"],
				});
				assert.equal(reservedShortOutput.isError, true);
				assert.match(
					readString(readRecord(reservedShortOutput.content.at(0)).text),
					/demo\.webm is reserved by an active recording/,
				);
				const reservedHarStop = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["network", "har", "stop", "demo.webm"],
				});
				assert.equal(reservedHarStop.isError, true);
				assert.match(
					readString(readRecord(reservedHarStop.content.at(0)).text),
					/demo\.webm is reserved by an active recording/,
				);
				const sameCallOutput = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["record", "start", "same-call.webm"],
					outputPath: "same-call.webm",
				});
				assert.equal(sameCallOutput.isError, true);
				assert.match(
					readString(readRecord(sameCallOutput.content.at(0)).text),
					/same destination as artifact path same-call\.webm/,
				);
				if (process.platform !== "win32") {
					await symlink("same-call-alias-target.webm", join(tempDir, "same-call-output.json"));
					const danglingSameCallOutput = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["record", "start", "same-call-alias-target.webm"],
						outputPath: "same-call-output.json",
					});
					// The POSIX dangling-symlink variant must reject the same-call output collision.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(danglingSameCallOutput.isError, true);
					// The same supported-host variant must identify both colliding destinations.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(
						readString(readRecord(danglingSameCallOutput.content.at(0)).text),
						/same destination as artifact path same-call-alias-target\.webm/,
					);
					await rm(join(tempDir, "same-call-output.json"), { force: true });
				}
				if (process.platform !== "win32") {
					await symlink("demo.webm", join(tempDir, "demo.png"));
					const screenshotAlias = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["screenshot", "demo.png"],
					});
					// The POSIX screenshot-symlink variant must reject the recording reservation.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(screenshotAlias.isError, true);
					// The same supported-host variant must identify the reserved destination.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(
						readString(readRecord(screenshotAlias.content.at(0)).text),
						/demo\.png is reserved by an active recording/,
					);
				}
				const restartSamePath = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["record", "restart", "demo.webm"],
				});
				assert.equal(restartSamePath.isError, true);
				assert.match(
					readString(readRecord(restartSamePath.content.at(0)).text),
					/demo\.webm is reserved by an active recording/,
				);
			},
		);
	},
);

test(
	"agentBrowserExtension retires recording reservations through direct and batch close",
	{ concurrency: false },
	async () => {
		await withRecordingReservationHarness(
			"close-release",
			"Record a browser workflow.",
			async (harness, { tempDir }) => {
				await mkdir(join(tempDir, "ffmpeg"));
				const missingResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["record", "--quiet", "start", "demo.webm"],
					sessionMode: "fresh",
				});
				assert.equal(missingResult.isError, false);

				if (process.platform !== "win32") {
					await symlink("demo.webm", join(tempDir, "demo.webm"));
				}
				const closed = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
				assert.equal(closed.isError, false);
				if (process.platform !== "win32") {
					await rm(join(tempDir, "demo.webm"), { force: true });
				}
				const closedManifest = readRecord(readRecord(closed.details).artifactManifest ?? {});
				assert.equal(
					readArray(closedManifest.entries ?? [])
						.map(readRecord)
						.some((entry) => entry.subcommand === "start" || entry.subcommand === "restart"),
					false,
				);

				const releasedAfterDirectClose = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["pdf", "demo.webm"],
				});
				assertReleasedPdf(releasedAfterDirectClose);
				const batchRecording = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["record", "start", "batch-close.webm"],
				});
				assert.equal(batchRecording.isError, false);
				const batchClose = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([["close"]]),
				});
				assert.equal(batchClose.isError, false, batchClose.content.at(0)?.text);
				const releasedAfterBatchClose = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["pdf", "batch-close.webm"],
				});
				assertReleasedPdf(releasedAfterBatchClose);
				assert.notEqual(
					readRecord(releasedAfterBatchClose.details).sessionName,
					readRecord(batchRecording.details).sessionName,
				);

				const argumentBatchRecording = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["record", "start", "batch-argument-close.webm"],
				});
				assert.equal(argumentBatchRecording.isError, false);
				const argumentBatchClose = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch", "close"],
				});
				assert.equal(argumentBatchClose.isError, false, argumentBatchClose.content.at(0)?.text);
				const releasedAfterArgumentBatchClose = await executeRegisteredTool(
					harness.tool,
					harness.ctx,
					{ args: ["pdf", "batch-argument-close.webm"] },
				);
				assertReleasedPdf(releasedAfterArgumentBatchClose);
			},
		);
	},
);

test(
	"agentBrowserExtension folds post-close batch rows into recording ownership and terminal state",
	{ concurrency: false },
	async () => {
		await withRecordingReservationHarness(
			"close-fold",
			"Record a browser workflow.",
			async (harness, { tempDir }) => {
				await mkdir(join(tempDir, "ffmpeg"));
				// A fresh launch keeps this a wrapper-managed session (the original sequence reached this
				// fold on a post-close rotation); the default auto session here is root caller-owned.
				const diagnosticBatchRecording = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["record", "start", "batch-close-stream.webm"],
					sessionMode: "fresh",
				});
				assert.equal(diagnosticBatchRecording.isError, false);
				const terminalDiagnosticClose = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([["close"], ["stream", "status"]]),
				});
				assert.equal(
					terminalDiagnosticClose.isError,
					false,
					terminalDiagnosticClose.content.at(0)?.text,
				);
				assert.equal(
					readRecord(readRecord(terminalDiagnosticClose.details).managedSessionOutcome).activeAfter,
					false,
				);
				assert.equal(
					readRecord(readRecord(terminalDiagnosticClose.details).managedSessionOutcome).status,
					"closed",
				);
				const releasedAfterDiagnosticClose = await executeRegisteredTool(
					harness.tool,
					harness.ctx,
					{ args: ["pdf", "batch-close-stream.webm"] },
				);
				assertReleasedPdf(releasedAfterDiagnosticClose);
				assert.notEqual(
					readRecord(releasedAfterDiagnosticClose.details).sessionName,
					readRecord(diagnosticBatchRecording.details).sessionName,
				);

				const postCloseStop = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([["close"], ["record", "stop"]]),
				});
				assert.equal(postCloseStop.isError, false, postCloseStop.content.at(0)?.text);
				assert.equal(
					readRecord(readRecord(postCloseStop.details).managedSessionOutcome).activeAfter,
					true,
				);
				assert.equal(
					readRecord(readRecord(postCloseStop.details).managedSessionOutcome).status,
					"unchanged",
				);
				assert.equal(
					readRecord(postCloseStop.details).sessionName,
					readRecord(releasedAfterDiagnosticClose.details).sessionName,
				);

				const failedPostCloseLaunch = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([["close"], ["open", "fail-after-close"]]),
				});
				assert.equal(
					failedPostCloseLaunch.isError,
					true,
					failedPostCloseLaunch.content.at(0)?.text,
				);
				assert.equal(
					readRecord(readRecord(failedPostCloseLaunch.details).managedSessionOutcome).activeAfter,
					true,
				);
				assert.equal(
					readRecord(readRecord(failedPostCloseLaunch.details).managedSessionOutcome).status,
					"unchanged",
				);
				assert.equal(
					readRecord(failedPostCloseLaunch.details).sessionName,
					readRecord(postCloseStop.details).sessionName,
				);
				assert.deepEqual(
					readRecord(readRecord(readRecord(failedPostCloseLaunch.details).batchFailure).failedStep)
						.lifecycle,
					{ effectiveLaunch: { browserLaunched: true } },
				);

				const activeBeforeCombined = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "url"],
				});
				assert.equal(
					readRecord(activeBeforeCombined.details).sessionName,
					readRecord(postCloseStop.details).sessionName,
				);
				assert.equal(activeBeforeCombined.isError, false, activeBeforeCombined.content.at(0)?.text);
				assert.equal(
					readRecord(readRecord(activeBeforeCombined.details).managedSessionOutcome).activeAfter,
					true,
				);

				const combinedStartClose = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([["record", "start", "batch-start-close.webm"], ["close"]]),
				});
				assert.equal(combinedStartClose.isError, true, combinedStartClose.content.at(0)?.text);
				assert.equal(readRecord(combinedStartClose.details).failureCategory, "artifact-missing");
				const combinedCloseBranch = harness.ctx.sessionManager.getBranch().slice();
				const releasedAfterCombinedStartClose = await executeRegisteredTool(
					harness.tool,
					harness.ctx,
					{ args: ["pdf", "batch-start-close.webm"] },
				);
				assertReleasedPdf(releasedAfterCombinedStartClose);
				const combinedManifest = readRecord(
					readRecord(combinedStartClose.details).artifactManifest ?? {},
				);
				assert.equal(
					readArray(combinedManifest.entries ?? [])
						.map(readRecord)
						.some(
							(entry) => entry.path === "batch-start-close.webm" && entry.subcommand === "start",
						),
					false,
				);
				const combinedArtifacts = readArray(readRecord(combinedStartClose.details).artifacts).map(
					readRecord,
				);
				assert.deepEqual(
					combinedArtifacts.map((artifact) => ({
						path: artifact.path,
						recordingState: artifact.recordingState,
						status: artifact.status,
						subcommand: artifact.subcommand,
						willExistOnStop: artifact.willExistOnStop,
					})),
					[
						{
							path: "batch-start-close.webm",
							recordingState: undefined,
							status: "missing",
							subcommand: "close-abandoned",
							willExistOnStop: undefined,
						},
					],
				);
				const combinedVerification = readRecord(
					readRecord(combinedStartClose.details).artifactVerification,
				);
				assert.equal(combinedVerification.missingCount, 1);
				assert.equal(combinedVerification.pendingCount, 0);
				assert.equal(
					readArray(readRecord(combinedStartClose.details).nextActions)
						.map(readRecord)
						.some((action) => action.id === "stop-pending-recording"),
					false,
				);
				assert.equal(
					readRecord(readRecord(combinedStartClose.details).managedSessionOutcome).activeAfter,
					false,
				);
				assert.equal(
					readRecord(readRecord(combinedStartClose.details).managedSessionOutcome).status,
					"closed",
				);
				const replayHarness = createExtensionHarness({
					branch: combinedCloseBranch,
					cwd: tempDir,
				});
				await runExtensionEvent(
					replayHarness.handlers,
					"session_start",
					{ reason: "resume" },
					replayHarness.ctx,
				);
				const replayFreshLaunch = await executeRegisteredTool(
					replayHarness.tool,
					replayHarness.ctx,
					{ args: ["--headed", "open", "https://example.test/"] },
				);
				assert.equal(replayFreshLaunch.isError, false, replayFreshLaunch.content.at(0)?.text);
				assert.equal(readRecord(replayFreshLaunch.details).resultCategory, "success");
				assert.equal(readRecord(readRecord(replayFreshLaunch.details).data).command, "open");

				for (const subcommand of ["start", "restart"]) {
					// Validation attempts share one native session and invocation log.
					// oxlint-disable-next-line no-await-in-loop
					const closeThenRecord = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["batch"],
						stdin: JSON.stringify([
							["close"],
							["record", subcommand, `batch-close-${subcommand}.webm`],
						]),
					});
					// Both fixed native record launch variants must reject close-then-record batches.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(closeThenRecord.isError, true, closeThenRecord.content.at(0)?.text);
					// Both variants must fail validation before native dispatch.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(readRecord(closeThenRecord.details).failureCategory, "validation-error");
					// Both variants must identify their unsupported lifecycle ordering.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(
						readString(readRecord(closeThenRecord.content.at(0)).text),
						new RegExp(
							`record ${subcommand} cannot follow close.*Split the close and recording`,
							"s",
						),
					);
				}
			},
		);
	},
);

test(
	"agentBrowserExtension releases recording reservations after definitive stop failures and replacement starts",
	{ concurrency: false },
	async () => {
		await withRecordingReservationHarness(
			"stop-release",
			"Record a browser workflow.",
			async (harness, { noRecordingMarker, tempDir }) => {
				await mkdir(join(tempDir, "ffmpeg"));
				const staleRecording = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["record", "start", "stale-recording.webm"],
				});
				assert.equal(staleRecording.isError, false);
				await writeFile(noRecordingMarker, "1", "utf8");
				const staleStop = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["record", "stop"],
				});
				assert.equal(staleStop.isError, true);
				assert.match(
					readString(readRecord(staleStop.content.at(0)).text),
					/No recording in progress/,
				);
				assert.equal(
					readArray(readRecord(staleStop.details).nextActions ?? [])
						.map(readRecord)
						.some((action) => action.id === "stop-pending-recording"),
					false,
				);
				await rm(noRecordingMarker, { force: true });
				const releasedAfterDefinitiveStopFailure = await executeRegisteredTool(
					harness.tool,
					harness.ctx,
					{ args: ["pdf", "stale-recording.webm"] },
				);
				assertReleasedPdf(releasedAfterDefinitiveStopFailure);

				const staleBatchRecording = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["record", "start", "stale-batch-recording.webm"],
				});
				assert.equal(staleBatchRecording.isError, false);
				await writeFile(noRecordingMarker, "1", "utf8");
				const staleBatchStop = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([["record", "stop"]]),
				});
				assert.equal(staleBatchStop.isError, true);
				assert.match(
					readString(readRecord(staleBatchStop.content.at(0)).text),
					/No recording in progress/,
				);
				assert.equal(
					readArray(readRecord(staleBatchStop.details).nextActions ?? [])
						.map(readRecord)
						.some((action) => action.id === "stop-pending-recording"),
					false,
				);
				await rm(noRecordingMarker, { force: true });
				const releasedAfterDefinitiveBatchStopFailure = await executeRegisteredTool(
					harness.tool,
					harness.ctx,
					{ args: ["pdf", "stale-batch-recording.webm"] },
				);
				assertReleasedPdf(releasedAfterDefinitiveBatchStopFailure);

				const orderedBatchRecording = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["record", "start", "ordered-old.webm"],
				});
				assert.equal(orderedBatchRecording.isError, false);
				await writeFile(noRecordingMarker, "1", "utf8");
				const orderedBatchRestart = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["record", "stop"],
						["record", "start", "ordered-new.webm"],
					]),
				});
				assert.equal(orderedBatchRestart.isError, true);
				assert.equal(
					readArray(readRecord(orderedBatchRestart.details).nextActions)
						.map(readRecord)
						.some((action) => action.id === "stop-pending-recording"),
					true,
				);
				// A final observation spill can occupy the one-row manifest; current artifacts and reservations must survive.
				const orderedArtifacts = readArray(readRecord(orderedBatchRestart.details).artifacts).map(
					readRecord,
				);
				assert.equal(
					orderedArtifacts.some(
						(entry) => entry.path === "ordered-new.webm" && entry.subcommand === "start",
					),
					true,
				);
				assert.equal(
					orderedArtifacts.some(
						(entry) => entry.path === "ordered-new.webm" && entry.subcommand === "close-abandoned",
					),
					false,
				);
				await rm(noRecordingMarker, { force: true });
				const releasedOrderedOld = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["pdf", "ordered-old.webm"],
				});
				assertReleasedPdf(releasedOrderedOld);
				const reservedOrderedNew = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["pdf", "ordered-new.webm"],
				});
				assert.match(
					readString(readRecord(reservedOrderedNew.content.at(0)).text),
					/ordered-new\.webm is reserved by an active recording/,
				);
				await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });

				const concurrentResults = await Promise.all([
					executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["record", "start", "concurrent.webm"],
						sessionMode: "fresh",
					}),
					executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["record", "start", "concurrent.webm"],
						sessionMode: "fresh",
					}),
				]);
				assert.equal(concurrentResults.filter((result) => result.isError === true).length, 1);
				assert.match(
					concurrentResults.find((result) => result.isError === true)?.content.at(0)?.text ?? "",
					/concurrent\.webm is reserved by an active recording/,
				);
				const replacement = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["record", "start", "replacement.webm"],
					sessionMode: "fresh",
				});
				assert.equal(replacement.isError, false);
				const releasedAfterReplacement = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["pdf", "concurrent.webm"],
				});
				assertReleasedPdf(releasedAfterReplacement);
				assert.equal(
					(await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] })).isError,
					false,
				);
			},
		);
	},
);

test(
	"agentBrowserExtension retires recording reservations by namespace plus session",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-recording-namespace-"));
		const nodeBinDir = dirname(process.execPath);
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const args = process.argv.slice(2);
const valueFlags = new Set(["--namespace", "--session"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === "--json") continue;
  if (valueFlags.has(token)) { i += 1; continue; }
  if (token.startsWith("--")) continue;
  commandIndex = i;
  break;
}
const command = args[commandIndex];
const subcommand = args[commandIndex + 1];
const path = command === "pdf" ? args[commandIndex + 1] : args[commandIndex + 2];
const data = command === "open" ? { title: "Example", url: subcommand }
  : command === "get" && subcommand === "url" ? { result: "https://example.test/", url: "https://example.test/" }
  : { command, subcommand, path };
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);
		try {
			await withPatchedEnv({ PATH: `${tempDir}${delimiter}${nodeBinDir}` }, async () => {
				const harness = createExtensionHarness({
					cwd: tempDir,
					prompt: "Keep recording identities isolated.",
				});
				assert.equal(
					(
						await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["--namespace", "one", "--session", "shared", "open", "https://example.test/"],
						})
					).isError,
					false,
				);
				assert.equal(
					(
						await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["--namespace", "two", "--session", "shared", "open", "https://example.test/"],
						})
					).isError,
					false,
				);
				const one = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--namespace", "one", "--session", "shared", "record", "start", "one.webm"],
				});
				const two = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--namespace", "two", "--session", "shared", "record", "start", "two.webm"],
				});
				assert.equal(one.isError, false, one.content.at(0)?.text);
				assert.equal(two.isError, false, two.content.at(0)?.text);
				harness.setBranch([
					{
						type: "message",
						message: { role: "user", content: [{ type: "text", text: "Switch branches." }] },
					},
				]);
				await runExtensionEvent(
					harness.handlers,
					"session_tree",
					{ newLeafId: "other", oldLeafId: null },
					harness.ctx,
				);
				assert.equal(
					(
						await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["--namespace", "one", "--session", "shared", "close"],
						})
					).isError,
					false,
				);
				const stillReserved = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["pdf", "two.webm"],
				});
				assert.equal(stillReserved.isError, true);
				assert.match(
					readString(readRecord(stillReserved.content.at(0)).text),
					/two\.webm is reserved by an active recording/,
				);
				assert.equal(
					(
						await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["--namespace", "two", "--session", "shared", "close"],
						})
					).isError,
					false,
				);
				const released = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["pdf", "two.webm"],
				});
				assertReleasedPdf(released);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension persists cross-branch recording close tombstones across reload",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-recording-tombstone-"));
		const nodeBinDir = dirname(process.execPath);
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const args = process.argv.slice(2);
const valueFlags = new Set(["--session"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === "--json") continue;
  if (valueFlags.has(token)) { i += 1; continue; }
  if (token.startsWith("--")) continue;
  commandIndex = i;
  break;
}
const command = args[commandIndex];
const subcommand = args[commandIndex + 1];
const path = command === "pdf" ? subcommand : args[commandIndex + 2];
const data = command === "open" ? { title: "Example", url: subcommand }
  : command === "get" && subcommand === "url" ? { result: "https://example.test/", url: "https://example.test/" }
  : { command, subcommand, path };
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);
		try {
			await withPatchedEnv({ PATH: `${tempDir}${delimiter}${nodeBinDir}` }, async () => {
				const harness = createExtensionHarness({
					cwd: tempDir,
					prompt: "Keep cross-branch recording state safe.",
				});
				assert.equal(
					(
						await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["--session", "shared", "open", "https://example.test/"],
						})
					).isError,
					false,
				);
				assert.equal(
					(
						await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["--session", "shared", "record", "start", "branch.webm"],
						})
					).isError,
					false,
				);
				const activeEntry = harness.appendedEntries.find(
					(entry) =>
						entry.customType === "agent-browser-recording-reservation" &&
						readRecord(entry.data).state === "active",
				);
				assert.ok(activeEntry);
				const branchA = [{ type: "custom", ...activeEntry }];
				harness.setBranch([
					{
						type: "message",
						message: { role: "user", content: [{ type: "text", text: "Branch B" }] },
					},
				]);
				await runExtensionEvent(
					harness.handlers,
					"session_tree",
					{ newLeafId: "branch-b", oldLeafId: null },
					harness.ctx,
				);
				assert.equal(
					(
						await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["--session", "shared", "close"],
						})
					).isError,
					false,
				);
				harness.setBranch(branchA);
				await runExtensionEvent(
					harness.handlers,
					"session_tree",
					{ newLeafId: "branch-a", oldLeafId: "branch-b" },
					harness.ctx,
				);
				await runExtensionEvent(
					harness.handlers,
					"session_shutdown",
					{ reason: "reload" },
					harness.ctx,
				);
				assert.ok(
					branchA.some(
						(entry) =>
							entry.customType === "agent-browser-recording-reservation" &&
							readRecord(entry.data).state === "closed",
					),
				);

				const resumedHarness = createExtensionHarness({
					branch: branchA,
					cwd: tempDir,
					prompt: "Resume branch A.",
				});
				await runExtensionEvent(
					resumedHarness.handlers,
					"session_start",
					{ reason: "resume" },
					resumedHarness.ctx,
				);
				resumedHarness.setBranch([{ type: "custom", ...activeEntry }]);
				await runExtensionEvent(
					resumedHarness.handlers,
					"session_tree",
					{ newLeafId: "older-active-branch", oldLeafId: "branch-a" },
					resumedHarness.ctx,
				);
				const released = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
					args: ["pdf", "branch.webm"],
				});
				assertReleasedPdf(released);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test("agentBrowserExtension renders long TUI output compactly without changing model-facing content", async () => {
	const harness = createExtensionHarness({ cwd: process.cwd(), prompt: "Inspect a page." });
	const renderCall = harness.tool.renderCall;
	const renderResult = harness.tool.renderResult;
	assert.ok(renderCall, "expected agent_browser to register custom call rendering");
	assert.ok(renderResult, "expected agent_browser to register custom result rendering");

	const params: AgentBrowserToolParams = {
		args: ["eval", "--stdin"],
		sessionMode: "fresh",
		stdin: "document.body.innerText",
	};
	const callText = renderCall(params, PLAIN_RENDER_THEME, createRenderContext({ args: params }))
		.render(200)
		.join("\n");
	assert.match(callText, /<toolTitle>\*\*agent_browser\*\*<\/toolTitle>/);
	assert.match(callText, /<accent>eval --stdin<\/accent>/);
	assert.match(callText, /sessionMode=fresh/);
	assert.match(callText, /\+ stdin/);
	assert.doesNotMatch(callText, /document\.body/);

	const qaCallText = renderCall(
		{ qa: { url: "https://example.com", expectedText: "Example" } },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params }),
	)
		.render(200)
		.join("\n");
	assert.match(qaCallText, /<accent>qa<\/accent>/);
	assert.match(qaCallText, /<dim>→<\/dim> <accent>batch --bail<\/accent>/);

	const semanticActionCallText = renderCall(
		{ semanticAction: { action: "click", locator: "text", value: "Definitely Missing Button" } },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params }),
	)
		.render(200)
		.join("\n");
	assert.match(semanticActionCallText, /<accent>semanticAction<\/accent>/);
	assert.match(
		semanticActionCallText,
		/<dim>→<\/dim> <accent>find text Definitely Missing Button click<\/accent>/,
	);

	const scriptSource = `const rows = [];\n${"rows.push('visible source'); ".repeat(12)}\n// osc-hidden line\x1B]0;\rawait browser({ args: ["get", "title"] }); //\x07\n// browser call follows\rawait browser({ args: ["get", "url"] });\u2028emit(rows);\x1B[31m\u202E\u200B`;
	const scriptParams: AgentBrowserToolParams = { code: scriptSource };
	const collapsedScriptCallText = renderCall(
		scriptParams,
		PLAIN_RENDER_THEME,
		createRenderContext({ args: scriptParams }),
	)
		.render(200)
		.join("\n");
	assert.match(collapsedScriptCallText, /<toolTitle>\*\*agent_browser_code\*\*<\/toolTitle>/);
	assert.match(collapsedScriptCallText, /const rows = \[\]/);
	assert.match(collapsedScriptCallText, /↵/);
	assert.match(collapsedScriptCallText, /\.\.\.<\/accent>/);
	assert.doesNotMatch(collapsedScriptCallText, /emit\(rows\)/);
	const expandedScriptCallText = renderCall(
		scriptParams,
		PLAIN_RENDER_THEME,
		createRenderContext({ args: scriptParams, expanded: true }),
	)
		.render(200)
		.join("\n");
	assert.match(expandedScriptCallText, /<dim>Source:<\/dim>/);
	assert.match(
		expandedScriptCallText,
		/\/\/ osc-hidden line[^\r\n]*\nawait browser\(\{ args: \["get", "title"\][^\S\r\n]*\}\)/,
	);
	assert.match(expandedScriptCallText, /\/\/ browser call follows[^\S\r\n]*\nawait browser/);
	assert.match(expandedScriptCallText, /emit\(rows\)/);
	// Rendered source must reject terminal escapes and invisible line/direction controls.
	// oxlint-disable-next-line no-control-regex
	assert.doesNotMatch(expandedScriptCallText, /[\r\x1B\u2028\u202E\u200B]/);
	assert.match(expandedScriptCallText, /�/);

	const maliciousParams: AgentBrowserToolParams = {
		args: ["open", "\x1B]0;pwned\x07https://example.com/\x1B[31m"],
		stdin: "secret stdin must not render",
	};
	const maliciousCallText = renderCall(
		maliciousParams,
		PLAIN_RENDER_THEME,
		createRenderContext({ args: maliciousParams }),
	)
		.render(200)
		.join("\n");
	// Model-supplied text must not emit NUL, BEL, or terminal escape controls.
	// oxlint-disable-next-line no-control-regex
	assert.doesNotMatch(maliciousCallText, /[\x00\x07\x1B]/);
	assert.match(maliciousCallText, /https:\/\/example\.com\//);
	assert.doesNotMatch(maliciousCallText, /secret stdin/);

	const longText = JSON.stringify(
		{
			origin: "https://example.com/",
			result: Array.from({ length: 25 }, (_, index) => ({
				href: `https://example.com/${index}`,
				i: index,
				text: `item-${index}`,
			})),
		},
		null,
		2,
	);
	const longResult: AgentToolResult<unknown> = {
		content: [{ type: "text", text: longText }],
		details: { summary: "large JSON result" },
	};
	const collapsedComponent = renderResult(
		longResult,
		{ expanded: false, isPartial: false },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params }),
	);
	const collapsedLines = collapsedComponent.render(80);
	const collapsedText = collapsedLines.join("\n");
	const wideCollapsedText = collapsedComponent.render(200).join("\n");
	assert.ok(
		collapsedLines.every((line) => visibleWidth(line) <= 80),
		"collapsed render lines must fit width",
	);
	const narrowCollapsedLines = collapsedComponent.render(24);
	assert.ok(
		narrowCollapsedLines.every((line) => visibleWidth(line) <= 24),
		"narrow collapsed render lines must fit width",
	);
	assert.match(collapsedText, /\.\.\. \(\d+ more lines, \d+ total,/);
	assert.match(wideCollapsedText, /<dim>ctrl\+o<\/dim> <muted>to expand<\/muted>/);
	assert.match(wideCollapsedText, /<syntaxVariable>"origin"<\/syntaxVariable>/);
	assert.match(wideCollapsedText, /<syntaxString>"https:\/\/example\.com\/"<\/syntaxString>/);
	assert.doesNotMatch(collapsedText, /item-24/);
	assert.deepEqual(
		longResult.content,
		[{ type: "text", text: longText }],
		"renderer must not mutate model-facing content",
	);

	const longFailureText = Array.from({ length: 20 }, (_, index) => `failure-line-${index}`).join(
		"\n",
	);
	const failedResult: AgentToolResult<unknown> = {
		content: [{ type: "text", text: longFailureText }],
		details: {
			failureCategory: "selector-not-found",
			resultCategory: "failure",
			summary: "selector miss",
		},
	};
	const failedCollapsedText = renderResult(
		failedResult,
		{ expanded: false, isPartial: false },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params }),
	)
		.render(100)
		.join("\n");
	assert.match(
		failedCollapsedText,
		/Result category: failure; failureCategory: selector-not-found; Pi tool isError: true\./,
	);
	assert.match(failedCollapsedText, /failure-line-0/);
	assert.doesNotMatch(failedCollapsedText, /failure-line-19/);
	assert.deepEqual(
		failedResult.content,
		[{ type: "text", text: longFailureText }],
		"renderer must not mutate failed model-facing content",
	);

	const expandedComponent = renderResult(
		longResult,
		{ expanded: true, isPartial: false },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params, expanded: true, lastComponent: collapsedComponent }),
	);
	const expandedText = expandedComponent.render(80).join("\n");
	assert.match(expandedText, /item-24/);
	assert.doesNotMatch(expandedText, /\.\.\. \(\d+ more lines/);

	// Host updates can wrap the same row result in a fresh object each time.
	const { AgentBrowserResultComponent } =
		await import("../extensions/agent-browser/lib/pi-tool-rendering.js");
	const cached = new AgentBrowserResultComponent();
	let colorCalls = 0;
	let themeVersion = {};
	let themePrefix = "";
	const countFg: typeof PLAIN_RENDER_THEME.fg = (color, text) => {
		colorCalls++;
		return `${themePrefix}${PLAIN_RENDER_THEME.fg(color, text)}`;
	};
	const liveTheme = new Proxy(PLAIN_RENDER_THEME, {
		get(target, key) {
			if (key === "fg") {
				return countFg;
			}
			if (key === "colors") {
				return themeVersion;
			}
			const value: unknown = Reflect.get(target, key, target);
			return value;
		},
	});
	cached.setResult(longResult, { expanded: false, isPartial: false }, liveTheme, false);
	assert.ok(colorCalls > 20, "initial JSON tokens are colorized");
	const firstCachedLines = cached.render(80);
	colorCalls = 0;
	const setTextDescriptor = Object.getOwnPropertyDescriptor(Text.prototype, "setText");
	assert.ok(setTextDescriptor);
	const nativeSetText: unknown = setTextDescriptor.value;
	assert.ok(typeof nativeSetText === "function");
	let resets = 0;
	Text.prototype.setText = function (value) {
		resets++;
		Reflect.apply(nativeSetText, this, [value]);
	};
	try {
		for (let index = 0; index < 100; index++) {
			cached.setResult(
				{
					...longResult,
					content: [...longResult.content],
					details: { summary: "large JSON result" },
				},
				{ expanded: index % 2 === 0, isPartial: false },
				liveTheme,
				false,
			);
		}
		assert.equal(
			colorCalls,
			0,
			"unchanged row updates must not parse/colorize the complete output again",
		);
		cached.setResult(
			{ ...longResult, details: { summary: "changed summary, identical visible output" } },
			{ expanded: false, isPartial: false },
			liveTheme,
			false,
		);
		assert.equal(resets, 0, "identical formatted output must retain the native Text layout cache");
	} finally {
		Object.defineProperty(Text.prototype, "setText", setTextDescriptor);
	}
	assert.deepEqual(cached.render(80), firstCachedLines);
	cached.setResult(longResult, { expanded: true, isPartial: false }, liveTheme, false);
	assert.match(cached.render(24).join("\n"), /item-24/);
	cached.setResult(failedResult, { expanded: false, isPartial: false }, liveTheme, true);
	assert.match(cached.render(200).join("\n"), /selector-not-found/);
	cached.setResult(
		{ ...failedResult, details: { resultCategory: "failure", failureCategory: "timeout" } },
		{ expanded: false, isPartial: false },
		liveTheme,
		true,
	);
	assert.match(cached.render(200).join("\n"), /failureCategory: timeout/);
	cached.setResult(longResult, { expanded: false, isPartial: true }, liveTheme, false);
	assert.match(cached.render(200).join("\n"), /Running agent-browser/);
	themeVersion = {};
	themePrefix = "changed-theme:";
	cached.setResult(longResult, { expanded: false, isPartial: false }, liveTheme, false);
	assert.match(cached.render(200).join("\n"), /changed-theme:/);

	const scalarResult: AgentToolResult<unknown> = {
		content: [
			{
				type: "text",
				text: "Clicked: true\x1B[31m red\x1B[0m\nHref: https://example.com/next\x1B]0;pwned\x07\nNull\x00byte\nEmoji: 👩‍💻\nSeparator: left\u2028right",
			},
		],
		details: { summary: "click completed" },
	};
	const scalarText = renderResult(
		scalarResult,
		{ expanded: false, isPartial: false },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params }),
	)
		.render(120)
		.join("\n");
	// Scalar output must strip NUL, BEL, and terminal escape controls.
	// oxlint-disable-next-line no-control-regex
	assert.doesNotMatch(scalarText, /[\x00\x07\x1B]/);
	assert.match(scalarText, /<toolOutput>Clicked: true red<\/toolOutput>/);
	assert.match(scalarText, /Null�byte/);
	assert.match(scalarText, /Emoji: 👩‍💻/);
	assert.match(scalarText, /Separator: left\u2028right/);

	const fallbackResult: AgentToolResult<unknown> = {
		content: [{ type: "text", text: "\x1B[31m\x1B[0m" }],
		details: { summary: "\x1B]0;pwned\x07summary ok" },
	};
	const fallbackText = renderResult(
		fallbackResult,
		{ expanded: false, isPartial: false },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params }),
	)
		.render(120)
		.join("\n");
	// Fallback prose must strip NUL, BEL, and terminal escape controls too.
	// oxlint-disable-next-line no-control-regex
	assert.doesNotMatch(fallbackText, /[\x00\x07\x1B]/);
	assert.match(fallbackText, /<success>summary ok<\/success>/);
});

test("agentBrowserExtension blocks direct and wrapped agent-browser bash unless the prompt, env, or package dev cwd explicitly allows it", async (t) => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-bash-policy-"));
	t.after(async () => await rm(tempDir, { force: true, recursive: true }));
	const defaultHarness = createExtensionHarness({
		cwd: tempDir,
		prompt: "Open a page and summarize it.",
	});
	const noHistoryCtx = {
		...defaultHarness.ctx,
		sessionManager: {
			...defaultHarness.ctx.sessionManager,
			getBranch() {
				throw new Error("Unrelated tool calls must not copy the branch");
			},
			getEntry() {
				throw new Error("Unrelated tool calls must not query history");
			},
		},
	};
	for (const event of [
		{ toolName: "read", input: { path: "README.md" } },
		{ toolName: "agent_browser_tools", input: {} },
		{ toolName: "bash", input: { command: "printf audit" } },
		{ toolName: "bash", input: { command: "which agent-browser" } },
	]) {
		// Every fixed unrelated event must bypass browser-history inspection.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(
			// Preserve event order against the shared branch-history guard fixture.
			// oxlint-disable-next-line no-await-in-loop
			await runExtensionEventResults(defaultHarness.handlers, "tool_call", event, noHistoryCtx),
			[],
		);
	}
	for (const command of [
		"agent-browser open https://example.com",
		"FOO=bar agent-browser --version",
		'FOO="bar baz" agent-browser --version',
		"PATH=/tmp:$PATH agent-browser open https://example.com",
		"echo ready\nagent-browser open https://example.com",
		"which agent-browser && agent-browser open https://example.com",
		"cat <<'EOF'\nwhich agent-browser\nEOF\nagent-browser open https://example.com",
		"env agent-browser --version",
		"npx --yes agent-browser open https://example.com",
		"pnpm dlx agent-browser open https://example.com",
		"/opt/homebrew/bin/agent-browser open https://example.com",
	]) {
		// Shell probes share mutable user-intent and branch state.
		// oxlint-disable-next-line no-await-in-loop
		const [blocked] = await runExtensionEventResults(
			defaultHarness.handlers,
			"tool_call",
			{ toolName: "bash", input: { command } },
			defaultHarness.ctx,
		);
		// Every command in this fixed execution inventory must be blocked.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(readRecord(blocked).block, true, command);
		// Every blocked spelling must point to the native tool.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.match(
			readString(readRecord(blocked).reason),
			/Use the native agent_browser tool instead of bash/i,
		);
	}

	const userMessage = {
		role: "user",
		content: "Please debug the browser integration via bash.",
		timestamp: 0,
	};
	await runExtensionEvent(
		defaultHarness.handlers,
		"message_end",
		{ message: userMessage },
		defaultHarness.ctx,
	);
	const directEvent = {
		toolName: "bash",
		input: { command: "agent-browser open https://example.com" },
	};
	assert.deepEqual(
		await runExtensionEventResults(defaultHarness.handlers, "tool_call", directEvent, noHistoryCtx),
		[],
	);
	// Pi applies later message_end replacements to this same message before persistence.
	userMessage.content = "Open a page and summarize it.";
	const [blockedAfterReplacement] = await runExtensionEventResults(
		defaultHarness.handlers,
		"tool_call",
		directEvent,
		noHistoryCtx,
	);
	assert.equal(readRecord(blockedAfterReplacement).block, true);
	userMessage.content = "Please debug the browser integration via bash.";
	await runExtensionEvent(
		defaultHarness.handlers,
		"session_tree",
		{ newLeafId: "original", oldLeafId: "steered" },
		defaultHarness.ctx,
	);
	const [blockedAfterTree] = await runExtensionEventResults(
		defaultHarness.handlers,
		"tool_call",
		directEvent,
		noHistoryCtx,
	);
	assert.equal(
		readRecord(blockedAfterTree).block,
		true,
		"branch navigation restores raw user intent instead of retaining steered text",
	);

	const inspectionAllowed = await runExtensionEventResults(
		defaultHarness.handlers,
		"tool_call",
		{ toolName: "bash", input: { command: "which agent-browser" } },
		defaultHarness.ctx,
	);
	assert.deepEqual(inspectionAllowed, []);

	for (const command of [
		"echo agent-browser",
		"grep agent-browser README.md",
		"printf '%s\\n' agent-browser",
		"echo ok && grep agent-browser README.md",
		"cat <<'EOF'\nagent-browser open https://example.com\nEOF",
	]) {
		// Preserve shell-probe order against the shared user-intent/branch fixture.
		// oxlint-disable-next-line no-await-in-loop
		const innocuousResults = await runExtensionEventResults(
			defaultHarness.handlers,
			"tool_call",
			{ toolName: "bash", input: { command } },
			defaultHarness.ctx,
		);
		// Every command in this fixed non-execution inventory must pass without a block.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(innocuousResults, [], command);
	}

	const debugHarness = createExtensionHarness({
		cwd: tempDir,
		prompt: "Please debug the browser integration via bash.",
	});
	const debugAllowed = await runExtensionEventResults(
		debugHarness.handlers,
		"tool_call",
		{ toolName: "bash", input: { command: "npx --yes agent-browser open https://example.com" } },
		debugHarness.ctx,
	);
	assert.deepEqual(debugAllowed, []);

	await withPatchedEnv({ PI_AGENT_BROWSER_ALLOW_DIRECT_BASH: "1" }, async () => {
		const envAllowed = await runExtensionEventResults(
			defaultHarness.handlers,
			"tool_call",
			{ toolName: "bash", input: { command: "agent-browser open https://example.com" } },
			defaultHarness.ctx,
		);
		assert.deepEqual(envAllowed, []);
	});

	const packageDevDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-package-dev-"));
	t.after(async () => await rm(packageDevDir, { force: true, recursive: true }));
	await writeFile(
		join(packageDevDir, "package.json"),
		JSON.stringify({ name: "pi-agent-browser-native" }),
		"utf8",
	);
	const packageDevHarness = createExtensionHarness({
		cwd: packageDevDir,
		prompt: "Open a page and summarize it.",
	});
	const packageDevAllowed = await runExtensionEventResults(
		packageDevHarness.handlers,
		"tool_call",
		{ toolName: "bash", input: { command: "agent-browser open https://example.com" } },
		packageDevHarness.ctx,
	);
	assert.deepEqual(packageDevAllowed, []);
});

test("agentBrowserExtension keeps the page verified after a failed eval by probing the live URL", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-eval-reverify-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const valueFlags = new Set(["--session", "--namespace", "--profile", "--state", "--session-name", "--restore-save", "--restore-check-url", "--restore-check-text", "--restore-check-fn", "--cdp", "--provider", "-p", "--device"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === "--json") continue;
  if (valueFlags.has(token)) { i += 1; continue; }
  if (token.startsWith("--")) continue;
  commandIndex = i;
  break;
}
const command = args[commandIndex];
const sub = args[commandIndex + 1];
let out;
if (command === "open") out = { success: true, data: { title: "Example", url: "https://example.test/" } };
else if (command === "eval") out = { success: false, error: "Evaluation error: SyntaxError: Identifier 'c' has already been declared" };
else if (command === "get" && sub === "url") out = { success: true, data: { url: "https://example.test/" } };
else if (command === "get" && sub === "title") out = { success: true, data: { title: "Example" } };
process.stdout.write(JSON.stringify(out));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Iterate on page evals." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://example.test/"],
			});
			assert.equal(opened.isError, false);

			const failed = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "const c = 1;"],
			});
			assert.equal(failed.isError, true);
			assert.match(readString(readRecord(failed.content.at(0)).text), /already been declared/);

			const invocationsAfterFailure = await readInvocationLog(logPath);
			const evalIndex = invocationsAfterFailure.findIndex((entry) => entry.args.includes("eval"));
			assert.ok(evalIndex >= 0);
			assert.ok(
				invocationsAfterFailure.some(
					(entry, index) =>
						index > evalIndex && entry.args.includes("get") && entry.args.includes("url"),
				),
				"wrapper should probe get url after the failed eval",
			);

			const retried = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "const c = 2;"],
			});
			assert.equal(retried.isError, true);
			assert.equal(readRecord(retried.details).failureCategory, "upstream-error");
			assert.doesNotMatch(readString(readRecord(retried.content.at(0)).text), /became unverified/);
			const finalInvocations = await readInvocationLog(logPath);
			assert.equal(finalInvocations.filter((entry) => entry.args.includes("eval")).length, 2);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension skips the title probe when the live URL already has an observed title", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-title-reuse-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "nav-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const valueFlags = new Set(["--session", "--namespace", "--profile", "--state", "--session-name", "--restore-save", "--restore-check-url", "--restore-check-text", "--restore-check-fn", "--cdp", "--provider", "-p", "--device"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === "--json") continue;
  if (valueFlags.has(token)) { i += 1; continue; }
  if (token.startsWith("--")) continue;
  commandIndex = i;
  break;
}
const command = args[commandIndex];
const sub = args[commandIndex + 1];
let state = { navigated: false };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (command === "reload") { state.navigated = true; fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state)); }
const url = state.navigated ? "https://example.test/b" : "https://example.test/a";
let out;
if (command === "open") out = { success: true, data: { title: "Example A", url: "https://example.test/a" } };
else if (command === "click") out = { success: true, data: { clicked: args[commandIndex + 1] } };
else if (command === "reload") out = { success: true, data: { reloaded: true } };
else if (command === "get" && sub === "url") out = { success: true, data: { url } };
else if (command === "get" && sub === "title") out = { success: true, data: { title: state.navigated ? "Example B" : "Example A" } };
process.stdout.write(JSON.stringify(out));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Click around a docs page." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://example.test/a"],
			});
			assert.equal(opened.isError, false);

			const clicked = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["click", "#x"],
			});
			assert.equal(clicked.isError, false);
			const afterClick = await readInvocationLog(logPath);
			assert.ok(
				afterClick.some((entry) => entry.args.includes("get") && entry.args.includes("url")),
				"href-less click should probe get url",
			);
			assert.equal(
				afterClick.filter((entry) => entry.args.includes("get") && entry.args.includes("title"))
					.length,
				0,
				"same-URL probe should reuse the observed title",
			);

			const reloaded = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["reload"] });
			assert.equal(reloaded.isError, false);
			assert.match(readString(readRecord(reloaded.content.at(0)).text), /Example B/);
			const afterReload = await readInvocationLog(logPath);
			assert.equal(
				afterReload.filter((entry) => entry.args.includes("get") && entry.args.includes("title"))
					.length,
				1,
				"changed-URL probe should read the title once",
			);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
