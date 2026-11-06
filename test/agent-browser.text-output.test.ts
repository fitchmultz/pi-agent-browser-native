import assert from "node:assert/strict";
import { getMessageText } from "../extensions/agent-browser/lib/prompt-policy.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest from "node:test";
import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";
import { readRecord, readArray, readString } from "./helpers/assertions.js";
import {
	extractUpstreamCommandTokens,
	parseCommandInfo,
} from "../extensions/agent-browser/lib/argv-descriptor.js";
import { redactInvocationArgs } from "../extensions/agent-browser/lib/runtime-redaction.js";
import { buildToolPresentation } from "../extensions/agent-browser/lib/results/presentation.js";

function redactionText(
	mode: string,
	cookieText: string,
	storageText: string,
	ordinary: string,
): string {
	if (mode.includes("-redacted-")) {
		return "access_token=sample: supplied-first\nsupplied-continuation\n";
	}
	if (mode.includes("-empty-") && !mode.endsWith("-all")) {
		return ": empty-key-first\nempty-key-continuation\n";
	}
	if (mode === "cookies") {
		return cookieText;
	}
	if (mode === "storage-key" || mode.endsWith("-shorthand")) {
		return "refresh: opaque-first-line\nopaque-continuation\n";
	}
	if (mode.endsWith("-benign")) {
		return "theme: light\ndark\n";
	}
	if (mode === "raw-batch" || mode === "stdin-batch") {
		return cookieText + "\n" + storageText + "\n" + ordinary;
	}
	if (mode === "ordinary") {
		return ordinary;
	}
	return storageText.repeat(mode === "large-storage" ? 32000 : 1);
}

function redactionCommand(mode: string): string[] {
	if (mode === "cookies") {
		return ["cookies", "get"];
	}
	if (mode === "ordinary") {
		return ["get", "text", "body"];
	}
	if (mode === "raw-batch") {
		return ["batch", "cookies get", "storage local", "get text body"];
	}
	if (mode === "stdin-batch") {
		return ["batch"];
	}
	let operands: string[] = [];
	if (mode.includes("-redacted-")) {
		operands = mode.endsWith("-shorthand")
			? ["access_token=sample"]
			: ["get", "access_token=sample"];
	} else if (mode.includes("-empty-") && !mode.endsWith("-all")) {
		operands = mode.endsWith("-explicit") ? ["get", ""] : [""];
	} else if (mode === "storage-key") {
		operands = ["get", "refresh"];
	} else if (mode.endsWith("-shorthand")) {
		operands = ["refresh"];
	} else if (mode.endsWith("-benign")) {
		operands = ["theme"];
	}
	return ["storage", mode.startsWith("session-") ? "session" : "local", ...operands];
}

function observationText(mode: string): string {
	switch (mode) {
		case "opaque-json":
			return '\n  {"success":false,"data":{"confirmation_required":true,"confirmation_id":"c_fiction","path":"/tmp/fiction"}}  \n\n';
		case "confirmation-text":
			return "Confirmation required:\n  read: page fiction\n  Run: agent-browser confirm c_fiction\n  Or:  agent-browser deny c_fiction";
		case "page-url":
			return "https://page-fiction.test/";
		case "large-secret":
			return (
				"\n  Authorization: Bearer text-secret\n" + "Native text result\n".repeat(32000) + "  \n\n"
			);
		default:
			return "https://example.test/current";
	}
}

const cookieText = "csrftoken=Q2x9Lm3Np4Rs\nsid=8f3a9c2b1d4e5f6a\n=nameless-value\n";
const storageText =
	"refresh: 8f3a9c2b1d4e5f6a\n: empty-key-first\nsession:id: colon-key-value\ntheme: dark\n";

