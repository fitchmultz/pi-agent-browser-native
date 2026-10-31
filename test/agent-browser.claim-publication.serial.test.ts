import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { acquireExecutionClaim } from "../extensions/agent-browser/lib/browser-execution-claims.js";
import { getBrowserExecutionLockPath } from "../extensions/agent-browser/lib/browser-execution-identity.js";
import {
	buildProcessStartIdentityCommand,
	readProcessStartIdentity,
} from "../extensions/agent-browser/lib/process-identity.js";
import { readArray, readRecord, readString, hasErrorCode } from "./helpers/assertions.js";
import { readChildStdoutJsonLine, stopChildProcess } from "./helpers/agent-browser-harness.js";
import { mockMonotonicClock } from "./helpers/monotonic-clock.js";

type MkdirArguments = readonly [
	path: Parameters<typeof fs.mkdir>[0],
	options?: Readonly<Parameters<typeof fs.mkdir>[1]>,
];
// These claim fixtures and the production publisher write JSON strings, not mutable streams.
type ClaimWriteArguments = readonly [
	file: Parameters<typeof fs.writeFile>[0],
	content: string,
	options?: Readonly<Parameters<typeof fs.writeFile>[2]>,
];

const hostPlatform = process.platform;
const nativeFs = {
	readFile: fs.readFile,
	rename: fs.rename,
	mkdir: fs.mkdir,
	writeFile: fs.writeFile,
	lstat: fs.lstat,
};

async function fixture(
	t: TestContext,
	windowsPolicy = true,
	sessionNames: readonly string[] | null = ["one", "two"],
) {
	assert.deepEqual(
		{
			readFile: fs.readFile,
			rename: fs.rename,
			mkdir: fs.mkdir,
			writeFile: fs.writeFile,
			lstat: fs.lstat,
		},
		nativeFs,
		"each control must start with restored native filesystem methods",
	);
	// Populate the real host identity before a Linux fault-injection control selects the Windows
	// policy branch. This override tests policy only; it does not simulate Windows filesystem behavior.
	const startIdentity = await readProcessStartIdentity(process.pid);
	assert.ok(startIdentity !== undefined && startIdentity.length > 0);
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	assert.ok(platform);
	if (windowsPolicy) {
		Object.defineProperty(process, "platform", { ...platform, value: "win32" });
	}
	const identity = {
		socketContext: `publication-regression-${randomUUID()}`,
		sessionNames,
	};
	const base = getBrowserExecutionLockPath(identity);
	const publications: Array<{ source: string; destination: string }> = [];
	let ownerReads = 0;
	let afterOwnerRead: (() => void) | undefined;
	const nativeRename = fs.rename;
	const nativeReadFile = fs.readFile;
	t.mock.method(fs, "readFile", (...args: Readonly<Parameters<typeof fs.readFile>>) => {
		if (
			pathText(args[0]).startsWith(`${base}.candidate-`) &&
			basename(pathText(args[0])) === "owner.json"
		) {
			ownerReads++;
			if (afterOwnerRead) {
				return nativeReadFile(...args).then((value) => {
					afterOwnerRead?.();
					return value;
				});
			}
		}
		return nativeReadFile(...args);
	});
	syncBuiltinESMExports();
	t.after(async () => {
		t.mock.reset();
		Object.assign(fs, nativeFs);
		syncBuiltinESMExports();
		Object.defineProperty(process, "platform", platform);
		const names = await fs.readdir(dirname(base)).catch(() => []);
		await Promise.all(
			names
				.filter((name) => name.startsWith(`${basename(base)}.`))
				.map((name) => fs.rm(join(dirname(base), name), { recursive: true, force: true })),
		);
	});
	return {
		identity,
		base,
		startIdentity,
		nativeReadFile,
		publications,
		ownerReads: () => ownerReads,
		afterOwnerRead(run: () => void) {
			afterOwnerRead = run;
		},
		intercept(run: (source: string, attempt: number) => Promise<void> | void) {
			t.mock.method(fs, "rename", async (...args: Readonly<Parameters<typeof fs.rename>>) => {
				const source = pathText(args[0]);
				if (source.startsWith(`${base}.candidate-`)) {
					publications.push({ source, destination: pathText(args[1]) });
					await run(source, publications.length);
				}
				return nativeRename(...args);
			});
			syncBuiltinESMExports();
		},
	};
}

