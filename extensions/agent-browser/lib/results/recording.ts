import { isRecord } from "../parsing.js";

const RECORDING_QUALITY_WARNING = "Capture quality warning: repaint-driven capture, held/repeated or static frames, and late/final-state-only frames cannot establish UI smoothness. Output FPS is not captured-frame rate; inspect the recording and capture window before judging motion.";

export interface RecordingReceipt {
	warning: string;
	recordingId: string | null;
	path: string;
	success: boolean | null;
	error: string | null;
	frames: number | null;
	capturedFrames: number | null;
	fps: number | null;
	capture: {
		startedAt: string | null;
		endedAt: string | null;
		durationMs: number | null;
		firstFrameAt: string | null;
		lastFrameAt: string | null;
		firstFrameAfterMs: number | null;
		lastFrameAfterMs: number | null;
		averageFps: number | null;
		maxFrameGapMs: number | null;
		timestampSource: string | null;
	};
	output: {
		frames: number | null;
		fps: number | null;
		encodedFrames: number | null;
		durationMs: number | null;
		durationSource: string | null;
		heldFrames: number | null;
		droppedFrames: number | null;
		skippedFrames: number | null;
		encoderSucceeded: boolean | null;
	};
	file: { exists: boolean | null; sizeBytes: number | null };
}

function number(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function getRecordingReceipt(value: unknown, outcome?: boolean): RecordingReceipt | undefined {
	if (!isRecord(value) || typeof value.path !== "string" || !value.path) return undefined;
	const capture = isRecord(value.capture) ? value.capture : {};
	const output = isRecord(value.output) ? value.output : {};
	const file = isRecord(value.file) ? value.file : {};
	return {
		warning: RECORDING_QUALITY_WARNING,
		recordingId: text(value.recordingId), path: value.path,
		success: typeof value.success === "boolean" ? value.success : value.success === null ? null : outcome ?? null,
		error: text(value.error), frames: number(value.frames), capturedFrames: number(value.capturedFrames), fps: number(value.fps),
		capture: {
			startedAt: text(capture.startedAt), endedAt: text(capture.endedAt), durationMs: number(capture.durationMs),
			firstFrameAt: text(capture.firstFrameAt), lastFrameAt: text(capture.lastFrameAt), firstFrameAfterMs: number(capture.firstFrameAfterMs), lastFrameAfterMs: number(capture.lastFrameAfterMs),
			averageFps: number(capture.averageFps), maxFrameGapMs: number(capture.maxFrameGapMs), timestampSource: text(capture.timestampSource),
		},
		output: {
			frames: number(output.frames ?? value.frames), fps: number(output.fps ?? value.fps), encodedFrames: number(output.encodedFrames),
			durationMs: number(output.durationMs), durationSource: text(output.durationSource), heldFrames: number(output.heldFrames), droppedFrames: number(output.droppedFrames), skippedFrames: number(output.skippedFrames),
			encoderSucceeded: typeof output.encoderSucceeded === "boolean" ? output.encoderSucceeded : null,
		},
		file: { exists: typeof file.exists === "boolean" ? file.exists : null, sizeBytes: number(file.sizeBytes) },
	};
}

export function formatRecordingReceipt(receipt: RecordingReceipt): string {
	const metric = (value: string | number | null, unit = "") => value === null ? "unknown" : `${value}${unit}`;
	return [
		`Recording ID: ${metric(receipt.recordingId)}`,
		`Native recording outcome: ${receipt.success === true ? "succeeded" : receipt.success === false ? "failed" : "pending/unknown"}${receipt.error ? ` — ${receipt.error}` : ""}`,
		`Capture started: ${metric(receipt.capture.startedAt)}; ended: ${metric(receipt.capture.endedAt)}`,
		`Wall-clock capture duration: ${metric(receipt.capture.durationMs, " ms")}`,
		`Captured frames (received, not pixel-unique): ${metric(receipt.capturedFrames)}`,
		`Captured-frame rate: ${metric(receipt.capture.averageFps, " fps")}`,
		`First frame: ${metric(receipt.capture.firstFrameAt)}; after start: ${metric(receipt.capture.firstFrameAfterMs, " ms")}`,
		`Last frame: ${metric(receipt.capture.lastFrameAt)}; after start: ${metric(receipt.capture.lastFrameAfterMs, " ms")}`,
		`Maximum frame gap: ${metric(receipt.capture.maxFrameGapMs, " ms")}; timestamp source: ${metric(receipt.capture.timestampSource)}`,
		`Written frames: ${metric(receipt.output.frames)}; Encoded frames: ${metric(receipt.output.encodedFrames)}`,
		`Held frames: ${metric(receipt.output.heldFrames)}; dropped frames: ${metric(receipt.output.droppedFrames)}; skipped frames: ${metric(receipt.output.skippedFrames)}`,
		`Nominal/output FPS: ${metric(receipt.output.fps)}; output duration (encoded frames/fps): ${metric(receipt.output.durationMs, " ms")}`,
		receipt.warning,
	].join("\n");
}
