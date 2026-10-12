/**
 * Purpose: Verify secure temporary artifact lifecycle helpers for the pi-agent-browser extension.
 * Responsibilities: Assert owned temp root cleanup, stale pruning, live-root safety, and aggregate disk-budget enforcement.
 * Scope: Unit-style Node test-runner coverage for temp helpers with isolated filesystem/env side effects.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import fs, {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import type { PathLike, RmOptions } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { readRecord, readArray, readString, readNumber } from "./helpers/assertions.js";

import {
	cleanupSecureTempArtifacts,
	getPersistentSessionArtifactMaxBytes,
	getSecureTempRootMaxBytes,
	openSecureTempFile,
	writePersistentSessionArtifactFile,
	writeSecureTempFile,
	writeSecureTempRootOwnershipMarker,
} from "../extensions/agent-browser/lib/temp.js";
import { listArtifactFiles } from "../extensions/agent-browser/lib/temp-artifact-budget.js";
import {
	readChildStdoutJsonLine,
	stopChildProcess,
	TEST_SESSION_ID,
	withPatchedEnv,
} from "./helpers/agent-browser-harness.js";

test("artifact file scans preserve order, exclusions and stat failures with bounded filesystem work", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "piab-artifact-scan-"));
	try {
		const names = ["a", "b", "c", "d", "e", "ignored", "failed"];
		await Promise.all(
			names.map((name, index) => writeFile(join(root, name), "x".repeat(index + 1))),
		);
		await mkdir(join(root, "directory"));
		const expectedOrder = (await readdir(root)).filter(
			(name) => !["directory", "ignored", "failed"].includes(name),
		);
		const nativeStat = fs.stat;
		let active = 0;
		let peak = 0;
		t.mock.method(fs, "stat", async (path: PathLike) => {
			active++;
			peak = Math.max(peak, active);
			try {
				await delay(String(path).endsWith("a") ? 10 : 1);
				if (String(path).endsWith("failed")) {
					throw Object.assign(new Error("disappearing file"), { code: "ENOENT" });
				}
				return await nativeStat(path);
			} finally {
				active--;
			}
		});
		syncBuiltinESMExports();
		try {
			const files = await listArtifactFiles(root, new Set(["ignored"]));
			assert.deepEqual(
				files.map((file) => file.path),
				expectedOrder.map((name) => join(root, name)),
			);
			assert.deepEqual(
				files.map((file) => file.size),
				expectedOrder.map((name) => names.indexOf(name) + 1),
			);
			assert.ok(peak <= 4, "directory size must not create an unbounded stat fan-out");
			assert.equal(active, 0);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("persistent session artifact budget accepts zero without changing bounded defaults", () => {
	const defaultBytes = 32 * 1_024 * 1_024;
	assert.equal(getPersistentSessionArtifactMaxBytes({}), defaultBytes);
	assert.equal(
		getPersistentSessionArtifactMaxBytes({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES: "0" }),
		0,
	);
	assert.equal(
		getPersistentSessionArtifactMaxBytes({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES: " 0 " }),
		0,
	);
	assert.equal(
		getPersistentSessionArtifactMaxBytes({
			PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES: " 01024 ",
		}),
		1_024,
	);
	for (const value of ["", "invalid", "-1", "1.5", "00", "-0", "0.0", "0e0", "9007199254740992"]) {
		// Fixed pruning variants validate each observed child/allocation; the final remaining-root assertion is unconditional.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(
			getPersistentSessionArtifactMaxBytes({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES: value }),
			defaultBytes,
			value,
		);
	}
	assert.equal(
		getSecureTempRootMaxBytes({ PI_AGENT_BROWSER_TEMP_ROOT_MAX_BYTES: "0" }),
		defaultBytes,
	);
});

test(
	"writePersistentSessionArtifactFile preserves earlier files with a zero budget",
	{ concurrency: false },
	async () => {
		const sessionDir = await mkdtemp(join(tmpdir(), "pi-session-unlimited-"));
		const store = { sessionDir, sessionId: TEST_SESSION_ID };
		try {
			await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES: "0" }, async () => {
				const earlier = await writePersistentSessionArtifactFile({
					content: "earlier output",
					prefix: "earlier",
					suffix: ".txt",
					store,
				});
				const latest = await writePersistentSessionArtifactFile({
					content: Buffer.alloc(32 * 1_024 * 1_024, "a"),
					prefix: "latest",
					suffix: ".bin",
					store,
				});

				assert.equal(await readFile(earlier.path, "utf8"), "earlier output");
				assert.equal((await stat(latest.path)).size, 32 * 1_024 * 1_024);
				assert.deepEqual(earlier.evictedArtifacts, []);
				assert.deepEqual(latest.evictedArtifacts, []);
			});
		} finally {
			await rm(sessionDir, { force: true, recursive: true });
		}
	},
);

test("failed artifact eviction does not claim space or publish a deletion receipt", async (t) => {
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-session-eviction-"));
	try {
		await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES: "10" }, async () => {
			const store = { sessionDir, sessionId: TEST_SESSION_ID };
			const earlier = await writePersistentSessionArtifactFile({
				content: "12345678",
				prefix: "earlier",
				suffix: ".txt",
				store,
			});
			const nativeRm = fs.rm;
			t.mock.method(fs, "rm", (path: PathLike, options?: Readonly<RmOptions>) => {
				if (String(path) === earlier.path) {
					return Promise.reject(Object.assign(new Error("held artifact"), { code: "EPERM" }));
				}
				return nativeRm(path, options);
			});
			syncBuiltinESMExports();
			try {
				await assert.rejects(
					writePersistentSessionArtifactFile({
						content: "abcde",
						prefix: "latest",
						suffix: ".txt",
						store,
					}),
					/persisted spill budget exceeded \(13 bytes > 10 byte limit\)/,
				);
				assert.equal(await readFile(earlier.path, "utf8"), "12345678");
				assert.deepEqual(await readdir(dirname(earlier.path)), [
					earlier.path.split(/[\\/]/).at(-1),
				]);
			} finally {
				t.mock.restoreAll();
				syncBuiltinESMExports();
			}
			const latest = await writePersistentSessionArtifactFile({
				content: "abcde",
				prefix: "latest",
				suffix: ".txt",
				store,
			});
			assert.deepEqual(
				latest.evictedArtifacts.map(({ path, sizeBytes }) => ({ path, sizeBytes })),
				[{ path: earlier.path, sizeBytes: 8 }],
			);
			await assert.rejects(stat(earlier.path), { code: "ENOENT" });
			assert.equal(await readFile(latest.path, "utf8"), "abcde");
		});
	} finally {
		await rm(sessionDir, { recursive: true, force: true });
	}
});

const originalTempEnv = {
	TMPDIR: process.env.TMPDIR,
	TEMP: process.env.TEMP,
	TMP: process.env.TMP,
};
let suiteTempDir: string;
test.before(async () => {
	suiteTempDir = await mkdtemp(join(tmpdir(), "piab-temp-tests-"));
	process.env.TMPDIR = suiteTempDir;
	process.env.TEMP = suiteTempDir;
	process.env.TMP = suiteTempDir;
});
test.after(async () => {
	await cleanupSecureTempArtifacts();
	for (const [key, value] of Object.entries(originalTempEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	await rm(suiteTempDir, { recursive: true, force: true });
});

test(
	"secure temp cleanup can recreate and track a later temp root",
	{ concurrency: false },
	async () => {
		await cleanupSecureTempArtifacts();

		const firstFile = await openSecureTempFile("debug-a", ".txt");
		await firstFile.fileHandle.close();
		const firstRoot = dirname(firstFile.path);
		assert.equal((await stat(firstRoot)).isDirectory(), true);

		await cleanupSecureTempArtifacts();
		await assert.rejects(stat(firstRoot), { code: "ENOENT" });

		const secondFile = await openSecureTempFile("debug-b", ".txt");
		await secondFile.fileHandle.close();
		const secondRoot = dirname(secondFile.path);
		assert.notEqual(secondRoot, firstRoot);
		const markerPath = join(secondRoot, ".pi-agent-browser-owner.json");
		const marker = readRecord(JSON.parse(await readFile(markerPath, "utf8")));
		assert.equal(marker.version, 2);

		await cleanupSecureTempArtifacts();
		await assert.rejects(stat(secondRoot), { code: "ENOENT" });
	},
);

test("temp allocation removes a failed ownership root and retries after marker failure", async (t) => {
	await cleanupSecureTempArtifacts();
	const nativeMkdtemp = fs.mkdtemp;
	let failedRoot = "";
	t.mock.method(fs, "mkdtemp", async (prefix: string) => {
		const root = await nativeMkdtemp(prefix);
		if (failedRoot === "") {
			failedRoot = root;
			// A real exclusive-marker write will fail on this task-owned planted directory.
			await mkdir(join(root, ".pi-agent-browser-owner.json"));
		}
		return root;
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(openSecureTempFile("failed", ".txt"), { code: "EEXIST" });
		assert.notEqual(failedRoot, "", "failure must occur after allocating the root");
		await assert.rejects(stat(failedRoot), { code: "ENOENT" });
		await cleanupSecureTempArtifacts();
		const recovered = await openSecureTempFile("recovered", ".txt");
		await recovered.fileHandle.close();
		assert.notEqual(dirname(recovered.path), failedRoot);
		assert.equal(
			readRecord(
				JSON.parse(
					await readFile(join(dirname(recovered.path), ".pi-agent-browser-owner.json"), "utf8"),
				),
			).version,
			2,
		);
		await cleanupSecureTempArtifacts();
		await assert.rejects(stat(dirname(recovered.path)), { code: "ENOENT" });
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		await cleanupSecureTempArtifacts();
	}
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
	await writeSecureTempRootOwnershipMarker(ownedRoot, {
		createdAtMs: staleTime.getTime(),
		ownerPid: 99_999_999,
	});

	try {
		const tempFile = await openSecureTempFile("prune-check", ".txt");
		await tempFile.fileHandle.close();

		await assert.rejects(stat(ownedRoot), { code: "ENOENT" });
		await stat(unownedRoot);
		await rm(unownedRoot, { force: true, recursive: true });
		await cleanupSecureTempArtifacts();
	} finally {
		await rm(unownedRoot, { force: true, recursive: true }).catch(() => {
			/* Best-effort teardown: these task-owned paths may already be absent. */
		});
		await rm(ownedRoot, { force: true, recursive: true }).catch(() => {
			/* Best-effort teardown: these task-owned paths may already be absent. */
		});
		await cleanupSecureTempArtifacts();
	}
});