for (const { mode, expected } of [
	{
		mode: "storage",
		expected: "refresh: [REDACTED]\n: [REDACTED]\nsession:id: [REDACTED]\ntheme: dark\n",
	},
	{ mode: "local-shorthand", expected: "refresh: [REDACTED]\n" },
	{ mode: "session-shorthand", expected: "refresh: [REDACTED]\n" },
	{ mode: "local-empty-explicit", expected: ": [REDACTED]\n" },
	{ mode: "session-empty-explicit", expected: ": [REDACTED]\n" },
	{ mode: "local-empty-shorthand", expected: ": [REDACTED]\n" },
	{ mode: "session-empty-shorthand", expected: ": [REDACTED]\n" },
	{
		mode: "session-empty-all",
		expected: "refresh: [REDACTED]\n: [REDACTED]\nsession:id: [REDACTED]\ntheme: dark\n",
	},
	{ mode: "local-redacted-explicit", expected: "access_token=[REDACTED] [REDACTED]\n" },
	{ mode: "session-redacted-explicit", expected: "access_token=[REDACTED] [REDACTED]\n" },
	{ mode: "local-redacted-shorthand", expected: "access_token=[REDACTED] [REDACTED]\n" },
	{ mode: "session-redacted-shorthand", expected: "access_token=[REDACTED] [REDACTED]\n" },
	{ mode: "session-benign", expected: "theme: light\ndark\n" },
]) {
	nodeTest(`native text shape redaction preserves command context: ${mode}`, async () => {
		const args = ["--session", "caller", "--json", "false", ...redactionCommand(mode)];
		const presentation = await buildToolPresentation({
			args: redactInvocationArgs(args),
			commandInfo: { ...parseCommandInfo(args), commandTokens: extractUpstreamCommandTokens(args) },
			cwd: process.cwd(),
			envelope: { success: true, data: redactionText(mode, cookieText, storageText, "") },
			sessionName: "caller",
			textOutput: true,
		});
		assert.equal(presentation.data, expected);
		assert.equal(readString(readRecord(presentation.content[0]).text), expected);
		assert.equal(presentation.batchSteps, undefined);
		assert.equal(presentation.readConfirmation, undefined);
		assert.equal(presentation.artifactVerification, undefined);
		assert.equal(presentation.artifacts, undefined);
		assert.equal(presentation.fullOutputPath, undefined);
	});
}

