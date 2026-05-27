/**
 * Purpose: Verify secure temporary artifact lifecycle helpers for the pi-agent-browser extension.
 * Responsibilities: Assert owned temp root cleanup, stale pruning, live-root safety, and aggregate disk-budget enforcement.
 * Scope: Unit-style Node test-runner coverage for temp helpers with isolated filesystem/env side effects.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
	cleanupSecureTempArtifacts,
	getSecureTempDebugState,
	openSecureTempFile,
	writeSecureTempFile,
	writeSecureTempRootOwnershipMarker,
} from "../extensions/agent-browser/lib/temp.js";
import { readChildStdoutJsonLine, stopChildProcess, withPatchedEnv } from "./helpers/agent-browser-harness.js";

test("secure temp cleanup can recreate and track a later temp root", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();

	const firstFile = await openSecureTempFile("debug-a", ".txt");
	await firstFile.fileHandle.close();
	const firstRoot = dirname(firstFile.path);
	assert.equal((await getSecureTempDebugState()).currentTempRoot, firstRoot);

	await cleanupSecureTempArtifacts();
	await assert.rejects(stat(firstRoot), { code: "ENOENT" });
	assert.deepEqual((await getSecureTempDebugState()).ownedTempRoots, []);

	const secondFile = await openSecureTempFile("debug-b", ".txt");
	await secondFile.fileHandle.close();
	const secondRoot = dirname(secondFile.path);
	assert.notEqual(secondRoot, firstRoot);

	const debugState = await getSecureTempDebugState();
	assert.equal(debugState.currentTempRoot, secondRoot);
	assert.deepEqual(debugState.ownedTempRoots, [secondRoot]);

	await cleanupSecureTempArtifacts();
});

test("stale temp pruning only removes explicitly owned roots", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const staleTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
	const unownedRoot = await mkdtemp(join(tmpdir(), "pi-agent-browser-unowned-"));
	const ownedRoot = await mkdtemp(join(tmpdir(), "pi-agent-browser-owned-"));
	await chmod(unownedRoot, 0o700);
	await chmod(ownedRoot, 0o700);
	await writeFile(join(unownedRoot, "leftover.txt"), "keep", "utf8");
	await utimes(unownedRoot, staleTime, staleTime);
	// Write the stale ownership marker immediately before triggering pruning. Any
	// secure temp root creation in a concurrent test file can legitimately prune
	// stale owned roots as soon as the marker exists, so avoid yielding again
	// before this test performs the pruning assertion itself.
	await writeSecureTempRootOwnershipMarker(ownedRoot, { createdAtMs: staleTime.getTime(), ownerPid: 99_999_999 });

	try {
		const tempFile = await openSecureTempFile("prune-check", ".txt");
		await tempFile.fileHandle.close();

		await assert.rejects(stat(ownedRoot), { code: "ENOENT" });
		await stat(unownedRoot);
		await rm(unownedRoot, { force: true, recursive: true });
		await cleanupSecureTempArtifacts();
	} finally {
		await rm(unownedRoot, { force: true, recursive: true }).catch(() => undefined);
		await rm(ownedRoot, { force: true, recursive: true }).catch(() => undefined);
		await cleanupSecureTempArtifacts();
	}
});

test("stale temp pruning removes roots whose marker PID was reused", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const staleTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
	const staleRoot = await mkdtemp(join(tmpdir(), "pi-agent-browser-reused-pid-"));
	await chmod(staleRoot, 0o700);
	const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1_000);"], {
		stdio: ["ignore", "ignore", "ignore"],
	});

	try {
		assert.ok(child.pid);
		await writeSecureTempRootOwnershipMarker(staleRoot, {
			createdAtMs: staleTime.getTime(),
			leaseUpdatedAtMs: staleTime.getTime(),
			ownerPid: child.pid,
			ownerProcessStartIdentity: "definitely-not-this-child-process-start",
		});
		await utimes(staleRoot, staleTime, staleTime);

		const before = await stat(staleRoot).then(() => true, () => false);
		const tempFile = await openSecureTempFile("prune-reused-pid", ".txt");
		await tempFile.fileHandle.close();
		const after = await stat(staleRoot).then(() => true, () => false);

		assert.deepEqual({ after, before }, { after: false, before: true });
	} finally {
		await stopChildProcess(child);
		await rm(staleRoot, { force: true, recursive: true }).catch(() => undefined);
		await cleanupSecureTempArtifacts();
	}
});

test("stale temp pruning does not remove a live root when owner identity is unavailable", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1_000);
	const childScript = `
		import { dirname } from "node:path";
		import { openSecureTempFile } from "./extensions/agent-browser/lib/temp.ts";
		const tempFile = await openSecureTempFile("live-root", ".txt");
		await tempFile.fileHandle.close();
		console.log(JSON.stringify({ root: dirname(tempFile.path) }));
		setInterval(() => undefined, 1_000);
	`;
	const childA = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});

	let liveRoot: string | undefined;
	try {
		liveRoot = (await readChildStdoutJsonLine<{ root: string }>(childA)).root;
		const markerPath = join(liveRoot, ".pi-agent-browser-owner.json");
		const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
		delete marker.ownerProcessStartIdentity;
		await writeFile(
			markerPath,
			JSON.stringify({ ...marker, createdAtMs: staleTime.getTime(), leaseUpdatedAtMs: staleTime.getTime() }, null, 2),
			"utf8",
		);
		await utimes(liveRoot, staleTime, staleTime);
		const before = await stat(liveRoot).then(() => true, () => false);

		const childBScript = `
			import { openSecureTempFile } from "./extensions/agent-browser/lib/temp.ts";
			const tempFile = await openSecureTempFile("prune-trigger", ".txt");
			await tempFile.fileHandle.close();
			console.log(JSON.stringify({ done: true }));
		`;
		const childB = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childBScript], {
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		const childBExit = once(childB, "exit");
		await readChildStdoutJsonLine<{ done: boolean }>(childB);
		const [childBExitCode] = await childBExit;
		assert.equal(childBExitCode, 0);

		const after = await stat(liveRoot).then(() => true, () => false);
		assert.deepEqual({ after, before }, { after: true, before: true });
	} finally {
		await stopChildProcess(childA);
		if (liveRoot) await rm(liveRoot, { force: true, recursive: true }).catch(() => undefined);
		await cleanupSecureTempArtifacts();
	}
});

test("writeSecureTempFile enforces the aggregate temp-root disk budget", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	await withPatchedEnv({ PI_AGENT_BROWSER_TEMP_ROOT_MAX_BYTES: "1024" }, async () => {
		await writeSecureTempFile({ content: "a".repeat(600), prefix: "budget-a", suffix: ".txt" });
		await assert.rejects(
			writeSecureTempFile({ content: "b".repeat(500), prefix: "budget-b", suffix: ".txt" }),
			/temp spill budget exceeded/i,
		);
	});
	await cleanupSecureTempArtifacts();
});
