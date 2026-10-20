import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createExtensionHarness,
	readInvocationLog,
	TEST_SESSION_ID,
} from "./agent-browser-harness.js";
import {
	readArray,
	readBoolean,
	readFunction,
	readNumber,
	readRecord,
	readString,
} from "./assertions.js";
import { readOptionalFakeElectronLaunchLog } from "./extension-validation-fixtures.js";

test("fixture Pi roots are stable within a worker and distinct across real processes", () => {
	const script = `import { TEST_SESSION_ID } from ${JSON.stringify(new URL("./agent-browser-harness.ts", import.meta.url).href)}; process.stdout.write(TEST_SESSION_ID);`;
	const workerIdentity = () =>
		execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
			encoding: "utf8",
		});
	const first = workerIdentity();
	const second = workerIdentity();
	assert.notEqual(first, second);
	assert.notEqual(first, TEST_SESSION_ID);
	const initial = createExtensionHarness({ cwd: process.cwd(), sessionFile: null });
	const resumed = createExtensionHarness({ cwd: process.cwd(), sessionFile: null });
	assert.equal(initial.ctx.sessionManager.getSessionId(), TEST_SESSION_ID);
	assert.equal(resumed.ctx.sessionManager.getSessionId(), TEST_SESSION_ID);
	const explicit = createExtensionHarness({
		cwd: process.cwd(),
		sessionFile: null,
		sessionId: "intentional-shared-root",
	});
	assert.equal(explicit.ctx.sessionManager.getSessionId(), "intentional-shared-root");
});

await test("fixture readers reject malformed shapes instead of asserting unchecked JSON types", async () => {
	assert.deepEqual(readRecord({ key: 1 }), { key: 1 });
	assert.deepEqual(readArray([1]), [1]);
	assert.equal(readString("fixture"), "fixture");
	assert.equal(readNumber(3), 3);
	assert.equal(readBoolean(false), false);
	assert.equal(readFunction((value: unknown) => value)("fixture"), "fixture");
	assert.throws(() => readRecord(null), assert.AssertionError);
	assert.throws(() => readRecord([]), assert.AssertionError);
	assert.throws(() => readRecord("record"), assert.AssertionError);
	assert.throws(() => readArray({}), assert.AssertionError);
	assert.throws(() => readString(1), assert.AssertionError);
	assert.throws(() => readNumber(Number.NaN), assert.AssertionError);
	assert.throws(() => readBoolean("false"), assert.AssertionError);
	assert.throws(() => readFunction({}), assert.AssertionError);

	const root = await mkdtemp(join(tmpdir(), "piab-fixture-boundary-"));
	try {
		const invocations = join(root, "invocations.jsonl");
		const launches = join(root, "launches.jsonl");
		assert.deepEqual(await readInvocationLog(invocations), []);
		assert.deepEqual(await readOptionalFakeElectronLaunchLog(launches), []);
		const invocation = {
			args: ["get", "url"],
			idleTimeout: null,
			socketDir: "/tmp/fixture",
			confirmActions: "navigate",
			extraReceipt: { generation: 2 },
		};
		const launch = {
			args: ["script.cjs"],
			mode: "normal",
			pid: 123,
			userDataDir: "/tmp/profile",
			extraReceipt: { generation: 2 },
		};
		await writeFile(invocations, `${JSON.stringify(invocation)}\n`);
		await writeFile(launches, `${JSON.stringify(launch)}\n`);
		assert.deepEqual(await readInvocationLog(invocations), [invocation]);
		assert.deepEqual(await readOptionalFakeElectronLaunchLog(launches), [launch]);
		await writeFile(invocations, `${JSON.stringify({ ...invocation, confirmActions: 3 })}\n`);
		await assert.rejects(readInvocationLog(invocations), assert.AssertionError);
		await writeFile(invocations, '{"args":[1]}\n');
		await writeFile(launches, `${JSON.stringify({ ...launch, mode: "unknown" })}\n`);
		await assert.rejects(readInvocationLog(invocations), assert.AssertionError);
		await assert.rejects(readOptionalFakeElectronLaunchLog(launches), assert.AssertionError);
		await writeFile(invocations, "not JSON\n");
		await writeFile(launches, "not JSON\n");
		await assert.rejects(readInvocationLog(invocations), SyntaxError);
		await assert.rejects(readOptionalFakeElectronLaunchLog(launches), SyntaxError);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