for (const shortLived of [false, true]) {
	test(
		`stale temp pruning bounds each allocation and advances past retained roots${shortLived ? " across short-lived processes" : ""}`,
		{ concurrency: false },
		async () => {
			await cleanupSecureTempArtifacts();
			const tempDir = await mkdtemp(join(tmpdir(), "bounded-temp-gc-"));
			try {
				await withPatchedEnv({ TMPDIR: tempDir, TEMP: tempDir, TMP: tempDir }, async () => {
					const old = Date.now() - 25 * 60 * 60 * 1_000;
					for (let index = 0; index < 20; index += 1) {
						const path = join(tempDir, `pi-agent-browser-${String(index).padStart(2, "0")}`);
						// Finish each root before advancing; setup failures must not leave writes racing teardown.
						// oxlint-disable-next-line no-await-in-loop
						await mkdir(path, { mode: 0o700 });
						// Finish this root's ownership marker before any later root construction or teardown.
						// oxlint-disable-next-line no-await-in-loop
						await writeSecureTempRootOwnershipMarker(path, {
							createdAtMs: index < 8 ? Date.now() : old,
							ownerPid: 2_147_483_647,
							ownerProcessStartIdentity: "dead",
						});
					}
					let remaining = 20;
					for (let attempt = 0; attempt < 8 && remaining > 8; attempt += 1) {
						if (shortLived) {
							const child = spawn(
								process.execPath,
								[
									"--input-type=module",
									"-e",
									`
						import crypto from "node:crypto";
						import fs from "node:fs/promises";
						import { syncBuiltinESMExports } from "node:module";
						// Control only the random draw, never ownership or filesystem results.
						crypto.randomInt = (max) => Math.min(8, max - 1);
						let reads = 0;
						const readFile = fs.readFile;
						fs.readFile = (...args) => {
							if (/pi-agent-browser-\\d{2}[/\\\\]\\.pi-agent-browser-owner\\.json$/.test(String(args[0]))) reads++;
							return readFile(...args);
						};
						syncBuiltinESMExports();
						const { openSecureTempFile, cleanupSecureTempArtifacts } = await import("./dist/extensions/agent-browser/lib/temp.js");
						const file = await openSecureTempFile("bounded-gc", ".txt");
						await file.fileHandle.close();
						await cleanupSecureTempArtifacts();
						console.log(JSON.stringify({ done: true, reads }));
					`,
								],
								{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
							);
							const exited = once(child, "exit");
							try {
								// Each allocation/child cleanup must finish before measuring the next shared-root pruning cycle.
								// oxlint-disable-next-line no-await-in-loop
								const receipt = readRecord(await readChildStdoutJsonLine(child));
								// Fixed pruning variants validate each observed child/allocation; the final remaining-root assertion is unconditional.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(receipt.done, true);
								// Fixed pruning variants validate each observed child/allocation; the final remaining-root assertion is unconditional.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.ok(
									readNumber(receipt.reads) <= 8,
									"retained roots count against the inspection limit",
								);
								// Each allocation/child cleanup must finish before measuring the next shared-root pruning cycle.
								// oxlint-disable-next-line no-await-in-loop
								const exit = readArray(await exited);
								// Fixed pruning variants validate each observed child/allocation; the final remaining-root assertion is unconditional.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(exit[0], 0);
							} finally {
								// Each allocation/child cleanup must finish before measuring the next shared-root pruning cycle.
								// oxlint-disable-next-line no-await-in-loop
								await stopChildProcess(child);
							}
						} else {
							// Each allocation/child cleanup must finish before measuring the next shared-root pruning cycle.
							// oxlint-disable-next-line no-await-in-loop
							const file = await openSecureTempFile("bounded-gc", ".txt");
							// Each allocation/child cleanup must finish before measuring the next shared-root pruning cycle.
							// oxlint-disable-next-line no-await-in-loop
							await file.fileHandle.close();
						}
						// Each allocation/child cleanup must finish before measuring the next shared-root pruning cycle.
						// oxlint-disable-next-line no-await-in-loop
						const after = (await readdir(tempDir)).filter((name) =>
							/^pi-agent-browser-\d{2}$/.test(name),
						).length;
						// Fixed pruning variants validate each observed child/allocation; the final remaining-root assertion is unconditional.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.ok(remaining - after <= 8, "one allocation must not sweep all stale roots");
						remaining = after;
					}
					assert.equal(remaining, 8, "GC must advance past the eight young roots");
					await cleanupSecureTempArtifacts();
				});
			} finally {
				await cleanupSecureTempArtifacts();
				await rm(tempDir, { recursive: true, force: true });
			}
		},
	);
}

