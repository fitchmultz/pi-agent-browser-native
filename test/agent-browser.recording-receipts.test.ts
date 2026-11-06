import assert from "node:assert/strict";
import { readArray, readDefined, readRecord } from "./helpers/assertions.js";
import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest from "node:test";

import { applyAgentBrowserOutputPath } from "../extensions/agent-browser/lib/orchestration/output-file.js";
import type { FileArtifactMetadata } from "../extensions/agent-browser/lib/results/contracts.js";
import { buildToolPresentation } from "../extensions/agent-browser/lib/results/presentation.js";
import { formatArtifactMetadataLines } from "../extensions/agent-browser/lib/results/presentation/artifacts.js";

const measuredReceipt = {
	recordingId: "take-1",
	path: "capture.webm",
	success: true,
	error: null,
	frames: 60,
	capturedFrames: 2,
	fps: 30,
	capture: {
		startedAt: "2026-09-12T15:00:00.000Z",
		endedAt: "2026-09-12T15:00:05.000Z",
		durationMs: 5000,
		firstFrameAt: "2026-09-12T15:00:01.800Z",
		lastFrameAt: "2026-09-12T15:00:01.950Z",
		firstFrameAfterMs: 1800,
		lastFrameAfterMs: 1950,
		averageFps: 0.4,
		maxFrameGapMs: 3050,
		timestampSource: "local-receive",
	},
	output: {
		frames: 60,
		fps: 30,
		encodedFrames: 60,
		durationMs: 2000,
		durationSource: "encoded-frames/fps",
		heldFrames: 58,
		droppedFrames: 0,
		skippedFrames: 90,
		encoderSucceeded: true,
	},
	file: { exists: true, sizeBytes: 5 },
};

nodeTest(
	"session info separates daemon, browser and Pi ownership and keeps absent native identity unknown",
	async (t) => {
		for (const { browser, expected } of [
			{
				browser: undefined,
				expected: { chromePid: "unknown", cleanup: "caller-owned", ownership: "unknown" },
			},
			{
				browser: {
					status: "connected",
					alive: true,
					pid: 9876,
					userDataDir: "/exact/Chrome profile",
					ownership: "launched",
					tabs: [{ tabId: "t1", url: "https://app.test/", title: "Live tab", active: true }],
					error: null,
				},
				expected: { chromePid: "9876", cleanup: "wrapper-managed", ownership: "launched" },
			},
			{
				browser: {
					status: "connected",
					alive: true,
					pid: null,
					userDataDir: null,
					ownership: "attached",
					tabs: [],
					error: null,
				},
				expected: { chromePid: "unknown", cleanup: "caller-owned", ownership: "attached" },
			},
		] as const) {
			await t.test(expected.ownership, async (variant) => {
				const presentation = await buildToolPresentation({
					commandInfo: { command: "session", subcommand: "info" },
					cwd: process.cwd(),
					piCleanupOwnership:
						browser?.ownership === "launched" ? "wrapper-managed" : "caller-owned",
					envelope: {
						success: true,
						data: {
							active: true,
							pid: 1234,
							session: "shared",
							runtime: {
								browserLaunched: true,
								browser,
								recording: { current: null, last: measuredReceipt },
							},
						},
					},
				});
				const text = presentation.content[0]?.type === "text" ? presentation.content[0].text : "";
				assert.match(text, /Daemon: active; PID: 1234/);
				assert.match(text, new RegExp(`Chrome PID: ${expected.chromePid}`));
				assert.match(text, new RegExp(`Pi cleanup ownership: ${expected.cleanup}`));
				assert.match(text, new RegExp(`Native browser ownership: ${expected.ownership}`));
				assert.match(text, /take-1/);
				if (!browser) {
					await variant.test("absent browser identity", () => {
						assert.match(text, /Browser: unknown; alive: unknown/);
					});
				}
				if (
					browser?.userDataDir !== undefined &&
					browser.userDataDir !== null &&
					browser.userDataDir.length > 0
				) {
					await variant.test("profile and live tab", () => {
						assert.match(text, /Exact profile: \/exact\/Chrome profile/);
						assert.match(text, /Live tab/);
					});
				}
			});
		}
	},
);

