import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest from "node:test";
import { buildSnapshotPresentation } from "../extensions/agent-browser/lib/results/snapshot.js";
import {
	compactLargePresentationOutput,
	renderAgentBrowserObservation,
} from "../extensions/agent-browser/lib/results/presentation/large-output.js";
import { mergeSessionArtifactManifest } from "../extensions/agent-browser/lib/results/artifact-manifest.js";
import {
	PersistentSessionArtifactWriteError,
	writePersistentSessionArtifactFile,
} from "../extensions/agent-browser/lib/temp.js";
import type {
	SessionArtifactManifest,
	ToolPresentation,
} from "../extensions/agent-browser/lib/results/contracts.js";
import { readDefined, readRecord } from "./helpers/assertions.js";
import { withPatchedEnv } from "./helpers/agent-browser-harness.js";

nodeTest(
	"failed persistent writes retain completed eviction receipts and original cause",
	async (t) => {
		for (const failureMode of ["budget", "open", "write"]) {
			await t.test(failureMode, async (subtest) => {
				const sessionDir = await mkdtemp(join(tmpdir(), "piab-eviction-error-"));
				const store = { sessionDir, sessionId: "test" };
				const directory = join(sessionDir, ".pi-agent-browser-artifacts", store.sessionId);
				await mkdir(directory, { recursive: true });
				const path = join(directory, "earlier.txt");
				await writeFile(path, "12345678");
				const metadata = await stat(path);
				const failure = Object.assign(new Error("disk unavailable"), { code: "EIO" });
				const nativeOpen = fs.open;
				if (failureMode !== "budget") {
					subtest.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
						if (failureMode === "open") {
							throw failure;
						}
						const handle = await nativeOpen(...args);
						subtest.mock.method(handle, "writeFile", () => Promise.reject(failure));
						return handle;
					});
					syncBuiltinESMExports();
				}
				try {
					await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES: "10" }, async () => {
						await assert.rejects(
							writePersistentSessionArtifactFile({
								store,
								content: "x".repeat(failureMode === "budget" ? 11 : 5),
								prefix: "new",
								suffix: ".txt",
							}),
							(error: unknown) => {
								assert.ok(error instanceof PersistentSessionArtifactWriteError);
								assert.ok(error.cause instanceof Error);
								assert.equal(
									error.message,
									failureMode === "budget"
										? "pi-agent-browser persisted spill budget exceeded (11 bytes > 10 byte limit)."
										: failure.message,
								);
								assert.deepEqual(error.evictedArtifacts, [
									{ path, mtimeMs: metadata.mtimeMs, sizeBytes: 8 },
								]);
								assert.ok(failureMode === "budget" || error.cause === failure);
								return true;
							},
						);
						assert.deepEqual(await readdir(directory), []);
					});
				} finally {
					subtest.mock.restoreAll();
					syncBuiltinESMExports();
					await rm(sessionDir, { recursive: true, force: true });
				}
			});
		}
	},
);

nodeTest(
	"spill receivers mark actual evictions even when the replacement cannot fit",
	async (t) => {
		for (const receiver of ["snapshot", "presentation", "observation"]) {
			await t.test(receiver, async () => {
				const sessionDir = await mkdtemp(join(tmpdir(), "piab-eviction-receiver-"));
				const sessionId = "test";
				const directory = join(sessionDir, ".pi-agent-browser-artifacts", sessionId);
				await mkdir(directory, { recursive: true });
				const evictedPath = join(directory, "evict.txt");
				const protectedPath = join(directory, "protected.txt");
				await writeFile(evictedPath, "12345678");
				await writeFile(protectedPath, "protected");
				const store = { sessionDir, sessionId, protectedPaths: [protectedPath] };
				const manifest = readDefined(
					mergeSessionArtifactManifest({
						entries: [evictedPath, protectedPath].map((path) => ({
							path,
							createdAtMs: 1,
							kind: "spill",
							retentionState: "live",
							storageScope: "persistent-session",
						})),
					}),
				);
				const text = "long observation ".repeat(3000);
				try {
					await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES: "20" }, async () => {
						let result: {
							artifactManifest?: SessionArtifactManifest | undefined;
							content?: ToolPresentation["content"];
						};
						if (receiver === "snapshot") {
							result = await buildSnapshotPresentation({ snapshot: text }, store, manifest);
						} else if (receiver === "presentation") {
							result = await compactLargePresentationOutput({
								artifactManifest: manifest,
								commandInfo: { command: "eval" },
								data: text,
								persistentArtifactStore: store,
								presentation: { content: [{ type: "text", text }], summary: "output" },
							});
						} else {
							result = await renderAgentBrowserObservation({
								content: [],
								details: { data: text, artifactManifest: manifest },
								json: true,
								succeeded: true,
								persistentArtifactStore: store,
							});
						}
						assert.equal(readRecord(result).fullOutputPath, undefined);
						assert.match(JSON.stringify(result.content), /persisted spill budget exceeded/);
						const updated = readDefined(result.artifactManifest);
						assert.equal(updated.evictedCount, 1);
						assert.equal(updated.liveCount, 1);
						const evicted = readDefined(
							updated.entries.find((entry) => entry.path === evictedPath),
						);
						assert.equal(evicted.retentionState, "evicted");
						assert.equal(evicted.sizeBytes, 8);
						assert.equal(typeof evicted.evictedAtMs, "number");
						assert.equal(
							updated.entries.find((entry) => entry.path === protectedPath)?.retentionState,
							"live",
						);
						assert.deepEqual(await readdir(directory), ["protected.txt"]);
						assert.equal(manifest.liveCount, 2, "the borrowed manifest stays unchanged");
					});
				} finally {
					await rm(sessionDir, { recursive: true, force: true });
				}
			});
		}
	},
);
