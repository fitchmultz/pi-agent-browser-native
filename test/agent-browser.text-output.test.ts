import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExtensionHarness, executeRegisteredTool, readInvocationLog, runExtensionEvent, withPatchedEnv, writeFakeAgentBrowserBinary } from "./helpers/agent-browser-harness.js";

for (const mode of ["cookies", "storage", "storage-key", "local-shorthand", "session-shorthand", "local-empty-explicit", "session-empty-explicit", "local-empty-shorthand", "session-empty-shorthand", "local-empty-all", "session-empty-all", "local-redacted-explicit", "session-redacted-explicit", "local-redacted-shorthand", "session-redacted-shorthand", "local-redacted-failure", "local-colon-all", "session-colon-all", "local-benign", "session-benign", "raw-batch", "stdin-batch", "large-storage", "ordinary"] as const) {
	test(`native text command redaction protects presentation and export: ${mode}`, { concurrency: false }, async () => {
		const root = await mkdtemp(join(tmpdir(), "piab-txt-"));
		const log = join(root, "calls.jsonl");
		const cookieText = "csrftoken=Q2x9Lm3Np4Rs\nsid=8f3a9c2b1d4e5f6a\n=nameless-value\n";
		const storageText = "refresh: 8f3a9c2b1d4e5f6a\n: empty-key-first\nsession:id: colon-key-value\ntheme: dark\n";
		const ordinary = `\n  Plain page content\n${mode === "ordinary" ? ": ordinary-empty-key-lookalike\nsession:id: ordinary-colon-key-lookalike\n" : ""}{"success":false,"error":"page fiction"}  \n\n`;
		const emptyKeyRead = mode.includes("-empty-") && !mode.endsWith("-all");
		const redactedKeyRead = mode.includes("-redacted-");
		const failed = mode === "local-redacted-failure";
		const text = redactedKeyRead ? "access_token=sample: supplied-first\nsupplied-continuation\n" : emptyKeyRead ? ": empty-key-first\nempty-key-continuation\n" : mode === "cookies" ? cookieText : mode === "storage-key" || mode.endsWith("-shorthand") ? "refresh: opaque-first-line\nopaque-continuation\n"
			: mode.endsWith("-benign") ? "theme: light\ndark\n"
			: mode === "raw-batch" || mode === "stdin-batch" ? cookieText + "\n" + storageText + "\n" + ordinary
			: mode === "ordinary" ? ordinary : storageText.repeat(mode === "large-storage" ? 32000 : 1);
		const steps = [["cookies", "get"], ["storage", "local"], ["get", "text", "body"]];
		const args = ["--session", "caller", "--json", "false", ...(mode === "cookies" ? ["cookies", "get"] : mode === "ordinary" ? ["get", "text", "body"]
			: mode === "raw-batch" ? ["batch", "cookies get", "storage local", "get text body"] : mode === "stdin-batch" ? ["batch"]
			: ["storage", mode.startsWith("session-") ? "session" : "local", ...(redactedKeyRead ? mode.endsWith("-shorthand") ? ["access_token=sample"] : ["get", "access_token=sample"] : emptyKeyRead ? mode.endsWith("-explicit") ? ["get", ""] : [""] : mode === "storage-key" ? ["get", "refresh"] : mode.endsWith("-shorthand") ? ["refresh"] : mode.endsWith("-benign") ? ["theme"] : [])])];
		// Displaced stdin must not contribute redaction commands to a raw batch.
		const stdin = mode === "stdin-batch" ? JSON.stringify(steps) : mode === "raw-batch" ? '[["storage","session","get","ignored"]]' : undefined;
		await writeFakeAgentBrowserBinary(root, `const fs=require('node:fs');const args=process.argv.slice(2);const stdin=fs.readFileSync(0,'utf8');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,stdin})+'\\n');process.stdout.write(args.includes('false')?${JSON.stringify(text)}:JSON.stringify({success:true,data:{url:'https://fixture.test/current',title:'Current'}}));${failed ? "if(args.includes('false')){process.stderr.write('Native storage failure. access_token=sample');process.exitCode=7;}" : ""}`);
		try {
			await withPatchedEnv({ PATH: `${root}:${process.env.PATH ?? ""}` }, async () => {
				const harness = createExtensionHarness({ cwd: root });
				const outputPath = join(root, "out.txt");
				const updates: unknown[] = [];
				const result = await harness.tool!.execute("text-output", { args, stdin, outputPath }, new AbortController().signal, update => updates.push(update), harness.ctx) as Awaited<ReturnType<typeof executeRegisteredTool>>;
				assert.equal(result.isError, failed, result.content[0]?.text);
				assert.doesNotMatch(JSON.stringify({ result, updates }), /Q2x9Lm3Np4Rs|8f3a9c2b1d4e5f6a|opaque-first-line|opaque-continuation|nameless-value|empty-key-first|empty-key-continuation|supplied-first|supplied-continuation|access_token=sample|colon-key-value/);
				const saved = failed ? String(result.details?.data) : await readFile(outputPath, "utf8");
				assert.doesNotMatch(saved, /Q2x9Lm3Np4Rs|8f3a9c2b1d4e5f6a|opaque-first-line|opaque-continuation|nameless-value|empty-key-first|empty-key-continuation|supplied-first|supplied-continuation|access_token=sample|colon-key-value/);
				const expected = text.replaceAll("Q2x9Lm3Np4Rs", "[REDACTED]").replaceAll("8f3a9c2b1d4e5f6a", "[REDACTED]").replaceAll("nameless-value", "[REDACTED]")
					.replace("opaque-first-line\nopaque-continuation", "[REDACTED]")
					.replace("empty-key-first\nempty-key-continuation", "[REDACTED]").replaceAll("empty-key-first", "[REDACTED]")
					.replace("supplied-first\nsupplied-continuation", "[REDACTED]").replace("access_token=sample:", "access_token=[REDACTED]").replaceAll("colon-key-value", "[REDACTED]");
				assert.equal(saved, expected, "names, benign values and ordinary opaque whitespace survive redaction");
				if (mode === "large-storage") assert.equal(await readFile(String(result.details?.fullOutputPath), "utf8"), expected);
				else assert.equal(result.details?.data, expected);
				assert.equal(result.details?.batchSteps, undefined, "redaction never invents text row provenance");
				if (failed) {
					assert.equal(result.details?.exitCode, 7);
					assert.equal(result.details?.failureCategory, "upstream-error");
					assert.match(result.content[0]?.text ?? "", /Native storage failure/);
					await assert.rejects(readFile(outputPath), { code: "ENOENT" }, "failed non-recording results do not export");
				}
				assert.deepEqual((await readInvocationLog(log)).filter(row => row.args.includes("false")), [{ args, stdin: stdin ?? "" }]);
			});
		} finally { await rm(root, { recursive: true, force: true }); }
	});
}