nodeTest(
	"recording artifacts distinguish received capture frames, wall duration and encoded output from nominal FPS",
	async () => {
		const cwd = await mkdtemp(join(tmpdir(), "piab-receipt-"));
		try {
			await writeFile(join(cwd, "capture.webm"), "video");
			const result = await buildToolPresentation({
				commandInfo: { command: "record", subcommand: "stop" },
				cwd,
				envelope: { success: true, data: measuredReceipt },
			});
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			assert.match(text, /Captured frames \(received, not pixel-unique\): 2/);
			assert.match(text, /Captured-frame rate: 0\.4 fps/);
			assert.match(text, /Wall-clock capture duration: 5000 ms/);
			assert.match(text, /output duration \(encoded frames\/fps\): 2000 ms/);
			assert.match(text, /Encoded frames: 60/);
			assert.match(text, /Held frames: 58/);
			assert.match(text, /First frame: 2026-09-12T15:00:01.800Z/);
			assert.match(text, /cannot establish UI smoothness/);
			assert.equal(result.artifacts?.[0]?.recording?.capture.averageFps, 0.4);
			assert.equal(result.artifactVerification?.artifacts[0]?.recording?.output.encodedFrames, 60);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	},
);

nodeTest("legacy recording counts never manufacture capture time or capture FPS", async () => {
	const result = await buildToolPresentation({
		commandInfo: { command: "record", subcommand: "stop" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: { path: "missing.webm", frames: 300, capturedFrames: 1, fps: 30 },
		},
	});
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	assert.match(text, /Wall-clock capture duration: unknown/);
	assert.match(text, /Captured-frame rate: unknown/);
	assert.match(text, /Encoded frames: unknown/);
	assert.match(text, /cannot establish UI smoothness/);
	assert.equal(result.artifacts?.[0]?.recording?.capture.durationMs, null);
});

nodeTest(
	"artifact text distinguishes unknown presence from verified presence during pending finalization",
	() => {
		const artifact: FileArtifactMetadata = {
			kind: "video",
			command: "record",
			subcommand: "stop",
			path: "capture.webm",
			absolutePath: "/capture.webm",
		};
		const text = formatArtifactMetadataLines([
			{ ...artifact, status: "unverified" },
			{ ...artifact, status: "pending", exists: true },
			{ ...artifact, status: "pending", exists: false },
		]);
		assert.deepEqual(
			text.map((value) => value.match(/^Exists: .+$/m)?.[0]),
			["Exists: unknown", "Exists: true", "Exists: false"],
		);
	},
);

nodeTest(
	"restart preserves a failed previous receipt and the new pending take, directly and in a batch",
	async (t) => {
		const cwd = await mkdtemp(join(tmpdir(), "piab-restart-receipt-"));
		try {
			await writeFile(join(cwd, "capture.webm"), "video");
			const data = {
				restarted: true,
				path: "next.webm",
				recordingId: "take-2",
				previousRecording: { ...measuredReceipt, success: false, error: "No frames captured" },
			};
			for (const batch of [false, true]) {
				await t.test(batch ? "batch" : "direct", async () => {
					const result = await buildToolPresentation({
						commandInfo: batch
							? { command: "batch" }
							: { command: "record", subcommand: "restart" },
						cwd,
						envelope: {
							success: true,
							data: batch
								? [{ command: ["record", "restart", "next.webm"], success: true, result: data }]
								: data,
						},
					});
					assert.equal(result.resultCategory, "failure");
					assert.equal(readDefined(result.artifacts?.[0]).recording?.recordingId, "take-1");
					assert.equal(
						readRecord(readRecord(readArray(result.artifacts)[0]).recording).success,
						false,
					);
					assert.equal(
						readRecord(readRecord(readArray(result.artifacts)[1]).recording).recordingId,
						"take-2",
					);
					assert.equal(
						readRecord(readRecord(readRecord(readArray(result.artifacts)[1]).recording).capture)
							.durationMs,
						null,
					);
					assert.equal(result.artifactVerification?.pendingCount, 1);
					assert.doesNotMatch(
						result.content
							.filter((item) => item.type === "text")
							.map((item) => item.text)
							.join("\n"),
						/Previous recording saved/,
					);
				});
			}
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	},
);

nodeTest(
	"record-stop preflight failures export attempt evidence without inventing an artifact",
	async () => {
		const cwd = await mkdtemp(join(tmpdir(), "piab-receipt-preflight-"));
		try {
			const outputPath = join(cwd, "blocked.json");
			const result = await applyAgentBrowserOutputPath({
				cwd,
				outputPath,
				result: {
					isError: true,
					content: [{ type: "text", text: "Native session cannot be reused" }],
					details: {
						args: ["--session", "recording", "record", "stop"],
						sessionName: "recording",
						resultCategory: "failure",
						validationError: "Native session cannot be reused",
						agentBrowserStarted: false,
					},
				},
			});
			assert.equal(result.isError, true);
			const receipt = readRecord(JSON.parse(await readFile(outputPath, "utf8")));
			assert.equal(receipt.success, false);
			assert.equal(receipt.command, "record");
			assert.equal(readRecord(receipt.attempt).agentBrowserStarted, false);
			assert.equal(receipt.data, null);
			assert.equal(receipt.artifacts, undefined);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	},
);

nodeTest("failed recording receipt exports preserve artifact aliases and JSON mode", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piab-receipt-alias-"));
	try {
		const artifactPath = join(cwd, "capture.webm"),
			alias = join(cwd, "alias.json");
		await writeFile(artifactPath, "video");
		await link(artifactPath, alias);
		const result = await applyAgentBrowserOutputPath({
			cwd,
			outputPath: alias,
			preserveTextContent: true,
			result: {
				content: [
					{ type: "text", text: JSON.stringify({ success: false, error: "Encoder failed" }) },
				],
				isError: true,
				details: {
					command: "record",
					subcommand: "stop",
					resultCategory: "failure",
					artifacts: [{ absolutePath: artifactPath }],
					data: measuredReceipt,
				},
			},
		});
		assert.equal(result.isError, true);
		assert.equal(
			readRecord(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : ""))
				.success,
			false,
		);
		assert.equal(await readFile(artifactPath, "utf8"), "video");
		assert.equal(readRecord(readRecord(result.details).outputFile).status, "failed");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

nodeTest(
	"failed recording data survives direct and batch presentation without saved wording or file-only success",
	async (t) => {
		const cwd = await mkdtemp(join(tmpdir(), "piab-receipt-fail-"));
		try {
			await writeFile(join(cwd, "capture.webm"), "video");
			const receipt = {
				...measuredReceipt,
				success: false,
				error: "Encoder failed",
				output: { ...measuredReceipt.output, encoderSucceeded: false },
			};
			for (const batch of [false, true]) {
				await t.test(batch ? "batch" : "direct", async () => {
					const result = await buildToolPresentation({
						commandInfo: batch ? { command: "batch" } : { command: "record", subcommand: "stop" },
						cwd,
						errorText: batch ? undefined : "Encoder failed",
						envelope: batch
							? {
									success: false,
									data: [
										{
											command: ["record", "stop"],
											success: false,
											error: "Encoder failed",
											result: receipt,
										},
									],
								}
							: { success: false, data: receipt, error: "Encoder failed" },
					});
					assert.equal(result.resultCategory, "failure");
					assert.equal(result.artifacts?.[0]?.exists, true);
					assert.equal(
						readRecord(readRecord(readArray(result.artifacts)[0]).recording).success,
						false,
					);
					assert.equal(result.artifactVerification?.unverifiedCount, 1);
					assert.doesNotMatch(
						result.content[0]?.type === "text" ? result.content[0].text : "",
						/Saved recording/,
					);
					const outputPath = join(cwd, `failed-${batch}.json`);
					const exported = await applyAgentBrowserOutputPath({
						cwd,
						outputPath,
						result: {
							content: result.content,
							isError: true,
							details: {
								...result,
								command: batch ? "batch" : "record",
								subcommand: batch ? undefined : "stop",
								error: "Encoder failed",
							},
						},
					});
					assert.equal(exported.isError, true);
					const payload = readRecord(JSON.parse(await readFile(outputPath, "utf8")));
					assert.equal(payload.success, false);
					assert.equal(payload.error, "Encoder failed");
					assert.equal(
						readRecord(readRecord(readArray(payload.artifacts)[0]).recording).success,
						false,
					);
				});
			}
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	},
);
