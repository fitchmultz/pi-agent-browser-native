/** Native behavior boundaries inside the supported agent-browser range, read from `--version` output. */
import assert from "node:assert/strict";

/**
 * Native `wait --download <path>` moves a locally launched browser's completed download to the
 * requested path starting with 0.39.4 (vercel-labs/agent-browser#2027). Supported 0.35.0–0.39.3
 * natives report the requested path without moving the file, so the wrapper must fail closed there.
 */
export function nativeWaitDownloadMovesFile(versionOutput: string): boolean {
	return nativeVersionAtLeast(versionOutput, 39, 4);
}

/**
 * Native 0.42.0 rejects a global flag inside a batch item's command, screenshot, snapshot, vitals,
 * or navigation slot (vercel-labs/agent-browser#2386). Supported 0.35.0–0.41.2 natives keep the
 * token as a literal operand.
 */
export function nativeRejectsBatchItemGlobalFlags(versionOutput: string): boolean {
	return nativeVersionAtLeast(versionOutput, 42, 0);
}

/**
 * Native 0.42.0 applies launch settings per command (vercel-labs/agent-browser#2396): a changed
 * launch setting relaunches a running session's browser, and a command that needs no browser, such
 * as an explicit-URL `read`, no longer launches one. Supported 0.35.0–0.41.2 natives send the whole
 * launch configuration before any command that carries a launch flag and never report a relaunch.
 */
export function nativeAppliesLaunchSettingsPerCommand(versionOutput: string): boolean {
	return nativeVersionAtLeast(versionOutput, 42, 0);
}

function nativeVersionAtLeast(
	versionOutput: string,
	minorFloor: number,
	patchFloor: number,
): boolean {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(versionOutput);
	assert.ok(match, `Unrecognized agent-browser version output: ${versionOutput}`);
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	return major > 0 || minor > minorFloor || (minor === minorFloor && patch >= patchFloor);
}
