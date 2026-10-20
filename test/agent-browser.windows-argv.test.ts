import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { runAgentBrowserProcess } from "../extensions/agent-browser/lib/process.js";
import { withPatchedEnv, writeFakeAgentBrowserBinary } from "./helpers/agent-browser-harness.js";
import { readRecord } from "./helpers/assertions.js";

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
		args: [
			"--args",
			"",
			"--namespace",
			"",
			"--session",
			"default",
			"open",
			"https://example.invalid/",
		],
	},
	{
		args: [
			"open",
			"https://example.invalid/",
			"--args",
			"",
			"--namespace",
			"",
			"--session",
			"default",
		],
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
		await writeFakeAgentBrowserBinary(
			ambient,
			"process.stderr.write('wrong PATH shim'); process.exit(9);",
		);
		await withPatchedEnv(
			{
				PATH: `${ambient}${delimiter}${process.env.PATH ?? ""}`,
				AGENT_BROWSER_NAMESPACE: "ambient",
			},
			async () => {
				const env = {
					PATH: `${chosen}${delimiter}${process.env.PATH ?? ""}`,
					AGENT_BROWSER_NAMESPACE: "child-env",
					PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
					PI_AGENT_BROWSER_TEST_PRESERVE_INTERNAL_LAUNCH_FLAGS: "1",
				};
				for (const item of cases) {
					// Each transport case writes shared fixture evidence; finish it before replacing or reading the launcher fixture.
					// oxlint-disable-next-line no-await-in-loop
					const result = await runAgentBrowserProcess({
						args: item.args,
						stdin: item.stdin,
						cwd: root,
						env,
					});
					// The nonempty item fixture matrix exhaustively verifies each case; any failed assertion fails the test.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(result.spawnError, undefined);
					// The nonempty item fixture matrix exhaustively verifies each case; any failed assertion fails the test.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(result.exitCode, 0, result.stderr);
					// The nonempty item fixture matrix exhaustively verifies each case; any failed assertion fails the test.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(result.agentBrowserStarted, true);
					// The nonempty item fixture matrix exhaustively verifies each case; any failed assertion fails the test.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(result.timedOut, false);
					// The nonempty item fixture matrix exhaustively verifies each case; any failed assertion fails the test.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(result.aborted, false);
					// The nonempty item fixture matrix exhaustively verifies each case; any failed assertion fails the test.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.deepEqual(JSON.parse(Buffer.from(result.stdout.trim(), "base64").toString()), {
						args: item.args,
						stdin: item.stdin ?? "",
						namespace: "child-env",
					});
				}
				for (const exitCode of [1, 7]) {
					// Each transport case writes shared fixture evidence; finish it before replacing or reading the launcher fixture.
					// oxlint-disable-next-line no-await-in-loop
					await writeFakeAgentBrowserBinary(
						chosen,
						`process.stderr.write('CLI failed'); process.exit(${exitCode});`,
					);
					// Each transport case writes shared fixture evidence; finish it before replacing or reading the launcher fixture.
					// oxlint-disable-next-line no-await-in-loop
					const failed = await runAgentBrowserProcess({
						args: ["fill", "#field", ""],
						cwd: root,
						env,
					});
					// The nonempty exitCode fixture matrix exhaustively verifies each case; any failed assertion fails the test.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(failed.exitCode, exitCode);
					// The nonempty exitCode fixture matrix exhaustively verifies each case; any failed assertion fails the test.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(failed.stderr, "CLI failed");
					// The nonempty exitCode fixture matrix exhaustively verifies each case; any failed assertion fails the test.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(failed.spawnError, undefined);
					// The nonempty exitCode fixture matrix exhaustively verifies each case; any failed assertion fails the test.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(failed.agentBrowserStarted, true);
				}
				const controller = new AbortController();
				const missing = await runAgentBrowserProcess({
					args: ["--version"],
					cwd: root,
					env: { PATH: join(root, "missing") },
					signal: controller.signal,
				});
				assert.equal(missing.exitCode, 127);
				assert.equal(readRecord(missing.spawnError).code, "ENOENT");
				assert.equal(missing.agentBrowserStarted, false);
				assert.equal(missing.aborted, false);
				assert.equal(getEventListeners(controller.signal, "abort").length, 0);
			},
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
