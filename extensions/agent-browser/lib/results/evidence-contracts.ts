export interface ReadConfirmation {
	readonly capabilities?: { readonly readRequiresConfirmation: true };
	readonly id: string;
	readonly namespace?: string | undefined;
	readonly sessionName: string;
	readonly source: "native-explicit-url-read" | "native-guarded-action";
	readonly command?: string | undefined;
	readonly action?: string;
	readonly state: "pending" | "cleared";
	readonly refSnapshotFresh?: true;
}

export interface ActiveRecordingReservation {
	readonly absolutePath: string;
	readonly contactSheetPath?: string;
	readonly cwd: string;
	readonly namespace?: string | undefined;
	readonly path: string;
	readonly recordingId?: string | undefined;
	readonly startedAtMs?: number;
	readonly sessionName: string;
}

export interface RecordingRecovery {
	readonly attempt: {
		readonly success: false;
		readonly exitCode: number;
		readonly timedOut: boolean;
		readonly error: string;
		readonly parseError?: string | undefined;
	};
	readonly expected?: ActiveRecordingReservation | undefined;
	readonly healed: boolean;
	readonly namespace?: string | undefined;
	readonly receipt?: RecordingReceipt | undefined;
	readonly reason: string;
	readonly sessionName?: string | undefined;
	readonly source: "session-info";
	readonly status: "recovered" | "pending" | "failed" | "unverified" | "unavailable" | "mismatch";
}

export interface RecordingReceipt {
	readonly warning: string;
	readonly recordingId: string | null;
	readonly path: string;
	readonly success: boolean | null;
	readonly error: string | null;
	readonly frames: number | null;
	readonly capturedFrames: number | null;
	readonly fps: number | null;
	readonly capture: {
		readonly startedAt: string | null;
		readonly endedAt: string | null;
		readonly durationMs: number | null;
		readonly firstFrameAt: string | null;
		readonly lastFrameAt: string | null;
		readonly firstFrameAfterMs: number | null;
		readonly lastFrameAfterMs: number | null;
		readonly averageFps: number | null;
		readonly maxFrameGapMs: number | null;
		readonly timestampSource: string | null;
	};
	readonly output: {
		readonly frames: number | null;
		readonly fps: number | null;
		readonly encodedFrames: number | null;
		readonly durationMs: number | null;
		readonly durationSource: string | null;
		readonly heldFrames: number | null;
		readonly droppedFrames: number | null;
		readonly skippedFrames: number | null;
		readonly encoderSucceeded: boolean | null;
	};
	readonly file: { readonly exists: boolean | null; readonly sizeBytes: number | null };
}