test(
	"stale temp pruning removes roots whose marker PID was reused",
	{ concurrency: false },
	async () => {
		await cleanupSecureTempArtifacts();
		const staleTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
		const staleRoot = await mkdtemp(join(tmpdir(), "pi-agent-browser-reused-pid-"));
		await chmod(staleRoot, 0o700);
		const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1_000);"], {
			stdio: ["ignore", "ignore", "ignore"],
		});

		try {
			assert.ok(child.pid !== undefined && child.pid !== 0);
			await writeSecureTempRootOwnershipMarker(staleRoot, {
				createdAtMs: staleTime.getTime(),
				leaseUpdatedAtMs: staleTime.getTime(),
				ownerPid: child.pid,
				ownerProcessStartIdentity: "definitely-not-this-child-process-start",
			});
			await utimes(staleRoot, staleTime, staleTime);

			const before = await stat(staleRoot).then(
				() => true,
				() => false,
			);
			const tempFile = await openSecureTempFile("prune-reused-pid", ".txt");
			await tempFile.fileHandle.close();
			const after = await stat(staleRoot).then(
				() => true,
				() => false,
			);

			assert.deepEqual({ after, before }, { after: false, before: true });
		} finally {
			await stopChildProcess(child);
			await rm(staleRoot, { force: true, recursive: true }).catch(() => {
				/* Best-effort teardown: these task-owned paths may already be absent. */
			});
			await cleanupSecureTempArtifacts();
		}
	},
);

