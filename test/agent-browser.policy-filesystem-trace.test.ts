import assert from "node:assert/strict";
import fs, {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readClaim } from "../extensions/agent-browser/lib/browser-execution-claim-storage.js";
import { hasErrorCode } from "./helpers/assertions.js";
import { tracePolicyFilesystem } from "./helpers/policy-filesystem-trace.js";

const nativeReadFileAtLoad = fs.readFile;

test("policy filesystem trace passes through native values/errors and ignores unrelated files", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "piab-trace-"));
	const policy = join(root, "pi-agent-browser-policy-fixture");
	const nativeReadFile = fs.readFile;
	let nativeValue: unknown;
	let nativeError: unknown;
	// This observer still performs real I/O; compare the exact native fulfillment/rejection objects.
	const observer = t.mock.method(
		fs,
		"readFile",
		async (...args: Readonly<Parameters<typeof fs.readFile>>) => {
			try {
				nativeValue = await nativeReadFile(...args);
				return nativeValue;
			} catch (error) {
				nativeError = error;
				throw error;
			}
		},
	);
	syncBuiltinESMExports();
	const trace = tracePolicyFilesystem(t);
	try {
		await mkdir(policy, { mode: 0o700 });
		const owner = join(policy, "owner.json");
		await writeFile(owner, "x".repeat(2_048), { mode: 0o600 });
		const value = await readFile(owner);
		assert.strictEqual(value, nativeValue);
		assert.equal(value.length, 2_048);
		await assert.rejects(
			readFile(join(policy, "missing")),
			(error: unknown) => error === nativeError && hasErrorCode(error, "ENOENT"),
		);
		await lstat(owner);
		assert.deepEqual(await readdir(policy), ["owner.json"]);
		await rename(owner, join(policy, "ticket.json"));
		await rm(join(policy, "ticket.json"));
		const snapshot = trace.snapshot();
		assert.deepEqual(
			new Set(snapshot.recent.map((entry) => entry.op)),
			new Set(["mkdir", "readFile", "writeFile", "lstat", "readdir", "rename", "rm"]),
		);
		const read = snapshot.recent.find((entry) => entry.content !== undefined);
		assert.equal(read?.content?.length, 1_024);
		assert.equal(read.bytes, 2_048);
		assert.equal(
			snapshot.recent.find((entry) => entry.op === "writeFile")?.input?.content.length,
			1_024,
		);
		assert.equal(snapshot.recent.find((entry) => entry.op === "writeFile")?.input?.bytes, 2_048);
		assert.deepEqual(snapshot.recent.find((entry) => entry.op === "rename")?.paths, [
			owner,
			join(policy, "ticket.json"),
		]);
		const metadata = snapshot.recent.find((entry) => entry.op === "lstat")?.stat;
		assert.equal(metadata?.isFile, true);
		assert.equal(metadata.isDirectory, false);
		assert.equal(metadata.isSymbolicLink, false);
		assert.equal(metadata.size, 2_048);
		assert.equal(typeof metadata.mode, "number");
		assert.equal(typeof metadata.uid, "number");
		assert.equal(snapshot.failures[0]?.code, "ENOENT");
		assert.match(snapshot.failures[0]?.syscall ?? "", /open/);
		await writeFile(join(root, "unrelated"), "not policy content");
		await readFile(join(root, "unrelated"));
		await assert.rejects(readFile(join(root, "absent")), (error: unknown) =>
			hasErrorCode(error, "ENOENT"),
		);
		assert.deepEqual(trace.snapshot(), snapshot);
		assert.equal(trace.failureMessage({ isError: false }), undefined);
		assert.match(trace.failureMessage({ isError: true }) ?? "", /Native policy filesystem trace/);
	} finally {
		trace.restore();
		// Clear nested mock registrations before restoring the observer's original descriptor;
		// automatic teardown must not reinstall that observer after this test ends.
		t.mock.reset();
		observer.mock.restore();
		syncBuiltinESMExports();
		await rm(root, { recursive: true, force: true });
	}
});

