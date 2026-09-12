import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { extractUpstreamCommandTokens } from "../extensions/agent-browser/lib/argv-descriptor.js";
import { getExplicitSessionPageVerificationRequirement, getPageTargetValidationError } from "../extensions/agent-browser/lib/page-target-validation.js";
import { buildExecutionPlan } from "../extensions/agent-browser/lib/runtime.js";
import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

const urlReads = [
	["read", "https://public.test/guide.md"],
	["read", "--raw", "public.test/guide", "--timeout", "50"],
	["read", "--filter", "https://filter.test/not-a-target", "--llms", "full", "public.test"],
	["read", "public.test", "--outline", "--filter", "bearer token"],
];

const invalidReads = [
	["read", "public.test", "--filter"], ["read", "public.test", "another.test"], ["read", "public.test", "--unknown"],
	["read", "--unknown"], ["read", "--timeout", "0"], ["read", "--llms", "bad"], ["read", "--llms", "full", "--outline"],
];

test("explicit URL reads follow native operands without requiring a page or implicit session", () => {
	for (const args of [...urlReads, ...invalidReads]) {
		assert.equal(getPageTargetValidationError({ args, pageUrlUnknown: true }), undefined, args.join(" "));
		assert.equal(getExplicitSessionPageVerificationRequirement({ args: ["--session", "shared", ...args] }), undefined);
		const plan = buildExecutionPlan(args, { freshSessionName: "fresh", managedSessionActive: true, managedSessionName: "owned", sessionMode: "fresh" });
		assert.equal(plan.managedSessionName, undefined);
		assert.equal(plan.usedImplicitSession, false);
	}
	for (const args of [["read"], ["read", "--filter", "https://not-a-target.test"], ["read", "--llms", "full"], ["read", "--filter", "--llms", "--outline"], ["read", "--llms", "index", "--filter", "--outline"]]) {
		assert.match(getExplicitSessionPageVerificationRequirement({ args }) ?? "", /unverified/);
	}
	assert.equal(getPageTargetValidationError({ args: ["batch"], stdin: JSON.stringify(urlReads), pageUrlUnknown: true }), undefined);
	assert.equal(getPageTargetValidationError({ args: ["batch"], stdin: JSON.stringify([["read", "--profile", "public.test"]]), pageUrlUnknown: true }), undefined, "invalid native row flags cannot turn a browserless read into a page probe");
	assert.equal(getPageTargetValidationError({ args: ["batch", "read --raw public.test"], stdin: JSON.stringify([["snapshot", "-i"]]), pageUrlUnknown: true }), undefined);
});

