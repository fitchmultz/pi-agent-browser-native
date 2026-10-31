import { readFile } from "node:fs/promises";
import {
	fetchCdpJson,
	parseCdpTargets,
	parseCdpVersion,
	type ElectronCdpTarget,
	type ElectronCdpVersion,
} from "./cdp.js";
import { isRecord } from "../parsing.js";
import { stringifyUnknown } from "../results/text.js";
import type {
	ElectronDevToolsActivePortRead,
	ElectronLaunchFailureReason,
} from "./launch-types.js";

const POLL_INTERVAL_MS = 100;

// Re-read native cancellation after each await; TypeScript cannot model external AbortSignal writers.
export function isElectronLaunchAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted ?? false;
}

export function waitForElectronPoll(ms: number, signal?: AbortSignal): Promise<void> {
	if (isElectronLaunchAborted(signal)) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

function activePortReadError(error: unknown): string | undefined {
	const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
	return code !== undefined && code.length > 0 && code !== "ENOENT"
		? `${code}: ${error instanceof Error ? error.message : stringifyUnknown(error)}`
		: undefined;
}

async function readDevToolsActivePort(
	userDataDir: string,
): Promise<ElectronDevToolsActivePortRead> {
	const path = `${userDataDir}/DevToolsActivePort`;
	try {
		const text = await readFile(path, "utf8");
		const port = Number(text.split(/\r?\n/)[0].trim());
		const valid = Number.isSafeInteger(port) && port > 0 && port <= 65_535;
		return {
			found: true,
			path,
			port: valid ? port : undefined,
			...(valid ? {} : { error: "DevToolsActivePort did not contain a valid TCP port." }),
		};
	} catch (error) {
		return { error: activePortReadError(error), found: false, path };
	}
}

interface DevToolsPortResult {
	readonly devToolsActivePort?: ElectronDevToolsActivePortRead;
	readonly failure?: ElectronLaunchFailureReason;
	readonly port?: number;
	readonly spawnError?: Error;
}

export async function pollDevToolsActivePort(options: {
	readonly deadlineMs: number;
	readonly getChildExit: () => {
		readonly code: number | null;
		readonly signal: NodeJS.Signals | null;
	};
	readonly getSpawnError: () => Error | undefined;
	readonly signal?: AbortSignal;
	readonly userDataDir: string;
}): Promise<DevToolsPortResult> {
	let devToolsActivePort: ElectronDevToolsActivePortRead | undefined;
	while (performance.now() <= options.deadlineMs) {
		if (isElectronLaunchAborted(options.signal)) {
			return { devToolsActivePort, failure: "aborted" };
		}
		const spawnError = options.getSpawnError();
		if (spawnError !== undefined) {
			return { devToolsActivePort, failure: "spawn-error", spawnError };
		}
		// A newly written port file is observed between sleeps, within one launch deadline.
		// oxlint-disable-next-line no-await-in-loop
		devToolsActivePort = await readDevToolsActivePort(options.userDataDir);
		if (devToolsActivePort.port !== undefined) {
			return { devToolsActivePort, port: devToolsActivePort.port };
		}
		const exit = options.getChildExit();
		if (exit.code !== null || exit.signal !== null) {
			return {
				devToolsActivePort,
				failure: exit.code === 0 ? "single-instance-conflict" : "spawn-error",
			};
		}
		// Keep the next file observation after the polling delay; concurrent polls would race cleanup.
		// oxlint-disable-next-line no-await-in-loop
		await waitForElectronPoll(POLL_INTERVAL_MS, options.signal);
	}
	return { devToolsActivePort, failure: "timeout" };
}

export interface ElectronLaunchMetadata {
	readonly targets: readonly ElectronCdpTarget[];
	readonly version: ElectronCdpVersion;
}

export async function pollCdpMetadata(
	port: number,
	deadlineMs: number,
	signal?: AbortSignal,
): Promise<{ readonly aborted: boolean; readonly metadata?: ElectronLaunchMetadata }> {
	while (performance.now() <= deadlineMs) {
		if (isElectronLaunchAborted(signal)) {
			return { aborted: true };
		}
		// CDP readiness must be observed before targets can be read, within the same deadline.
		// oxlint-disable-next-line no-await-in-loop
		const versionData = await fetchCdpJson(`http://127.0.0.1:${port}/json/version`, signal);
		const version = parseCdpVersion(versionData);
		if (isElectronLaunchAborted(signal)) {
			return { aborted: true };
		}
		if (version !== undefined) {
			// Read targets only after version proves readiness; cancellation still wins after this await.
			// oxlint-disable-next-line no-await-in-loop
			const targetsData = await fetchCdpJson(`http://127.0.0.1:${port}/json/list`, signal);
			const targets = parseCdpTargets(targetsData);
			return isElectronLaunchAborted(signal)
				? { aborted: true }
				: { aborted: false, metadata: { targets, version } };
		}
		// Each failed readiness probe waits before the next attempt.
		// oxlint-disable-next-line no-await-in-loop
		await waitForElectronPoll(POLL_INTERVAL_MS, signal);
	}
	return { aborted: false };
}
