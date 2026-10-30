import assert from "node:assert/strict";
import { readNumber, readRecord, readString } from "./helpers/assertions.js";
import childProcess, { execFile, spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { readChildStdoutJsonLine, stopChildProcess } from "./helpers/agent-browser-harness.js";

import {
	acquireManagedSessionPolicyLock,
	getBrowserExecutionLockPath,
	resolveBrowserExecutionIdentity,
} from "../extensions/agent-browser/lib/managed-session-policy-lock.js";
import {
	normalizeProcessStartIdentity,
	processStartIdentitiesMatch,
	readProcessStartIdentity,
} from "../extensions/agent-browser/lib/process-identity.js";

for (const cancel of [false, true]) {
	test(`process identity probes honor ${cancel ? "abort" : "the shared deadline"} while a native helper is stalled`, async (t) => {
		const original = childProcess.execFile;
		let launched = 0;
		let dispatched = 0;
		const probes: ReturnType<typeof execFile>[] = [];
		t.mock.method(
			childProcess,
			"execFile",
			(
				_file: string,
				_args: readonly string[],
				options: Parameters<typeof execFile>[2],
				callback: Parameters<typeof execFile>[3],
			) => {
				launched++;
				// Substitute only the slow helper executable; Node owns real timeout/abort termination.
				const child = original(
					process.execPath,
					["-e", "setTimeout(() => console.log('late identity'), 10000)"],
					options,
					callback,
				);
				child.once("spawn", () => {
					dispatched++;
				});
				probes.push(child);
				return child;
			},
		);
		syncBuiltinESMExports();
		const controller = new AbortController();
		const timer = cancel
			? setTimeout(() => {
					controller.abort();
				}, 50)
			: undefined;
		const started = performance.now();
		try {
			assert.equal(
				await readProcessStartIdentity(process.pid, process.platform, {
					signal: controller.signal,
					deadline: started + (cancel ? 2_000 : 50),
				}),
				undefined,
			);
			assert.equal(launched, 1, "exhausted budget must not launch fallback helpers");
			assert.equal(dispatched, 1, "the deadline must terminate a genuinely spawned native helper");
			assert.ok(
				performance.now() - started < 1_000,
				"coordination must not wait for the helper's ten-second run",
			);
			assert.ok(probes.every((probe) => probe.killed));
		} finally {
			clearTimeout(timer);
			t.mock.restoreAll();
			syncBuiltinESMExports();
			for (const probe of probes) {
				if (probe.exitCode === null) {
					probe.kill("SIGKILL");
				}
			}
		}
	});
}

const systemPs = ["/bin/ps", "/usr/bin/ps"].find(existsSync);
// Explicit modes verify the layout when run in a disposable Linux environment.
const psLocation =
	process.env.PI_AGENT_BROWSER_TEST_PS ?? (systemPs !== undefined ? "system" : "path");

test(
	"real POSIX process identity survives observer timezone and locale changes",
	{ skip: !["darwin", "linux"].includes(process.platform) || psLocation === "missing" },
	async () => {
		const source = `
			import { execFileSync } from "node:child_process";
			import { normalizeProcessStartIdentity, readProcessStartIdentity } from "./extensions/agent-browser/lib/process-identity.ts";
			const environment = JSON.stringify(process.env);
			const pid = Number(process.argv[1]);
			const raw = normalizeProcessStartIdentity(execFileSync(process.argv[2], ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }));
			const identity = await readProcessStartIdentity(pid);
			console.log(JSON.stringify({ raw, identity, pid: process.pid, environmentUnchanged: JSON.stringify(process.env) === environment }));
		`;
		const observe = async (timezone: string, locale: string) => {
			// Node's execFile custom promisify symbol preserves its callback-bearing overload.
			// oxlint-disable-next-line typescript/strict-void-return
			const { stdout } = await promisify(execFile)(
				process.execPath,
				[
					"--import",
					"tsx",
					"--input-type=module",
					"--eval",
					source,
					String(process.pid),
					systemPs ?? "ps",
				],
				{ env: { ...process.env, TZ: timezone, LC_ALL: locale }, timeout: 15_000 },
			);
			return readRecord(JSON.parse(stdout));
		};
		const utc = await observe("UTC0", "C");
		const offset = await observe("UTC-1", "C");
		const localized = await observe("UTC-1", "fr_FR.UTF-8");
		assert.notEqual(utc.raw, offset.raw, "the native control must expose local-time drift");
		if (process.platform === "darwin") {
			// macOS ships this locale; minimal Linux images may only provide the C locale.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.notEqual(offset.raw, localized.raw, "the native control must expose locale drift");
		}
		const identity = readString(utc.identity);
		assert.ok(identity.length > 0);
		assert.deepEqual(
			[offset.identity, localized.identity],
			[identity, identity],
			"the same live foreign process must keep its identity across observers",
		);
		assert.equal(processStartIdentitiesMatch(identity, readString(offset.identity)), true);
		assert.equal(
			processStartIdentitiesMatch(readString(utc.raw), identity),
			undefined,
			"an unqualified persisted local timestamp cannot prove either a match or PID reuse",
		);
		assert.equal(
			processStartIdentitiesMatch(`${identity}-different-generation`, identity),
			false,
			"comparable but different generations must still disagree",
		);
		assert.deepEqual(
			[utc.environmentUnchanged, offset.environmentUnchanged, localized.environmentUnchanged],
			[true, true, true],
		);
		assert.equal(await readProcessStartIdentity(readNumber(offset.pid)), undefined);
	},
);

test(
	`real POSIX ${psLocation} ps preserves process identity and lock integrity`,
	{ skip: !["darwin", "linux"].includes(process.platform) },
	async (t) => {
		assert.ok(["system", "path", "missing"].includes(psLocation));
		assert.equal(
			Boolean(systemPs),
			psLocation === "system",
			"test environment must have the requested real ps layout",
		);
		const originalPath = process.env.PATH;
		if (psLocation !== "path") {
			process.env.PATH = "";
		}
		const sessionName = `piab-ps-${psLocation}-${process.pid}`;
		const namespace = sessionName;
		let lock: Awaited<ReturnType<typeof acquireManagedSessionPolicyLock>>;
		let recovered: typeof lock;
		let foreignOwner: ReturnType<typeof spawn> | undefined;
		try {
			if (psLocation === "missing") {
				// The explicit missing-ps variant must fail closed before returning.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(await readProcessStartIdentity(process.pid), undefined);
				// The same missing-ps variant must also refuse lock acquisition.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(await acquireManagedSessionPolicyLock({ sessionName, namespace }), undefined);
				return;
			}
			// Node's execFile custom promisify symbol preserves its callback-bearing overload.
			// oxlint-disable-next-line typescript/strict-void-return
			const { stdout } = await promisify(execFile)(
				systemPs ?? "ps",
				["-p", String(process.pid), "-o", "lstart="],
				{ env: { ...process.env, TZ: "UTC0", LC_ALL: "C" } },
			);
			const nativeStart = normalizeProcessStartIdentity(stdout);
			assert.ok(nativeStart !== undefined && nativeStart !== "");
			const expected = `posix-ps-utc-v1:${nativeStart}`;
			const identity = await readProcessStartIdentity(process.pid);
			lock = await acquireManagedSessionPolicyLock({ sessionName, namespace });
			assert.deepEqual(
				{ identity, lockAcquired: Boolean(lock) },
				{ identity: expected, lockAcquired: true },
			);
			assert.equal(await readProcessStartIdentity(0), undefined);
			assert.equal(
				await acquireManagedSessionPolicyLock({ sessionName, namespace, timeoutMs: 25 }),
				undefined,
				"a live owner must remain exclusive",
			);

			const basePath = getBrowserExecutionLockPath(
				await resolveBrowserExecutionIdentity({
					sessionName,
					namespace,
					ownedManagedSession: true,
				}),
			);
			const claimNames = (await readdir(dirname(basePath))).filter((name) =>
				name.startsWith(`${basename(basePath)}.claim-`),
			);
			assert.equal(claimNames.length, 1);
			const ownerPath = join(dirname(basePath), claimNames[0], "owner.json");
			const owner = readRecord(JSON.parse(await readFile(ownerPath, "utf8")));
			assert.equal(owner.startIdentity, expected);
			foreignOwner = spawn(
				process.execPath,
				["-e", "process.stdin.resume(); console.log(JSON.stringify({ ready: true }));"],
				{ stdio: ["pipe", "pipe", "pipe"] },
			);
			assert.deepEqual(await readChildStdoutJsonLine(foreignOwner), { ready: true });
			const foreignPid = readNumber(foreignOwner.pid);
			const foreignIdentity = await readProcessStartIdentity(foreignPid);
			assert.ok(foreignIdentity !== undefined && foreignIdentity !== "");
			const unqualifiedStart = foreignIdentity.replace(/^posix-ps-utc-v1:/, "");
			const foreignRecord = { ...owner, pid: foreignPid, startIdentity: unqualifiedStart };
			await writeFile(ownerPath, JSON.stringify(foreignRecord));
			const nativeExecFile = childProcess.execFile;
			let successfulForeignProbes = 0;
			t.mock.method(
				childProcess,
				"execFile",
				(
					file: string,
					args: readonly string[],
					options: Parameters<typeof execFile>[2],
					callback: Parameters<typeof execFile>[3],
				) => {
					assert.ok(typeof callback === "function");
					return nativeExecFile(file, args, options, (error, probeStdout, probeStderr) => {
						if (
							args[0] === "-p" &&
							args[1] === String(foreignPid) &&
							error === null &&
							normalizeProcessStartIdentity(probeStdout.toString()) === unqualifiedStart
						) {
							successfulForeignProbes++;
						}
						callback(error, probeStdout, probeStderr);
					});
				},
			);
			syncBuiltinESMExports();
			assert.equal(
				await acquireManagedSessionPolicyLock({ sessionName, namespace }),
				undefined,
				"a still-live unqualified owner must not be evicted during activation",
			);
			assert.ok(
				successfulForeignProbes > 0,
				"the contender must inspect a ready live foreign identity, not merely exhaust its budget",
			);
			assert.deepEqual(readRecord(JSON.parse(await readFile(ownerPath, "utf8"))), foreignRecord);
			const retainedProbes = successfulForeignProbes;
			// A live PID with a different recorded start time represents PID reuse, not a live lock owner.
			await writeFile(
				ownerPath,
				JSON.stringify({
					...foreignRecord,
					startIdentity: `${foreignIdentity}-different-generation`,
				}),
			);
			recovered = await acquireManagedSessionPolicyLock({ sessionName, namespace });
			assert.ok(recovered, "a mismatched start identity must not strand the lock");
			assert.ok(
				successfulForeignProbes > retainedProbes,
				"the same native identity provider must permit proven-mismatch recovery",
			);
			assert.equal(existsSync(ownerPath), false);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
			await recovered?.release();
			await lock?.release();
			if (foreignOwner) {
				await stopChildProcess(foreignOwner);
			}
			if (originalPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = originalPath;
			}
		}
	},
);