test("shared URL reads and their timeouts dispatch no page helpers; bare reads still verify", { concurrency: false }, async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-url-read-"));
	const logPath = join(root, "calls.jsonl");
	await writeFakeAgentBrowserBinary(root, `const fs = require('node:fs');
const args = process.argv.slice(2), stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + '\\n');
const tokens = [];
for (let i = 0; i < args.length; i++) {
  if (['--session', '--namespace', '--profile'].includes(args[i])) i++;
  else if (args[i] !== '--json') tokens.push(args[i]);
}
const rawRows = tokens[0] === 'batch' ? tokens.slice(1).filter(token => token !== '--bail') : [];
const batchRows = tokens[0] === 'batch' ? rawRows.length ? rawRows.map(row => row.split(' ')) : JSON.parse(stdin) : undefined;
const data = batchRows ? batchRows.map(command => ({ command, success: true, result: { source: 'http', content: 'bearer token', url: 'https://public.test' } }))
  : tokens[0] === 'session' ? { session: args[args.indexOf('--session') + 1], active: false, runtime: null }
  : tokens[0] === 'read' ? { source: 'http', content: 'bearer token', url: 'https://public.test' }
  : { url: 'https://shared.test/current', title: 'Shared page' };
if ((batchRows ?? [tokens]).some(row => row.includes('timeout.test'))) setInterval(() => {}, 1000);
else if (${JSON.stringify(invalidReads)}.some(row => JSON.stringify(row) === JSON.stringify(tokens))) { process.stdout.write(JSON.stringify({ success: false, error: 'Native read argument error' })); process.exitCode = 1; }
else process.stdout.write(JSON.stringify({ success: true, data }));`);
	try {
		await withPatchedEnv({ PATH: `${root}${delimiter}${process.env.PATH ?? ""}`, HOME: root, USERPROFILE: root, AGENT_BROWSER_SESSION: "shared", AGENT_BROWSER_NAMESPACE: "reader-scope", PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1" }, async () => {
			const harness = createExtensionHarness({ cwd: root });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			for (const params of [
				...urlReads.map((args) => ({ args })),
				{ args: ["batch"], stdin: JSON.stringify(urlReads) },
				{ args: ["--profile", "/exact/untouched-profile", "read", "public.test"], sessionMode: "fresh" },
			]) {
				await writeFile(logPath, "");
				const result = await executeRegisteredTool(harness.tool, harness.ctx, params);
				assert.equal(result.isError, false, result.content[0]?.text);
				assert.deepEqual((await readInvocationLog(logPath)).map((row) => extractUpstreamCommandTokens(row.args)[0]), [params.args.includes("batch") ? "batch" : "read"]);
				assert.equal(result.details?.usedImplicitSession, false);
			}
			for (const args of invalidReads) {
				await writeFile(logPath, "");
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { args });
				assert.equal(result.isError, true);
				assert.match(result.content[0]?.text ?? "", /Native read argument error/);
				assert.deepEqual((await readInvocationLog(logPath)).map(row => extractUpstreamCommandTokens(row.args)), [args]);
			}
			for (const params of [
				{ args: ["read", "timeout.test"] },
				{ args: ["batch"], stdin: JSON.stringify([["read", "public.test"], ["read", "timeout.test"]]) },
				{ args: ["batch", "read timeout.test"], stdin: JSON.stringify([["snapshot", "-i"]]) },
			]) {
				await writeFile(logPath, "");
				const timeout = await executeRegisteredTool(harness.tool, harness.ctx, { ...params, timeoutMs: 150 });
				assert.equal(timeout.details?.failureCategory, "timeout");
				assert.deepEqual((await readInvocationLog(logPath)).map((row) => extractUpstreamCommandTokens(row.args)[0]), [params.args[0]]);
			}
			await writeFile(logPath, "");
			const bare = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["read"] });
			assert.equal(bare.isError, false, bare.content[0]?.text);
			assert.deepEqual((await readInvocationLog(logPath)).map((row) => extractUpstreamCommandTokens(row.args)), [["get", "url"], ["read"]]);
			await writeFile(logPath, "");
			const sharedInfo = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["session", "info"] });
			assert.equal((sharedInfo.details?.data as { piCleanupOwnership: string }).piCleanupOwnership, "caller-owned");
			assert.deepEqual((await readInvocationLog(logPath)).map(row => extractUpstreamCommandTokens(row.args)), [["session", "info"]]);
			await withPatchedEnv({ AGENT_BROWSER_SESSION: undefined }, async () => {
				const opened = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://owned.test/"] });
				assert.equal(opened.isError, false, opened.content[0]?.text);
				await writeFile(logPath, "");
				const read = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--profile", "/unused/profile", "read", "public.test"], sessionMode: "fresh" });
				assert.equal(read.isError, false, read.content[0]?.text);
				assert.equal(read.details?.managedSessionOutcome, undefined);
				assert.deepEqual((await readInvocationLog(logPath)).map(row => extractUpstreamCommandTokens(row.args)), [["read", "public.test"]]);
				await writeFile(logPath, "");
				const ownedInfo = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--namespace", "", "--session", String(opened.details?.sessionName), "session", "info"] });
				assert.equal(ownedInfo.isError, false, ownedInfo.content[0]?.text);
				assert.equal((ownedInfo.details?.data as { piCleanupOwnership: string }).piCleanupOwnership, "wrapper-managed");
				assert.deepEqual((await readInvocationLog(logPath)).map(row => extractUpstreamCommandTokens(row.args)), [["session", "info"]]);
			});
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