function pathText(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function injectedFailure(code = "EPERM"): Error {
	return Object.assign(new Error(`Fault-injection control: ${code}`), { code, syscall: "rename" });
}

test("fault-injection control: Windows publication retries only its same owned candidate", async (t) => {
	const f = await fixture(t);
	f.intercept((_source, attempt) => {
		if (attempt <= 2) {
			throw injectedFailure();
		}
	});
	const lock = await acquireExecutionClaim({ identity: f.identity });
	assert.ok(lock);
	assert.equal(f.publications.length, 3);
	assert.deepEqual(
		f.publications,
		Array.from({ length: 3 }, () => f.publications[0]),
	);
	assert.equal(f.ownerReads(), 2, "each retry must re-read the candidate owner");
	const owner = readRecord(
		JSON.parse(await fs.readFile(join(f.publications[2].destination, "owner.json"), "utf8")),
	);
	assert.equal(
		f.publications[0].source,
		f.publications[0].destination.replace(".claim-", ".candidate-"),
	);
	assert.deepEqual(owner.sessionNames, f.identity.sessionNames);
	assert.equal(owner.pid, process.pid);
	await lock.release();
});

test("fault-injection control: namespace-wide null scope survives a verified retry", async (t) => {
	const f = await fixture(t, true, null);
	f.intercept((_source, attempt) => {
		if (attempt === 1) {
			throw injectedFailure();
		}
	});
	const lock = await acquireExecutionClaim({ identity: f.identity });
	assert.ok(lock);
	assert.equal(f.publications.length, 2);
	assert.equal(
		readRecord(
			JSON.parse(await f.nativeReadFile(join(f.publications[1].destination, "owner.json"), "utf8")),
		).sessionNames,
		null,
	);
	await lock.release();
});

test("fault-injection control: unreadable candidate ownership is retained and never retried", async (t) => {
	const f = await fixture(t);
	f.afterOwnerRead(() => {
		throw injectedFailure("EACCES");
	});
	f.intercept(() => {
		throw injectedFailure();
	});
	assert.equal(await acquireExecutionClaim({ identity: f.identity }), undefined);
	assert.equal(f.publications.length, 1);
	assert.equal(f.ownerReads(), 1);
	const owner = readRecord(
		JSON.parse(await f.nativeReadFile(join(f.publications[0].source, "owner.json"), "utf8")),
	);
	assert.equal(owner.pid, process.pid);
	assert.equal(owner.startIdentity, f.startIdentity);
	assert.deepEqual(owner.sessionNames, f.identity.sessionNames);
});

test("fault-injection control: host platform gates EPERM publication retry", async (t) => {
	const f = await fixture(t, false);
	f.intercept((_source, attempt) => {
		if (attempt === 1) {
			throw injectedFailure();
		}
	});
	const lock = await acquireExecutionClaim({ identity: f.identity });
	assert.equal(Boolean(lock), hostPlatform === "win32");
	assert.equal(f.publications.length, hostPlatform === "win32" ? 2 : 1);
	await lock?.release();
});

for (const code of ["ENOENT", "EACCES", "EEXIST", "UNKNOWN"]) {
	test(`fault-injection control: publication does not retry ${code}`, async (t) => {
		const f = await fixture(t);
		f.intercept(() => {
			throw injectedFailure(code);
		});
		assert.equal(await acquireExecutionClaim({ identity: f.identity }), undefined);
		assert.equal(f.publications.length, 1);
		assert.equal(f.ownerReads(), 0);
	});
}

for (const stage of ["mkdir", "owner-write", "ticket-write", "ticket-rename"]) {
	test(`fault-injection control: ${stage} EPERM is never retried`, async (t) => {
		const f = await fixture(t);
		let stageAttempts = 0;
		let candidatePath: string | undefined;
		if (stage === "mkdir") {
			t.mock.method(fs, "mkdir", (...args: MkdirArguments) => {
				if (pathText(args[0]).startsWith(`${f.base}.candidate-`)) {
					candidatePath = pathText(args[0]);
					stageAttempts++;
					throw injectedFailure();
				}
				return nativeFs.mkdir(...args);
			});
		} else if (stage === "owner-write" || stage === "ticket-write") {
			t.mock.method(fs, "writeFile", (...args: ClaimWriteArguments) => {
				const path = pathText(args[0]);
				if (
					(stage === "owner-write" && path.startsWith(`${f.base}.candidate-`)) ||
					(stage === "ticket-write" &&
						dirname(path).startsWith(`${f.base}.claim-`) &&
						basename(path).startsWith(".ticket-"))
				) {
					candidatePath =
						stage === "owner-write"
							? dirname(path)
							: dirname(path).replace(".claim-", ".candidate-");
					stageAttempts++;
					throw injectedFailure();
				}
				return nativeFs.writeFile(...args);
			});
		}
		if (stage === "ticket-rename") {
			t.mock.method(fs, "rename", async (...args: Readonly<Parameters<typeof fs.rename>>) => {
				const source = pathText(args[0]);
				if (source.startsWith(`${f.base}.candidate-`)) {
					candidatePath = source;
					f.publications.push({ source, destination: pathText(args[1]) });
				}
				if (
					dirname(source).startsWith(`${f.base}.claim-`) &&
					basename(source).startsWith(".ticket-")
				) {
					stageAttempts++;
					throw injectedFailure();
				}
				return nativeFs.rename(...args);
			});
		} else {
			f.intercept(() => {
				/* Observe the initial native publication without injecting a fault. */
			});
		}
		syncBuiltinESMExports();
		assert.equal(await acquireExecutionClaim({ identity: f.identity }), undefined);
		assert.equal(stageAttempts, 1);
		assert.equal(f.publications.length, stage.startsWith("ticket-") ? 1 : 0);
		assert.equal(f.ownerReads(), 0);
		assert.ok(candidatePath !== undefined);
		await assert.rejects(
			fs.stat(candidatePath),
			{ code: "ENOENT" },
			"known-own partial candidates retain their existing cleanup",
		);
	});
}

for (const field of [
	"token",
	"pid",
	"startIdentity",
	"version",
	"sessionNames",
	"null-scope",
	"ticket",
	"missing-owner",
]) {
	test(`fault-injection control: publication refuses a changed ${field} before retry`, async (t) => {
		const f = await fixture(t);
		let retainedCandidate: string | undefined;
		let retainedOwner: string | undefined;
		let retainedTicket: string | undefined;
		f.intercept(async (source) => {
			retainedCandidate = source;
			const ownerPath = join(source, "owner.json");
			const owner = readRecord(JSON.parse(await fs.readFile(ownerPath, "utf8")));
			if (field === "missing-owner") {
				await fs.rm(ownerPath);
			} else if (field === "null-scope") {
				await fs.writeFile(ownerPath, JSON.stringify({ ...owner, sessionNames: null }));
			} else if (field === "ticket") {
				await fs.writeFile(
					join(source, "ticket.json"),
					JSON.stringify({ version: 4, token: owner.token, ticket: 1 }),
					{ mode: 0o600 },
				);
			} else {
				const replacements: Readonly<Record<string, unknown>> = {
					token: "different-token",
					pid: process.pid + 1,
					startIdentity: "different-generation",
					version: 5,
					sessionNames: ["other-domain", "two"],
				};
				await fs.writeFile(ownerPath, JSON.stringify({ ...owner, [field]: replacements[field] }));
			}
			retainedOwner = await f
				.nativeReadFile(ownerPath, "utf8")
				.catch((error: unknown): undefined => {
					if (hasErrorCode(error, "ENOENT")) {
						return;
					}
					throw error;
				});
			retainedTicket = await f
				.nativeReadFile(join(source, "ticket.json"), "utf8")
				.catch((error: unknown): undefined => {
					if (hasErrorCode(error, "ENOENT")) {
						return;
					}
					throw error;
				});
			throw injectedFailure();
		});
		assert.equal(await acquireExecutionClaim({ identity: f.identity }), undefined);
		assert.equal(
			f.publications.length,
			1,
			"an unknown/replaced candidate must never be renamed again",
		);
		assert.ok(retainedCandidate !== undefined);
		assert.equal(
			(await fs.stat(retainedCandidate)).isDirectory(),
			true,
			"unknown ownership withdraws candidate cleanup authority",
		);
		const actualOwner = await f
			.nativeReadFile(join(retainedCandidate, "owner.json"), "utf8")
			.catch((error: unknown): undefined => {
				if (hasErrorCode(error, "ENOENT")) {
					return;
				}
				throw error;
			});
		const actualTicket = await f
			.nativeReadFile(join(retainedCandidate, "ticket.json"), "utf8")
			.catch((error: unknown): undefined => {
				if (hasErrorCode(error, "ENOENT")) {
					return;
				}
				throw error;
			});
		assert.equal(actualOwner, retainedOwner);
		assert.equal(actualTicket, retainedTicket);
	});
}

test("fault-injection control: ownership is revalidated again after a second EPERM", async (t) => {
	const f = await fixture(t);
	f.intercept(async (source, attempt) => {
		if (attempt === 2) {
			const path = join(source, "owner.json");
			const owner = readRecord(JSON.parse(await fs.readFile(path, "utf8")));
			await fs.writeFile(path, JSON.stringify({ ...owner, startIdentity: "replaced-generation" }));
		}
		throw injectedFailure();
	});
	assert.equal(await acquireExecutionClaim({ identity: f.identity }), undefined);
	assert.equal(f.publications.length, 2);
	assert.equal(
		f.ownerReads(),
		3,
		"two retry validations plus the fixture's second-attempt mutation read",
	);
	assert.equal((await fs.stat(f.publications[1].source)).isDirectory(), true);
	assert.equal(
		readRecord(
			JSON.parse(await f.nativeReadFile(join(f.publications[1].source, "owner.json"), "utf8")),
		).startIdentity,
		"replaced-generation",
	);
});

test("fault-injection control: timeoutMs zero is an initial publication attempt only", async (t) => {
	const f = await fixture(t);
	f.intercept(() => {
		throw injectedFailure();
	});
	assert.equal(
		await acquireExecutionClaim({
			identity: f.identity,
			timeoutMs: 0,
			deadline: performance.now() + 10_000,
		}),
		undefined,
	);
	assert.equal(f.publications.length, 1);
	assert.equal(f.ownerReads(), 0);
});

for (const boundary of ["first-failure", "wait", "validation"] as const) {
	test(`fault-injection control: cancellation at ${boundary} prevents publication retry`, async (t) => {
		const f = await fixture(t);
		const controller = new AbortController();
		if (boundary === "validation") {
			f.afterOwnerRead(() => controller.abort());
		}
		f.intercept(() => {
			if (boundary === "first-failure") {
				controller.abort();
			} else if (boundary === "wait") {
				setTimeout(() => controller.abort(), 0);
			}
			throw injectedFailure();
		});
		assert.equal(
			await acquireExecutionClaim({ identity: f.identity, signal: controller.signal }),
			undefined,
		);
		assert.equal(f.publications.length, 1);
		assert.equal(f.ownerReads(), boundary === "validation" ? 1 : 0);
	});
}

for (const boundary of ["first-failure", "wait", "validation"] as const) {
	test(`fault-injection control: original deadline at ${boundary} prevents publication retry`, async (t) => {
		const f = await fixture(t);
		const clock = mockMonotonicClock(t);
		if (boundary === "validation") {
			f.afterOwnerRead(() => clock.tick(1_000));
		}
		f.intercept(() => {
			if (boundary === "first-failure") {
				clock.tick(1_000);
			} else if (boundary === "wait") {
				setTimeout(() => clock.tick(1_000), 0);
			}
			throw injectedFailure();
		});
		assert.equal(
			await acquireExecutionClaim({ identity: f.identity, deadline: clock.now() + 100 }),
			undefined,
		);
		assert.equal(f.publications.length, 1);
		assert.equal(f.ownerReads(), boundary === "validation" ? 1 : 0);
	});
}

for (const result of ["success", "EPERM"]) {
	test(`publication keeps only its initial attempt after preparation spends the budget (${result})`, async (t) => {
		const f = await fixture(t);
		const clock = mockMonotonicClock(t);
		const nativeWriteFile = fs.writeFile;
		t.mock.method(fs, "writeFile", async (...args: ClaimWriteArguments) => {
			await nativeWriteFile(...args);
			if (
				pathText(args[0]).includes(".candidate-") &&
				basename(pathText(args[0])) === "owner.json"
			) {
				clock.tick(1_000);
			}
		});
		syncBuiltinESMExports();
		f.intercept(() => {
			if (result === "EPERM") {
				throw injectedFailure();
			}
		});
		const lock = await acquireExecutionClaim({ identity: f.identity, deadline: clock.now() + 100 });
		assert.equal(Boolean(lock), result === "success");
		assert.equal(f.publications.length, 1);
		assert.equal(f.ownerReads(), 0);
		await lock?.release();
	});
}

test("fault-injection control: default deadline includes coordination preparation time", async (t) => {
	const f = await fixture(t);
	const clock = mockMonotonicClock(t);
	const nativeLstat = fs.lstat;
	let prepared = false;
	t.mock.method(fs, "lstat", async (...args: Readonly<Parameters<typeof fs.lstat>>) => {
		const value = await nativeLstat(...args);
		if (pathText(args[0]) === dirname(f.base)) {
			prepared = true;
			clock.tick(900);
		}
		return value;
	});
	syncBuiltinESMExports();
	f.intercept(() => {
		clock.tick(100);
		throw injectedFailure();
	});
	assert.equal(await acquireExecutionClaim({ identity: f.identity }), undefined);
	assert.equal(prepared, true);
	assert.equal(
		f.publications.length,
		1,
		"preparation must not reset the original implicit deadline",
	);
	assert.equal(f.ownerReads(), 0);
});

test(
	"native Windows publication recovers after a real no-delete-sharing owner handle closes",
	{ skip: hostPlatform !== "win32" },
	async (t) => {
		const f = await fixture(t, false);
		const command = buildProcessStartIdentityCommand(process.pid, "win32");
		assert.ok(command);
		const script = `
$ErrorActionPreference = 'Stop'
[Console]::WriteLine('{"ready":true}')
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()))
$handle = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
  [Console]::WriteLine('{"locked":true}')
  $null = [Console]::ReadLine()
} finally { $handle.Dispose() }
[Console]::WriteLine('{"released":true}')
$null = [Console]::ReadLine()
`;
		const holder = spawn(command.file, ["-NoProfile", "-NonInteractive", "-Command", script], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		const exited = once(holder, "exit");
		t.after(async () => stopChildProcess(holder));
		assert.deepEqual(await readChildStdoutJsonLine(holder), { ready: true });
		const nativeRename = fs.rename;
		let nativeConflicts = 0;
		let preparedOwner: Record<string, unknown> | undefined;
		t.mock.method(fs, "rename", async (...args: Readonly<Parameters<typeof fs.rename>>) => {
			const source = pathText(args[0]);
			if (!source.includes(".candidate-")) {
				return nativeRename(...args);
			}
			f.publications.push({ source, destination: pathText(args[1]) });
			if (f.publications.length !== 1) {
				return nativeRename(...args);
			}
			preparedOwner = readRecord(
				JSON.parse(await f.nativeReadFile(join(source, "owner.json"), "utf8")),
			);
			const locked = readChildStdoutJsonLine(holder);
			holder.stdin.write(`${Buffer.from(join(source, "owner.json"), "utf8").toString("base64")}\n`);
			assert.deepEqual(await locked, { locked: true });
			try {
				await nativeRename(...args);
			} catch (error) {
				if (hasErrorCode(error, "EPERM")) {
					nativeConflicts++;
				}
				throw error; // Preserve the real NTFS result, never fabricate a sharing failure.
			} finally {
				const released = readChildStdoutJsonLine(holder);
				holder.stdin.write("release\n");
				assert.deepEqual(await released, { released: true });
				holder.stdin.end();
				const [exitCode] = readArray(await exited);
				assert.equal(
					exitCode,
					0,
					"the real helper must close before the same rename error is rethrown",
				);
			}
		});
		syncBuiltinESMExports();
		const lock = await acquireExecutionClaim({ identity: f.identity });
		assert.equal(nativeConflicts, 1, "the first native publication must actually encounter EPERM");
		assert.ok(lock, "publication must recover within its original acquisition budget");
		assert.equal(f.publications.length, 2);
		assert.equal(f.ownerReads(), 1);
		assert.deepEqual(f.publications[1], f.publications[0]);
		assert.ok(preparedOwner);
		const publishedPath = f.publications[0].destination;
		const ownerPath = join(publishedPath, "owner.json");
		assert.deepEqual(
			readRecord(JSON.parse(await f.nativeReadFile(ownerPath, "utf8"))),
			preparedOwner,
		);
		assert.equal(preparedOwner.pid, process.pid);
		assert.equal(preparedOwner.startIdentity, f.startIdentity);
		assert.deepEqual(preparedOwner.sessionNames, f.identity.sessionNames);
		assert.equal(publishedPath, `${f.base}.claim-${readString(preparedOwner.token)}`);
		assert.equal(
			f.publications[0].source,
			`${f.base}.candidate-${readString(preparedOwner.token)}`,
		);
		assert.equal(
			await acquireExecutionClaim({ identity: f.identity, timeoutMs: 0 }),
			undefined,
			"the recovered lease must exclude another real contender",
		);
		assert.deepEqual(
			readRecord(JSON.parse(await f.nativeReadFile(ownerPath, "utf8"))),
			preparedOwner,
		);
		await lock.release();
		await assert.rejects(fs.stat(publishedPath), { code: "ENOENT" });
	},
);