for (const mode of [
	"cookies",
	"storage-key",
	"local-redacted-failure",
	"local-benign",
	"raw-batch",
	"stdin-batch",
	"large-storage",
	"ordinary",
] as const) {
	nodeTest(
		`native text command redaction protects presentation and export: ${mode}`,
		{ concurrency: false },
		async (t) => {
			const root = await mkdtemp(join(tmpdir(), "piab-txt-"));
			const log = join(root, "calls.jsonl");
			const ordinary = `\n  Plain page content\n${mode === "ordinary" ? ": ordinary-empty-key-lookalike\nsession:id: ordinary-colon-key-lookalike\n" : ""}{"success":false,"error":"page fiction"}  \n\n`;
			const failed = mode === "local-redacted-failure";
			const text = redactionText(mode, cookieText, storageText, ordinary);
			const steps = [
				["cookies", "get"],
				["storage", "local"],
				["get", "text", "body"],
			];
			const args = ["--session", "caller", "--json", "false", ...redactionCommand(mode)];
			// Displaced stdin must not contribute redaction commands to a raw batch.
			let stdin: string | undefined;
			if (mode === "stdin-batch") {
				stdin = JSON.stringify(steps);
			} else if (mode === "raw-batch") {
				stdin = '[["storage","session","get","ignored"]]';
			}
			await writeFakeAgentBrowserBinary(
				root,
				`const fs=require('node:fs');const args=process.argv.slice(2);const stdin=fs.readFileSync(0,'utf8');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,stdin})+'\\n');process.stdout.write(args.includes('false')?${JSON.stringify(text)}:JSON.stringify({success:true,data:{url:'https://fixture.test/current',title:'Current'}}));${failed ? "if(args.includes('false')){process.stderr.write('Native storage failure. access_token=sample');process.exitCode=7;}" : ""}`,
			);
			try {
				await withPatchedEnv({ PATH: `${root}:${process.env.PATH ?? ""}` }, async () => {
					const harness = createExtensionHarness({ cwd: root });
					const outputPath = join(root, "out.txt");
					const updates: unknown[] = [];
					const result = readRecord(
						await harness.tool.execute(
							"text-output",
							{ args, stdin, outputPath },
							new AbortController().signal,
							(update) => {
								updates.push(update);
							},
							harness.ctx,
						),
					);
					assert.equal(
						result.isError,
						failed,
						readString(readRecord(readArray(result.content)[0]).text),
					);
					assert.doesNotMatch(
						JSON.stringify({ result, updates }),
						/Q2x9Lm3Np4Rs|8f3a9c2b1d4e5f6a|opaque-first-line|opaque-continuation|nameless-value|empty-key-first|empty-key-continuation|supplied-first|supplied-continuation|access_token=sample|colon-key-value/,
					);
					const saved = failed
						? readString(readRecord(result.details).data)
						: await readFile(outputPath, "utf8");
					assert.doesNotMatch(
						saved,
						/Q2x9Lm3Np4Rs|8f3a9c2b1d4e5f6a|opaque-first-line|opaque-continuation|nameless-value|empty-key-first|empty-key-continuation|supplied-first|supplied-continuation|access_token=sample|colon-key-value/,
					);
					const expected = text
						.replaceAll("Q2x9Lm3Np4Rs", "[REDACTED]")
						.replaceAll("8f3a9c2b1d4e5f6a", "[REDACTED]")
						.replaceAll("nameless-value", "[REDACTED]")
						.replace("opaque-first-line\nopaque-continuation", "[REDACTED]")
						.replace("empty-key-first\nempty-key-continuation", "[REDACTED]")
						.replaceAll("empty-key-first", "[REDACTED]")
						.replace("supplied-first\nsupplied-continuation", "[REDACTED]")
						.replace("access_token=sample:", "access_token=[REDACTED]")
						.replaceAll("colon-key-value", "[REDACTED]");
					assert.equal(
						saved,
						expected,
						"names, benign values and ordinary opaque whitespace survive redaction",
					);
					if (mode === "large-storage") {
						await t.test("full spill retains redacted text", async () => {
							assert.equal(
								await readFile(readString(readRecord(result.details).fullOutputPath), "utf8"),
								expected,
							);
						});
					} else {
						await t.test("inline data retains redacted text", () => {
							assert.equal(readRecord(result.details).data, expected);
						});
					}
					assert.equal(
						readRecord(result.details).batchSteps,
						undefined,
						"redaction never invents text row provenance",
					);
					if (failed) {
						await t.test("native failure does not export", async () => {
							assert.equal(readRecord(result.details).exitCode, 7);
							assert.equal(readRecord(result.details).failureCategory, "upstream-error");
							assert.match(
								readString(readRecord(readArray(result.content)[0]).text),
								/Native storage failure/,
							);
							await assert.rejects(
								readFile(outputPath),
								{ code: "ENOENT" },
								"failed non-recording results do not export",
							);
						});
					}
					assert.deepEqual(
						(await readInvocationLog(log)).filter((row) => row.args.includes("false")),
						[{ args, stdin: stdin ?? "" }],
					);
				});
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
}

for (const mode of [
	"opaque-json",
	"confirmation-text",
	"page-url",
	"nonzero",
	"failed-json",
	"large-secret",
	"strict-json",
] as const) {
	nodeTest(
		`registered native output retains its evidence boundary: ${mode}`,
		{ concurrency: false },
		async (t) => {
			const root = await mkdtemp(join(tmpdir(), "piab-txt-"));
			const logPath = join(root, "calls.jsonl");
			const text = observationText(mode);
			await writeFakeAgentBrowserBinary(
				root,
				`const fs = require('node:fs');
const args = process.argv.slice(2);
let stdin = '';
process.stdin.on('data', b => stdin += b);
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({args, stdin}) + '\\n');
  if (args.includes('tab')) process.stdout.write(JSON.stringify({success:true,data:args.includes('list')?{tabs:[{tabId:'t1',active:true,url:'https://example.test/current',title:'Current'}]}:{url:'https://example.test/current',title:'Current'}}));
  else if (args.includes('get') && !args.includes('false')) process.stdout.write(JSON.stringify({success:true,data:{url:'https://example.test/current',title:'Current'}}));
  else { ${mode === "failed-json" ? "process.stderr.write('Invalid JSON for --headers. Authorization: Bearer stderr-secret'); process.exitCode = 1;" : `process.stdout.write(${JSON.stringify(text)}); ${mode === "nonzero" ? "process.stderr.write('Native failure. Authorization: Bearer stderr-secret'); process.exitCode = 7;" : ""}`} }
});`,
			);
			try {
				const args = [
					"--session",
					"caller",
					"--json",
					mode === "strict-json" || mode === "failed-json" ? "true" : "false",
					...(mode === "page-url" ? ["get", "text", "body"] : ["batch", "--bail"]),
				];
				const stdin =
					mode === "page-url"
						? undefined
						: '[["get","url","--json"],["get","url","--json","false"]]';
				const outputPath =
					mode === "opaque-json" || mode === "large-secret" ? join(root, "out.txt") : undefined;
				await withPatchedEnv({ PATH: `${root}:${process.env.PATH ?? ""}` }, async () => {
					const harness = createExtensionHarness({ cwd: root });
					if (mode === "page-url") {
						await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["--session", "caller", "get", "url"],
						});
					}

					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args,
						stdin,
						outputPath,
					});
					const details = readRecord(result.details);
					assert.deepEqual(
						(await readInvocationLog(logPath)).filter((row) =>
							mode === "page-url" ? row.args.includes("false") : row.args.includes("batch"),
						),
						[{ args, stdin: stdin ?? "" }],
					);
					assert.equal(
						result.isError,
						mode === "nonzero" || mode === "strict-json" || mode === "failed-json",
						getMessageText(result.content),
					);
					assert.equal(
						details.parseError !== undefined,
						mode === "strict-json" || mode === "failed-json",
					);
					assert.equal(details.readConfirmation, undefined);
					assert.equal(details.batchSteps, undefined);
					assert.equal(details.artifactVerification, undefined);
					assert.doesNotMatch(JSON.stringify(result), /text-secret|stderr-secret/);
					const visibleText = getMessageText(result.content);
					if (mode === "failed-json") {
						await t.test("JSON failure preserves upstream diagnostics", () => {
							assert.equal(details.exitCode, 1);
							assert.equal(details.failureCategory, "upstream-error");
							assert.match(visibleText, /Invalid JSON for --headers/);
							assert.doesNotMatch(readString(details.error), /returned no JSON output/);
						});
					} else if (mode === "nonzero") {
						await t.test("nonzero exit preserves native output", () => {
							assert.equal(details.exitCode, 7);
							assert.equal(details.failureCategory, "upstream-error");
							assert.match(visibleText, /Native failure[\s\S]*https:\/\/example.test\/current/);
						});
					} else if (mode === "large-secret") {
						await t.test("large text is bounded with a redacted full spill", async () => {
							const spill = await readFile(readString(details.fullOutputPath), "utf8");
							assert.doesNotMatch(spill, /text-secret/);
							assert.equal(
								spill,
								"\n  Authorization: Bearer [REDACTED]\n" +
									"Native text result\n".repeat(32000) +
									"  \n\n",
							);
							assert.ok(JSON.stringify(result.content).length < 16000);
						});
					} else if (mode !== "strict-json") {
						await t.test("opaque text cannot fabricate confirmation actions", () => {
							assert.equal(details.data, text);
							assert.doesNotMatch(
								JSON.stringify({ nextActions: details.nextActions }),
								/c_fiction/,
							);
						});
					}
					if (outputPath !== undefined) {
						await t.test("text export", async (exportTest) => {
							const expected =
								mode === "large-secret"
									? await readFile(readString(details.fullOutputPath), "utf8")
									: text;
							assert.equal(await readFile(outputPath, "utf8"), expected);
							assert.match(visibleText, /Output file:/);
							if (mode === "opaque-json") {
								await exportTest.test("opaque JSON prefix survives export", () => {
									assert.ok(visibleText.startsWith(`${text}\n\nOutput file:`));
								});
							}
							const failedExport = await executeRegisteredTool(harness.tool, harness.ctx, {
								args,
								stdin,
								outputPath: root,
							});
							assert.equal(failedExport.isError, true);
							assert.equal(readRecord(failedExport.details?.outputFile).status, "failed");
							if (mode === "opaque-json") {
								await exportTest.test("failed export retains opaque JSON", () => {
									assert.equal(failedExport.details?.data, text);
									assert.ok(
										getMessageText(failedExport.content).startsWith(
											`${text}\n\nOutput file failed:`,
										),
									);
								});
							} else {
								await exportTest.test("failed export retains full spill", async () => {
									assert.equal(
										await readFile(readString(failedExport.details?.fullOutputPath), "utf8"),
										expected,
									);
									assert.match(getMessageText(failedExport.content), /Output file failed:/);
								});
							}
						});
					}
					if (mode === "page-url") {
						await t.test("text URL cannot replace the verified replay target", async () => {
							assert.equal(
								readRecord(details.sessionTabTarget).url,
								"https://example.test/current",
							);
							await runExtensionEvent(harness.handlers, "session_tree", {}, harness.ctx);
							const replayed = await executeRegisteredTool(harness.tool, harness.ctx, { args });
							assert.equal(
								readRecord(replayed.details?.sessionTabTarget).url,
								"https://example.test/current",
								JSON.stringify(replayed.details),
							);
							assert.equal(replayed.details?.data, text);
						});
					}
				});
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
}