test("policy filesystem trace bounds recent operations and retains a separate native error ring", async (t) => {
	assert.strictEqual(
		fs.readFile,
		nativeReadFileAtLoad,
		"the previous test must not leak its nested observer",
	);
	assert.strictEqual(readFile, nativeReadFileAtLoad, "named ESM imports must also remain restored");
	const root = await mkdtemp(join(tmpdir(), "piab-trace-"));
	const policy = join(root, ".pi-agent-browser-policy-fixture");
	await mkdir(policy, { mode: 0o700 });
	const trace = tracePolicyFilesystem(t);
	try {
		await Promise.all(
			Array.from({ length: 40 }, (_, index) =>
				assert.rejects(readFile(join(policy, `missing-${index}`)), (error: unknown) =>
					hasErrorCode(error, "ENOENT"),
				),
			),
		);
		await Promise.all(Array.from({ length: 40 }, () => lstat(policy)));
		const snapshot = trace.snapshot();
		assert.equal(snapshot.operations, 80);
		assert.equal(snapshot.errors, 40);
		assert.equal(snapshot.omittedOperations, 48);
		assert.equal(snapshot.omittedFailures, 32);
		assert.equal(snapshot.recent.length, 32);
		assert.equal(snapshot.failures.length, 8);
		assert.equal(
			snapshot.recent.every((entry) => entry.outcome === "ok"),
			true,
		);
		assert.equal(
			snapshot.failures.every((entry) => entry.code === "ENOENT"),
			true,
		);
		assert.ok(JSON.stringify(snapshot).length < 64 * 1_024);
	} finally {
		trace.restore();
		await rm(root, { recursive: true, force: true });
	}
});

test("production readClaim named ESM imports are traced and restored even through a thrown failure", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "piab-trace-"));
	const policy = join(root, ".pi-agent-browser-policy-fixture.claim-token");
	const owner = {
		version: 4,
		pid: process.pid,
		startIdentity: "fixture",
		token: "token",
		sessionNames: ["fixture"],
	};
	await mkdir(policy, { mode: 0o700 });
	await writeFile(join(policy, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
	const originals = { mkdir, lstat, readdir, readFile, writeFile, rename, rm };
	const trace = tracePolicyFilesystem(t);
	try {
		const claim = await readClaim(policy);
		assert.deepEqual(claim, { owner, path: policy, ticket: null });
		const snapshot = trace.snapshot();
		assert.ok(
			snapshot.recent.some(
				(entry) => entry.op === "readFile" && entry.content === JSON.stringify(owner),
			),
		);
		assert.ok(
			snapshot.failures.some(
				(entry) =>
					entry.op === "lstat" &&
					entry.paths[0]?.endsWith("ticket.json") &&
					entry.code === "ENOENT",
			),
		);
		await writeFile(join(policy, "owner.json"), "{malformed", { mode: 0o600 });
		assert.equal(await readClaim(policy), undefined);
		assert.ok(
			trace
				.snapshot()
				.recent.some((entry) => entry.outcome === "ok" && entry.content === "{malformed"),
		);
		const failure = new Error("assertion-like test failure");
		await assert.rejects(
			async () => {
				try {
					await readClaim(policy);
					throw failure;
				} finally {
					trace.restore();
				}
			},
			(error: unknown) => error === failure,
		);
		assert.deepEqual({ mkdir, lstat, readdir, readFile, writeFile, rename, rm }, originals);
		assert.deepEqual(
			{
				mkdir: fs.mkdir,
				lstat: fs.lstat,
				readdir: fs.readdir,
				readFile: fs.readFile,
				writeFile: fs.writeFile,
				rename: fs.rename,
				rm: fs.rm,
			},
			originals,
		);
		const restoredSnapshot = trace.snapshot();
		assert.equal(await readClaim(policy), undefined);
		assert.deepEqual(
			trace.snapshot(),
			restoredSnapshot,
			"production named imports must stop tracing after restore",
		);
	} finally {
		trace.restore();
		await rm(root, { recursive: true, force: true });
	}
});
