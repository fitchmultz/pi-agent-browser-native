import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
	await mkdir(join(root, ".git"));
	await writeFakeAgentBrowserBinary(root, `const fs = require('node:fs');
const args = process.argv.slice(2), stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin, autosave: process.env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS ?? null, idle: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null, restoreKey: process.env.AGENT_BROWSER_RESTORE ?? null, namespaceEnv: process.env.AGENT_BROWSER_NAMESPACE ?? null, userAgent: process.env.AGENT_BROWSER_USER_AGENT ?? null, config: process.env.AGENT_BROWSER_CONFIG ?? null, argsEnv: process.env.AGENT_BROWSER_ARGS ?? null }) + '\\n');
const tokens = [];
for (let i = 0; i < args.length; i++) {
  if (['--session', '--namespace', '--profile', '--user-agent', '--args', '--config'].includes(args[i])) i++;
  else if (!['--json', '--headed'].includes(args[i])) tokens.push(args[i]);
}
const rawRows = tokens[0] === 'batch' ? tokens.slice(1).filter(token => token !== '--bail') : [];
const batchRows = tokens[0] === 'batch' ? rawRows.length ? rawRows.map(row => row.split(' ')) : JSON.parse(stdin) : undefined;
const data = batchRows ? batchRows.map(command => ({ command, success: true, result: { source: 'http', content: 'bearer token', url: 'https://public.test' } }))
  : tokens[0] === 'session' ? { session: args[args.indexOf('--session') + 1], active: false, runtime: null }
  : tokens[0] === 'read' && tokens[1] === 'public.test/confirm' ? { confirmation_required: true, confirmation_id: 'read-id', action: 'read', capabilities: { readRequiresConfirmation: true } }
  : tokens[0] === 'confirm' ? { confirmed: true, action: 'read', result: { success: true, data: { source: 'http', content: 'Confirmed read' } } }
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
			await withPatchedEnv({ AGENT_BROWSER_SESSION: undefined, AGENT_BROWSER_NAMESPACE: undefined, AGENT_BROWSER_USER_AGENT: undefined, AGENT_BROWSER_HEADED: undefined, AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: undefined, AGENT_BROWSER_IDLE_TIMEOUT_MS: undefined, AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64), PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: undefined }, async () => {
				for (const headed of [false, true]) {
					const url = headed ? "https://owned.test/" : "https://chatgpt.com/";
					await writeFile(logPath, "");
					const opened = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...(headed ? ["--headed"] : []), "open", url], sessionMode: "fresh" });
					assert.equal(opened.isError, false, opened.content[0]?.text);
					const launch = (await readInvocationLog(logPath)).find(row => extractUpstreamCommandTokens(row.args)[0] === "open");
					assert.ok(launch);
					assert.equal((opened.details?.compatibilityWorkaround as { id?: string } | undefined)?.id, headed ? undefined : "chatgpt-headless-user-agent");
					await writeFile(logPath, "");
					const read = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--profile", "/unused/profile", "read", "public.test"], sessionMode: "fresh" });
					assert.equal(read.isError, false, read.content[0]?.text);
					assert.equal(read.details?.managedSessionOutcome, undefined);
					assert.deepEqual((await readInvocationLog(logPath)).map(row => extractUpstreamCommandTokens(row.args)), [["read", "public.test"]]);
					const prefix = ["--namespace", "", "--session", String(opened.details?.sessionName)];
					for (const args of [["read", "public.test"], ["batch", "read public.test"], ["session", "info"], ["confirm", "read-id"], ["--profile", "/caller/profile", "read", "public.test"], ["--args", "--disable-gpu", "read", "public.test"]]) {
						if (args[0] === "confirm") await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "read", "public.test/confirm"] });
						await writeFile(logPath, "");
						const inspection = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, ...args] });
						assert.equal(inspection.isError, false, inspection.content[0]?.text);
						assert.equal(inspection.details?.managedSessionOutcome, undefined);
						assert.equal(inspection.details?.compatibilityWorkaround, undefined);
						assert.equal(inspection.details?.managedSessionHeadedAutosaveInterval, undefined);
						if (args[0] === "session") assert.equal((inspection.details?.data as { piCleanupOwnership: string }).piCleanupOwnership, "wrapper-managed");
						assert.notEqual(inspection.details?.managedSessionRestoreDisabled, true);
						assert.deepEqual((await readInvocationLog(logPath)).map(row => row.args), [["--json", ...prefix, ...args]]);
						assert.deepEqual({ ...(await readInvocationLog(logPath))[0], args: undefined, stdin: undefined }, { ...launch, args: undefined, stdin: undefined, userAgent: null });
						const followup = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", url] });
						assert.equal(followup.isError, false, followup.content[0]?.text);
						assert.equal(followup.details?.sessionName, opened.details?.sessionName);
						assert.deepEqual(followup.details?.compatibilityWorkaround, opened.details?.compatibilityWorkaround);
						assert.equal(followup.details?.managedSessionHeadedAutosaveDisabled, headed ? true : undefined);
						assert.equal(followup.details?.managedSessionHeadedAutosaveInterval, headed ? "0" : undefined);
						assert.equal((await readInvocationLog(logPath)).at(-1)?.autosave, headed ? "0" : null);
					}
					const config = join(root, "caller-config.json");
					await writeFile(config, JSON.stringify({ restore: "caller-config-key", args: "--disable-gpu" }));
					for (const [env, expected] of [
						[{ AGENT_BROWSER_CONFIG: config }, { config, restoreKey: null, autosave: null, userAgent: null, argsEnv: null }],
						[{ AGENT_BROWSER_RESTORE: "caller-key", AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "1700", AGENT_BROWSER_USER_AGENT: "caller-agent", AGENT_BROWSER_ARGS: "--disable-gpu" }, { config: null, restoreKey: "caller-key", autosave: "1700", userAgent: "caller-agent", argsEnv: "--disable-gpu" }],
					] as const) await withPatchedEnv(env, async () => {
						await writeFile(logPath, "");
						const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "read", "public.test"] });
						assert.equal(result.isError, false, result.content[0]?.text);
						assert.notEqual(result.details?.managedSessionRestoreDisabled, true);
						const calls = await readInvocationLog(logPath);
						assert.deepEqual(calls.map(row => row.args), [["--json", ...prefix, "read", "public.test"]]);
						assert.deepEqual({ ...calls[0], args: undefined, stdin: undefined }, { ...launch, ...expected, args: undefined, stdin: undefined });
					});
					const retained = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", url] });
					assert.equal(retained.isError, false, retained.content[0]?.text);
					assert.equal(retained.details?.sessionName, opened.details?.sessionName);
					assert.notEqual(retained.details?.managedSessionRestoreDisabled, true);
					assert.deepEqual(retained.details?.compatibilityWorkaround, opened.details?.compatibilityWorkaround);
				}
			});
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