test(
	"stale temp pruning does not remove a live root when owner identity is unavailable",
	{ concurrency: false },
	async () => {
		await cleanupSecureTempArtifacts();
		const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1_000);
		const childScript = `
		import { dirname } from "node:path";
		import { openSecureTempFile } from "./dist/extensions/agent-browser/lib/temp.js";
		const tempFile = await openSecureTempFile("live-root", ".txt");
		await tempFile.fileHandle.close();
		console.log(JSON.stringify({ root: dirname(tempFile.path) }));
		setInterval(() => undefined, 1_000);
	`;
		const childA = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
		});

		let liveRoot: string | undefined;
		try {
			liveRoot = readString(readRecord(await readChildStdoutJsonLine(childA)).root);
			const markerPath = join(readString(liveRoot), ".pi-agent-browser-owner.json");
			const marker = readRecord(JSON.parse(await readFile(markerPath, "utf8")));
			delete marker.ownerProcessStartIdentity;
			await writeFile(
				markerPath,
				JSON.stringify(
					{ ...marker, createdAtMs: staleTime.getTime(), leaseUpdatedAtMs: staleTime.getTime() },
					null,
					2,
				),
				"utf8",
			);
			await utimes(liveRoot, staleTime, staleTime);
			const before = await stat(liveRoot).then(
				() => true,
				() => false,
			);

			const childBScript = `
			import { openSecureTempFile } from "./dist/extensions/agent-browser/lib/temp.js";
			const tempFile = await openSecureTempFile("prune-trigger", ".txt");
			await tempFile.fileHandle.close();
			console.log(JSON.stringify({ done: true }));
		`;
			const childB = spawn(process.execPath, ["--input-type=module", "-e", childBScript], {
				cwd: process.cwd(),
				stdio: ["ignore", "pipe", "pipe"],
			});
			const childBExit = once(childB, "exit");
			readRecord(await readChildStdoutJsonLine(childB));
			const [childBExitCode] = readArray(await childBExit);
			assert.equal(childBExitCode, 0);

			const after = await stat(liveRoot).then(
				() => true,
				() => false,
			);
			assert.deepEqual({ after, before }, { after: true, before: true });
		} finally {
			await stopChildProcess(childA);
			if (liveRoot !== undefined && liveRoot !== "") {
				await rm(liveRoot, { force: true, recursive: true }).catch(() => {
					/* Best-effort teardown: these task-owned paths may already be absent. */
				});
			}
			await cleanupSecureTempArtifacts();
		}
	},
);

