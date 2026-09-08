import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { runAgentBrowserProcess } from "../extensions/agent-browser/lib/process.js";
import { withPatchedEnv, writeFakeAgentBrowserBinary } from "./helpers/agent-browser-harness.js";

// The child must receive the original argv, without shell quoting or flag rewriting.
const cases = [
	{
		args: ["fill", "#field", "", "--timeout", "250"],
	},
	{
		args: ["--json", "--namespace", "", "--session", "default", "session", "info"],
	},
	{
		args: ["--json", "--namespace", "team", "--session", "named", "session", "info"],
	},
	{
		args: ["--args", "", "--namespace", "", "--session", "default", "open", "https://example.invalid/"],
	},
	{
		args: ["open", "https://example.invalid/", "--args", "", "--namespace", "", "--session", "default"],
	},
	{
		args: ["--json", "--session", "default", "fill", "#field", "", "--timeout", "250"],
	},
	{
		args: ["fill", "textarea[data-name='notes']", "Mitch's café 雪 🐎 \\path with spaces\\"],
	},
	{
		args: ["fill", "#field", 'Mitch says "hello world"'],
	},
	{
		args: ["--restore", "login-state", "--headed", "false", "open", "https://example.invalid/"],
	},
	{
		args: ["eval", "--stdin"],
		stdin: "JSON.stringify({ text: 'Mitch’s café', quoted: '\"value\"' })\n",
	},
];

test("shared process preserves empty and quoted operands through the effective PATH shim", async () => {
	const root = await mkdtemp(join(tmpdir(), "argv-"));
	const chosen = join(root, "chosen shim");
	const ambient = join(root, "ambient");
	await mkdir(chosen);
	await mkdir(ambient);
	const script = `const input = require('node:fs').readFileSync(0, 'utf8');
// ASCII output keeps this check focused on argv/stdin, not Windows console encoding.
process.stdout.write(Buffer.from(JSON.stringify({ args: process.argv.slice(2), stdin: input, namespace: process.env.AGENT_BROWSER_NAMESPACE })).toString('base64'));`;
	try {
		await writeFakeAgentBrowserBinary(chosen, script);
		await writeFakeAgentBrowserBinary(ambient, "process.stderr.write('wrong PATH shim'); process.exit(9);");
		await withPatchedEnv({ PATH: `${ambient}${delimiter}${process.env.PATH ?? ""}`, AGENT_BROWSER_NAMESPACE: "ambient" }, async () => {
			const env = {
				PATH: `${chosen}${delimiter}${process.env.PATH ?? ""}`,
				AGENT_BROWSER_NAMESPACE: "child-env",
				PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
				PI_AGENT_BROWSER_TEST_PRESERVE_INTERNAL_LAUNCH_FLAGS: "1",
			};
			for (const item of cases) {
				const result = await runAgentBrowserProcess({ args: item.args, stdin: item.stdin, cwd: root, env });
				assert.equal(result.spawnError, undefined);
				assert.equal(result.exitCode, 0, result.stderr);
				assert.equal(result.agentBrowserStarted, true);
				assert.equal(result.timedOut, false);
				assert.equal(result.aborted, false);
				assert.deepEqual(JSON.parse(Buffer.from(result.stdout.trim(), "base64").toString()), {
					args: item.args,
					stdin: item.stdin ?? "",
					namespace: "child-env",
				});
			}
			for (const exitCode of [1, 7]) {
				await writeFakeAgentBrowserBinary(chosen, `process.stderr.write('CLI failed'); process.exit(${exitCode});`);
				const failed = await runAgentBrowserProcess({ args: ["fill", "#field", ""], cwd: root, env });
				assert.equal(failed.exitCode, exitCode);
				assert.equal(failed.stderr, "CLI failed");
				assert.equal(failed.spawnError, undefined);
				assert.equal(failed.agentBrowserStarted, true);
			}
			const missing = await runAgentBrowserProcess({ args: ["--version"], cwd: root, env: { PATH: join(root, "missing") } });
			assert.equal(missing.exitCode, 127);
			assert.equal((missing.spawnError as NodeJS.ErrnoException)?.code, "ENOENT");
			assert.equal(missing.agentBrowserStarted, false);
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
