import assert from "node:assert/strict";
import childProcess, { spawn, type execFile } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";

import {
	buildProcessStartIdentityCommand,
	normalizeProcessStartIdentity,
	readProcessStartIdentity,
} from "../extensions/agent-browser/lib/process-identity.js";
import { readNumber } from "./helpers/assertions.js";
import { readChildStdoutJsonLine, stopChildProcess } from "./helpers/agent-browser-harness.js";

const nativeExecFile = childProcess.execFile;
const windowsOnly = process.platform === "win32";
const identityPrefix = "win32-powershell-ticks-v1:";

type NativeProbeSample = {
	readonly failed: boolean;
	readonly nonzeroExit: boolean;
	readonly emptyOutput: boolean;
	readonly hasIdentityPrefix: boolean;
	readonly completeIdentityOutput: boolean;
	readonly killed: boolean;
	readonly aborted: boolean;
	readonly timeoutMs: number | null;
};

async function holdForeignProcess(t: TestContext): Promise<{
	readonly pid: number;
	readonly stop: () => Promise<void>;
}> {
	const child = spawn(
		process.execPath,
		["--eval", "process.stdin.resume(); console.log(JSON.stringify({ ready: true }));"],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	const closed = new Promise<void>((resolve) => {
		child.once("close", () => resolve());
	});
	const stop = async (): Promise<void> => {
		await stopChildProcess(child);
		await closed;
		assert.ok(
			child.exitCode !== null || child.signalCode !== null,
			"the owned child must have exited before its close completes",
		);
	};
	t.after(stop);
	assert.deepEqual(await readChildStdoutJsonLine(child), { ready: true });
	const pid = readNumber(child.pid);
	assert.ok(pid !== process.pid && Number.isSafeInteger(pid) && pid > 0);
	return { pid, stop };
}

// Observe only real foreign-provider dispatches. Never retain scripts, identities or stderr.
function observeForeignProvider(
	t: TestContext,
	pid: number,
	rewrite: (script: string) => string = (script) => script,
	onStarted?: (child: ReturnType<typeof execFile>) => void,
): {
	readonly samples: () => readonly NativeProbeSample[];
	readonly restore: () => void;
} {
	assert.equal(childProcess.execFile, nativeExecFile);
	const command = buildProcessStartIdentityCommand(pid, "win32");
	assert.ok(command);
	const samples: NativeProbeSample[] = [];
	const closes: Promise<void>[] = [];
	const mocked = t.mock.method(
		childProcess,
		"execFile",
		(
			file: string,
			args: readonly string[],
			options: Parameters<typeof execFile>[2],
			callback: Parameters<typeof execFile>[3],
		) => {
			if (file !== command.file || args.at(-1) !== command.args.at(-1)) {
				return nativeExecFile(file, args, options, callback);
			}
			const script = args.at(-1);
			assert.ok(script !== undefined);
			assert.ok(typeof callback === "function");
			const rewritten = rewrite(script);
			const forwardedArgs = rewritten === script ? args : [...args.slice(0, -1), rewritten];
			const child = nativeExecFile(
				file,
				forwardedArgs,
				options,
				function (this: unknown, error, stdout, stderr) {
					const output = typeof stdout === "string" ? stdout : stdout.toString("utf8");
					samples.push({
						failed: error !== null,
						nonzeroExit: typeof error?.code === "number" && error.code !== 0,
						emptyOutput: output.length === 0,
						hasIdentityPrefix: output.includes(identityPrefix),
						completeIdentityOutput: fullTicksIdentity(normalizeProcessStartIdentity(output)),
						killed: error?.killed === true,
						aborted: error?.code === "ABORT_ERR",
						timeoutMs: options?.timeout ?? null,
					});
					Reflect.apply(callback, this, [error, stdout, stderr]);
				},
			);
			closes.push(
				new Promise<void>((resolve) => {
					child.once("close", () => resolve());
				}),
			);
			onStarted?.(child);
			return child;
		},
	);
	syncBuiltinESMExports();
	const restore = (): void => {
		mocked.mock.restore();
		syncBuiltinESMExports();
	};
	t.after(async () => {
		restore();
		await Promise.all(closes);
	});
	return { samples: () => [...samples], restore };
}

async function readLegacyIdentity(pid: number): Promise<{
	readonly identity: string | undefined;
	readonly elapsedMs: number;
}> {
	const command = buildProcessStartIdentityCommand(pid, "win32");
	assert.ok(command);
	const script = `$p = Get-Process -Id ${pid} -ErrorAction Stop; Write-Output ("${identityPrefix}" + $p.StartTime.ToUniversalTime().Ticks)`;
	const started = performance.now();
	return await new Promise((resolve) => {
		// Same executable and flags, and the existing native Windows default probe timeout.
		nativeExecFile(
			command.file,
			[...command.args.slice(0, -1), script],
			{ timeout: 10_000 },
			(error, stdout) => {
				resolve({
					identity: error ? undefined : normalizeProcessStartIdentity(stdout),
					elapsedMs: Math.round(performance.now() - started),
				});
			},
		);
	});
}

function fullTicksIdentity(identity: string | undefined): boolean {
	return typeof identity === "string" && /^win32-powershell-ticks-v1:[1-9]\d*$/.test(identity);
}

test(
	"physical Windows process-start providers preserve identical fresh ticks for one held foreign child",
	{ skip: !windowsOnly },
	async (t) => {
		const foreign = await holdForeignProcess(t);
		const observed = observeForeignProvider(t, foreign.pid);
		try {
			const pair = async (): Promise<string | undefined> => {
				const legacy = await readLegacyIdentity(foreign.pid);
				const started = performance.now();
				const current = await readProcessStartIdentity(foreign.pid);
				const elapsedMs = Math.round(performance.now() - started);
				// Observed pairs only, not a latency threshold or claim of an improvement.
				t.diagnostic(JSON.stringify({ oldElapsedMs: legacy.elapsedMs, newElapsedMs: elapsedMs }));
				assert.ok(
					fullTicksIdentity(legacy.identity),
					"legacy provider must return full versioned decimal ticks",
				);
				assert.ok(
					fullTicksIdentity(current),
					"current provider must return full versioned decimal ticks",
				);
				assert.ok(
					legacy.identity === current,
					"both real providers must identify the same held process",
				);
				assert.doesNotThrow(() => process.kill(foreign.pid, 0));
				return current;
			};
			const first = await pair();
			const second = await pair();
			const third = await pair();
			assert.ok(
				first === second && second === third,
				"fresh repeated queries must preserve the held generation",
			);
			assert.equal(
				observed.samples().length,
				3,
				"every foreign query must actually dispatch, not use the self cache",
			);
			assert.ok(
				observed.samples().every((sample) => !sample.failed && sample.timeoutMs === 10_000),
			);

			const aborted = new AbortController();
			aborted.abort();
			assert.ok(
				(await readProcessStartIdentity(foreign.pid, "win32", { signal: aborted.signal })) ===
					undefined,
			);
			assert.ok(
				(await readProcessStartIdentity(foreign.pid, "win32", { deadline: Date.now() - 1 })) ===
					undefined,
			);
			assert.equal(observed.samples().length, 3, "expired or cancelled budgets must not dispatch");
		} finally {
			observed.restore();
		}
	},
);

test(
	"physical Windows process-start provider does not retain a dead foreign generation",
	{ skip: !windowsOnly },
	async (t) => {
		const foreign = await holdForeignProcess(t);
		const observed = observeForeignProvider(t, foreign.pid);
		try {
			const held = await readProcessStartIdentity(foreign.pid);
			assert.ok(fullTicksIdentity(held));
			await foreign.stop();
			const current = await readProcessStartIdentity(foreign.pid);
			assert.equal(observed.samples().length, 2);
			const sample = observed.samples().at(-1);
			assert.ok(sample);
			// The OS may reuse this PID (even for the probe). A freshly observed different
			// generation is correct; reusing the former held identity is never correct.
			assert.ok(current === undefined || (fullTicksIdentity(current) && current !== held));
			assert.ok(
				current !== undefined || (sample.failed && sample.nonzeroExit && sample.emptyOutput),
			);
			assert.ok(current === undefined || (!sample.failed && sample.hasIdentityPrefix));
		} finally {
			observed.restore();
		}
	},
);

test(
	"physical Windows process-start provider leaves a confirmed missing PID unknown without partial output",
	{ skip: !windowsOnly },
	async (t) => {
		const missingPid = 2_147_483_647;
		assert.throws(() => process.kill(missingPid, 0), { code: "ESRCH" });
		const observed = observeForeignProvider(t, missingPid);
		const identity = await readProcessStartIdentity(missingPid).finally(observed.restore);
		assert.ok(identity === undefined, "a missing PID must be unknown, not an incomplete prefix");
		assert.equal(observed.samples().length, 1);
		assert.ok(
			observed
				.samples()
				.every((sample) => sample.failed && sample.nonzeroExit && sample.emptyOutput),
		);
	},
);

for (const failure of ["lookup", "property"] as const) {
	test(
		`physical Windows process-start provider fails closed on an injected ${failure} exception`,
		{ skip: !windowsOnly },
		async (t) => {
			const foreign = await holdForeignProcess(t);
			const observed = observeForeignProvider(t, foreign.pid, (script) => {
				const target =
					failure === "lookup"
						? `[System.Diagnostics.Process]::GetProcessById(${foreign.pid})`
						: "$p.StartTime.ToUniversalTime().Ticks";
				assert.ok(script.includes(target));
				const replacement =
					failure === "lookup"
						? "& { throw [System.UnauthorizedAccessException]::new('injected lookup failure') }"
						: "([System.Diagnostics.Process]::new()).StartTime.ToUniversalTime().Ticks";
				return script.replace(target, replacement);
			});
			const identity = await readProcessStartIdentity(foreign.pid).finally(observed.restore);
			assert.ok(identity === undefined, "access/property exceptions must resolve unknown");
			assert.equal(observed.samples().length, 1);
			assert.ok(
				observed
					.samples()
					.every((sample) => sample.failed && sample.nonzeroExit && sample.emptyOutput),
			);
			assert.doesNotThrow(() => process.kill(foreign.pid, 0));
		},
	);
}

test(
	"physical Windows process-start provider ignores complete output when disposal fails",
	{ skip: !windowsOnly },
	async (t) => {
		const foreign = await holdForeignProcess(t);
		const observed = observeForeignProvider(t, foreign.pid, (script) => {
			assert.ok(script.includes("$p.Dispose()"));
			return script.replace(
				"$p.Dispose()",
				"$p.Dispose(); throw [System.InvalidOperationException]::new('injected dispose failure')",
			);
		});
		const identity = await readProcessStartIdentity(foreign.pid).finally(observed.restore);
		assert.ok(identity === undefined, "a native error must override even a complete identity line");
		assert.equal(observed.samples().length, 1);
		assert.ok(
			observed
				.samples()
				.every((sample) => sample.failed && sample.nonzeroExit && sample.completeIdentityOutput),
		);
		assert.doesNotThrow(() => process.kill(foreign.pid, 0));
	},
);

test(
	"physical Windows process-start provider retains the native default timeout for a blocked lookup",
	{ skip: !windowsOnly },
	async (t) => {
		const foreign = await holdForeignProcess(t);
		const observed = observeForeignProvider(t, foreign.pid, (script) => {
			const target = `[System.Diagnostics.Process]::GetProcessById(${foreign.pid})`;
			assert.ok(script.includes(target));
			return script.replace(target, `& { [System.Threading.Thread]::Sleep(30000); ${target} }`);
		});
		const identity = await readProcessStartIdentity(foreign.pid).finally(observed.restore);
		assert.ok(identity === undefined, "a timed-out native lookup must remain unknown");
		assert.equal(observed.samples().length, 1);
		assert.ok(
			observed
				.samples()
				.every(
					(sample) =>
						sample.failed && sample.killed && sample.emptyOutput && sample.timeoutMs === 10_000,
				),
		);
		assert.doesNotThrow(() => process.kill(foreign.pid, 0));
	},
);

test(
	"physical Windows process-start provider cancels a dispatched native lookup without killing its foreign target",
	{ skip: !windowsOnly },
	async (t) => {
		const foreign = await holdForeignProcess(t);
		const controller = new AbortController();
		const readiness = { seen: false };
		const observed = observeForeignProvider(
			t,
			foreign.pid,
			(script) => {
				const target = `[System.Diagnostics.Process]::GetProcessById(${foreign.pid})`;
				assert.ok(script.includes(target));
				return script.replace(
					target,
					`& { [Console]::Out.WriteLine(1); [System.Threading.Thread]::Sleep(30000); ${target} }`,
				);
			},
			(child) => {
				assert.ok(child.stdout);
				child.stdout.once("data", () => {
					readiness.seen = true;
					controller.abort();
				});
			},
		);
		const identity = await readProcessStartIdentity(foreign.pid, "win32", {
			signal: controller.signal,
		}).finally(observed.restore);
		assert.ok(identity === undefined, "a cancelled native lookup must remain unknown");
		assert.equal(
			readiness.seen,
			true,
			"abort only after the actual PowerShell command reaches the injected block",
		);
		assert.equal(observed.samples().length, 1);
		assert.ok(
			observed
				.samples()
				.every(
					(sample) =>
						sample.failed &&
						sample.aborted &&
						!sample.hasIdentityPrefix &&
						sample.timeoutMs === 10_000,
				),
		);
		assert.doesNotThrow(() => process.kill(foreign.pid, 0));
	},
);