test(
	"stale temp pruning preserves profile children protected by prior process metadata",
	{ concurrency: false },
	async () => {
		const childAScript = `
		import { dirname, join } from "node:path";
		import { writeFile } from "node:fs/promises";
		import { cleanupSecureTempArtifacts, createSecureTempDirectory, writeSecureTempFile } from "./dist/extensions/agent-browser/lib/temp.js";
		const profile = await createSecureTempDirectory("electron-profile-");
		await writeFile(join(profile, "profile-state.txt"), "keep", "utf8");
		const spill = await writeSecureTempFile({ content: "delete", prefix: "spill", suffix: ".txt" });
		const root = dirname(profile);
		await cleanupSecureTempArtifacts({ preservePaths: [profile] });
		console.log(JSON.stringify({ profile, root, spill }));
	`;
		const childA = spawn(process.execPath, ["--input-type=module", "-e", childAScript], {
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let root: string | undefined;
		let childB: ReturnType<typeof spawn> | undefined;
		try {
			const childAExit = once(childA, "exit");
			const result = readRecord(await readChildStdoutJsonLine(childA));
			root = readString(result.root);
			const [childAExitCode] = readArray(await childAExit);
			assert.equal(childAExitCode, 0);
			assert.equal(
				await readFile(join(readString(result.profile), "profile-state.txt"), "utf8"),
				"keep",
			);
			await assert.rejects(stat(readString(result.spill)), { code: "ENOENT" });

			const markerPath = join(readString(result.root), ".pi-agent-browser-owner.json");
			const staleTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
			const marker = readRecord(JSON.parse(await readFile(markerPath, "utf8")));
			await writeFile(
				markerPath,
				JSON.stringify(
					{ ...marker, createdAtMs: staleTime.getTime(), leaseUpdatedAtMs: staleTime.getTime() },
					null,
					2,
				),
				"utf8",
			);
			await writeFile(join(readString(result.root), "unprotected-spill.txt"), "delete", "utf8");
			await utimes(readString(result.root), staleTime, staleTime);

			const childBScript = `
			import { openSecureTempFile } from "./dist/extensions/agent-browser/lib/temp.js";
			const tempFile = await openSecureTempFile("prune-trigger", ".txt");
			await tempFile.fileHandle.close();
			console.log(JSON.stringify({ done: true }));
		`;
			childB = spawn(process.execPath, ["--input-type=module", "-e", childBScript], {
				cwd: process.cwd(),
				stdio: ["ignore", "pipe", "pipe"],
			});
			const childBExit = once(childB, "exit");
			readRecord(await readChildStdoutJsonLine(childB));
			const [childBExitCode] = readArray(await childBExit);
			assert.equal(childBExitCode, 0);

			assert.equal(
				await readFile(join(readString(result.profile), "profile-state.txt"), "utf8"),
				"keep",
			);
			await assert.rejects(stat(join(readString(result.root), "unprotected-spill.txt")), {
				code: "ENOENT",
			});
		} finally {
			await stopChildProcess(childA);
			if (childB) {
				await stopChildProcess(childB);
			}
			if (root !== undefined && root !== "") {
				await rm(root, { force: true, recursive: true }).catch(() => {
					/* Best-effort teardown: these task-owned paths may already be absent. */
				});
			}
			await cleanupSecureTempArtifacts();
		}
	},
);

test(
	"writeSecureTempFile enforces the aggregate temp-root disk budget",
	{ concurrency: false },
	async () => {
		await cleanupSecureTempArtifacts();
		await withPatchedEnv({ PI_AGENT_BROWSER_TEMP_ROOT_MAX_BYTES: "1024" }, async () => {
			await writeSecureTempFile({ content: "a".repeat(600), prefix: "budget-a", suffix: ".txt" });
			await assert.rejects(
				writeSecureTempFile({ content: "b".repeat(500), prefix: "budget-b", suffix: ".txt" }),
				/temp spill budget exceeded/i,
			);
		});
		await cleanupSecureTempArtifacts();
	},
);
