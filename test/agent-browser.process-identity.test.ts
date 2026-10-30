import assert from "node:assert/strict";
import { readNumber, readRecord, readString } from "./helpers/assertions.js";
import childProcess, { execFile, spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync } from "node:fs";
import fs, { readFile, readdir, writeFile } from "node:fs/promises";
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

const nativeReadFile = fs.readFile;

for (const cancel of [false, true]) {
	test(`process identity probes honor ${cancel ? "abort" : "the shared deadline"} while a native helper is stalled`, async (t) => {
		if (process.platform === "linux") {
			t.skip("Linux reads procfs directly and launches no native helper.");
			return;
		}
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
		const started = Date.now();
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
				Date.now() - started < 1_000,
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

// Independent proc_pid_stat(5) reading: comm ends at the final ")", and starttime is field 22.
async function readKernelProcessIdentity(pid: number): Promise<string> {
	const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
	const stat = await readFile(`/proc/${String(pid)}/stat`, "latin1");
	const startTicks = stat
		.slice(stat.lastIndexOf(")") + 1)
		.trim()
		.split(" ")[22 - 3];
	assert.match(startTicks, /^[0-9]+$/);
	return `linux-proc-boot-ticks-v1:${bootId}:${startTicks}`;
}

async function readUtcPsStart(pid: number): Promise<string> {
	// Node's execFile custom promisify symbol preserves its callback-bearing overload.
	// oxlint-disable-next-line typescript/strict-void-return
	const { stdout } = await promisify(execFile)(
		systemPs ?? "ps",
		["-p", String(pid), "-o", "lstart="],
		{ env: { ...process.env, TZ: "UTC0", LC_ALL: "C" } },
	);
	const start = normalizeProcessStartIdentity(stdout);
	assert.ok(start !== undefined && start !== "");
	return start;
}

test(
	"real Linux process identity uses the kernel boot ID and start ticks instead of wall-clock ps",
	{ skip: process.platform !== "linux" },
	async () => {
		// A foreign live process whose kernel comm contains the separators that break naive parsing.
		const child = spawn(
			process.execPath,
			[
				"-e",
				'require("node:fs").writeFileSync("/proc/self/comm", "a ) ( b"); console.log("{}"); setInterval(() => undefined, 1_000);',
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		try {
			await readChildStdoutJsonLine(child);
			const pid = readNumber(child.pid);
			const stat = await readFile(`/proc/${String(pid)}/stat`, "latin1");
			const expected = await readKernelProcessIdentity(pid);
			assert.ok(stat.includes(" (a ) ( b) "), "the native comm must contain separators");
			assert.notEqual(
				`:${stat.trim().split(/\s+/)[21]}`,
				expected.slice(expected.lastIndexOf(":")),
				"the native control must defeat whole-line whitespace parsing",
			);
			assert.equal(await readProcessStartIdentity(pid), expected);
			const lstart = await readUtcPsStart(pid);
			assert.deepEqual(
				[
					processStartIdentitiesMatch(`posix-ps-utc-v1:${lstart}`, expected),
					processStartIdentitiesMatch(lstart, expected),
				],
				[undefined, undefined],
				"wall-clock ps identities from earlier releases cannot prove reuse of a live Linux PID",
			);
			await stopChildProcess(child);
			assert.equal(await readProcessStartIdentity(pid), undefined);
		} finally {
			await stopChildProcess(child);
		}
	},
);

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
	{
		// Linux identity reads procfs, so only its ordinary system-ps layout supplies old formats.
		skip:
			!["darwin", "linux"].includes(process.platform) ||
			(process.platform === "linux" && psLocation !== "system"),
	},
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
			const nativeStart = await readUtcPsStart(process.pid);
			const expected =
				process.platform === "linux"
					? await readKernelProcessIdentity(process.pid)
					: `posix-ps-utc-v1:${nativeStart}`;
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
			const foreignStart = await readUtcPsStart(foreignPid);
			assert.equal(
				foreignIdentity,
				process.platform === "linux"
					? await readKernelProcessIdentity(foreignPid)
					: `posix-ps-utc-v1:${foreignStart}`,
			);
			// Every persisted format other than the current one must stay incomparable.
			const earlierFormats =
				process.platform === "linux"
					? [foreignStart, `posix-ps-utc-v1:${foreignStart}`]
					: [foreignStart];
			const nativeExecFile = childProcess.execFile;
			const foreignStat = `/proc/${String(foreignPid)}/stat`;
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
							normalizeProcessStartIdentity(probeStdout.toString()) === foreignStart
						) {
							successfulForeignProbes++;
						}
						callback(error, probeStdout, probeStderr);
					});
				},
			);
			// Linux reads the owner's kernel start ticks directly instead of launching ps.
			t.mock.method(fs, "readFile", async (...args: Readonly<Parameters<typeof fs.readFile>>) => {
				const value = await nativeReadFile(...args);
				if (args[0] === foreignStat && String(value).startsWith(`${String(foreignPid)} (`)) {
					successfulForeignProbes++;
				}
				return value;
			});
			syncBuiltinESMExports();
			const activateAgainst = async (startIdentity: string) => {
				await writeFile(ownerPath, JSON.stringify({ ...owner, pid: foreignPid, startIdentity }));
				const probes = successfulForeignProbes;
				return {
					lock: await acquireManagedSessionPolicyLock({ sessionName, namespace }),
					inspected: successfulForeignProbes > probes,
					recorded: readRecord(JSON.parse(await readFile(ownerPath, "utf8"))),
				};
			};
			const observed = [];
			for (const startIdentity of earlierFormats) {
				// Each format is observed against the same live owner before the next rewrite.
				// oxlint-disable-next-line no-await-in-loop
				observed.push(await activateAgainst(startIdentity));
			}
			assert.deepEqual(
				observed,
				earlierFormats.map((startIdentity) => ({
					lock: undefined,
					inspected: true,
					recorded: { ...owner, pid: foreignPid, startIdentity },
				})),
				"the contender must inspect a still-live owner recorded in an earlier format and keep it",
			);
			const retainedProbes = successfulForeignProbes;
			// A live PID with a different recorded start time represents PID reuse, not a live lock owner.
			await writeFile(
				ownerPath,
				JSON.stringify({
					...owner,
					pid: foreignPid,
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