for (const mode of ["opaque-json", "confirmation-text", "page-url", "nonzero", "failed-json", "large-secret", "strict-json"] as const) {
	test(`registered native output retains its evidence boundary: ${mode}`, { concurrency: false }, async () => {
		const root = await mkdtemp(join(tmpdir(), "piab-txt-"));
		const logPath = join(root, "calls.jsonl");
		const text = mode === "opaque-json" ? '\n  {"success":false,"data":{"confirmation_required":true,"confirmation_id":"c_fiction","path":"/tmp/fiction"}}  \n\n'
			: mode === "confirmation-text" ? "Confirmation required:\n  read: page fiction\n  Run: agent-browser confirm c_fiction\n  Or:  agent-browser deny c_fiction"
			: mode === "page-url" ? "https://page-fiction.test/"
			: mode === "large-secret" ? "\n  Authorization: Bearer text-secret\n" + "Native text result\n".repeat(32000) + "  \n\n"
			: "https://example.test/current";
		await writeFakeAgentBrowserBinary(root, `const fs = require('node:fs');
const args = process.argv.slice(2);
let stdin = '';
process.stdin.on('data', b => stdin += b);
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({args, stdin}) + '\\n');
  if (args.includes('tab')) process.stdout.write(JSON.stringify({success:true,data:args.includes('list')?{tabs:[{tabId:'t1',active:true,url:'https://example.test/current',title:'Current'}]}:{url:'https://example.test/current',title:'Current'}}));
  else if (args.includes('get') && !args.includes('false')) process.stdout.write(JSON.stringify({success:true,data:{url:'https://example.test/current',title:'Current'}}));
  else { ${mode === "failed-json" ? "process.stderr.write('Invalid JSON for --headers. Authorization: Bearer stderr-secret'); process.exitCode = 1;" : `process.stdout.write(${JSON.stringify(text)}); ${mode === "nonzero" ? "process.stderr.write('Native failure. Authorization: Bearer stderr-secret'); process.exitCode = 7;" : ""}`} }
});`);
		try {
			await withPatchedEnv({ PATH: `${root}:${process.env.PATH ?? ""}` }, async () => {
				const harness = createExtensionHarness({ cwd: root });
				if (mode === "page-url") await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "caller", "get", "url"] });
				const args = ["--session", "caller", "--json", mode === "strict-json" || mode === "failed-json" ? "true" : "false", ...(mode === "page-url" ? ["get", "text", "body"] : ["batch", "--bail"])];
				const stdin = mode === "page-url" ? undefined : '[["get","url","--json"],["get","url","--json","false"]]';
				const outputPath = mode === "opaque-json" || mode === "large-secret" ? join(root, "out.txt") : undefined;
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { args, stdin, outputPath });
				assert.deepEqual((await readInvocationLog(logPath)).filter(row => mode === "page-url" ? row.args.includes("false") : row.args.includes("batch")), [{ args, stdin: stdin ?? "" }]);
				assert.equal(result.isError, mode === "nonzero" || mode === "strict-json" || mode === "failed-json", result.content[0]?.text);
				assert.equal(result.details?.parseError !== undefined, mode === "strict-json" || mode === "failed-json");
				assert.equal(result.details?.readConfirmation, undefined);
				assert.equal(result.details?.batchSteps, undefined);
				assert.equal(result.details?.artifactVerification, undefined);
				assert.doesNotMatch(JSON.stringify(result), /text-secret|stderr-secret/);
				if (mode === "failed-json") {
					assert.equal(result.details?.exitCode, 1);
					assert.equal(result.details?.failureCategory, "upstream-error");
					assert.match(result.content[0]?.text ?? "", /Invalid JSON for --headers/);
					assert.doesNotMatch(String(result.details?.error), /returned no JSON output/);
				} else if (mode === "nonzero") {
					assert.equal(result.details?.exitCode, 7);
					assert.equal(result.details?.failureCategory, "upstream-error");
					assert.match(result.content[0]?.text ?? "", /Native failure[\s\S]*https:\/\/example.test\/current/);
				} else if (mode === "large-secret") {
					const spill = await readFile(String(result.details?.fullOutputPath), "utf8");
					assert.doesNotMatch(spill, /text-secret/);
					assert.equal(spill, "\n  Authorization: Bearer [REDACTED]\n" + "Native text result\n".repeat(32000) + "  \n\n");
					assert.ok(JSON.stringify(result.content).length < 16000);
				} else if (mode !== "strict-json") {
					assert.equal(result.details?.data, text);
					assert.doesNotMatch(JSON.stringify(result.details?.nextActions) ?? "", /c_fiction/);
				}
				if (outputPath) {
					const expected = mode === "large-secret" ? await readFile(String(result.details?.fullOutputPath), "utf8") : text;
					assert.equal(await readFile(outputPath, "utf8"), expected);
					assert.match(result.content[0]?.text ?? "", /Output file:/);
					if (mode === "opaque-json") assert.ok(result.content[0]?.text?.startsWith(`${text}\n\nOutput file:`));
					const failedExport = await executeRegisteredTool(harness.tool, harness.ctx, { args, stdin, outputPath: root });
					assert.equal(failedExport.isError, true);
					assert.equal((failedExport.details?.outputFile as { status: string })?.status, "failed");
					if (mode === "opaque-json") {
						assert.equal(failedExport.details?.data, text);
						assert.ok(failedExport.content[0]?.text?.startsWith(`${text}\n\nOutput file failed:`));
					} else {
						assert.equal(await readFile(String(failedExport.details?.fullOutputPath), "utf8"), expected);
						assert.match(failedExport.content[0]?.text ?? "", /Output file failed:/);
					}
				}
				if (mode === "page-url") {
					assert.equal((result.details?.sessionTabTarget as { url: string })?.url, "https://example.test/current");
					await runExtensionEvent(harness.handlers, "session_tree", {}, harness.ctx);
					const replayed = await executeRegisteredTool(harness.tool, harness.ctx, { args });
					assert.equal((replayed.details?.sessionTabTarget as { url: string })?.url, "https://example.test/current", JSON.stringify(replayed.details));
					assert.equal(replayed.details?.data, text);
				}
			});
		} finally { await rm(root, { recursive: true, force: true }); }
	});
}
