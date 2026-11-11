import { rm } from "node:fs/promises";
import { redactSensitiveText } from "../runtime.js";
import { runAgentBrowserProcess } from "../process.js";
import { getAgentBrowserProcessEnvironment } from "../process-environment.js";
import {
	MINIMUM_AGENT_BROWSER_VERSION,
	SUPPORTED_AGENT_BROWSER_VERSION_LABEL,
	TARGET_AGENT_BROWSER_VERSION,
	getAgentBrowserVersionValidationError,
	parseAgentBrowserVersionOutput,
} from "../upstream-version.js";
import type { AgentBrowserToolResult, AgentBrowserProcessResult } from "./browser-run/types.js";
import type { ValidatedUpstreamPaths } from "./extension-resource-contracts.js";

function unavailableProbe(probe: Readonly<AgentBrowserProcessResult>): boolean {
	const error = probe.spawnError;
	return (
		(error !== undefined && "code" in error && error.code === "ENOENT") ||
		probe.exitCode === 127 ||
		probe.aborted
	);
}

function probeVersion(probe: Readonly<AgentBrowserProcessResult>): {
	readonly error?: string | undefined;
	readonly observedVersion?: string | undefined;
} {
	if (probe.spawnError || probe.exitCode !== 0) {
		const stderr = probe.stderr.trim();
		const detail = redactSensitiveText(
			probe.spawnError?.message ?? (stderr !== "" ? stderr : `exit ${probe.exitCode}`),
		);
		return {
			error: `agent-browser --version could not be validated (${detail}). Run pi-agent-browser-doctor before browser-backed calls.`,
		};
	}
	return {
		observedVersion: parseAgentBrowserVersionOutput(probe.stdout),
		error: getAgentBrowserVersionValidationError(probe.stdout),
	};
}

export async function validateUpstreamVersion(
	cache: ValidatedUpstreamPaths,
	cwd: string,
	signal?: AbortSignal,
): Promise<AgentBrowserToolResult | undefined> {
	const env = getAgentBrowserProcessEnvironment();
	const key = `${cwd}\0${env.PATH ?? env.Path ?? ""}`;
	if (cache.has(key)) {
		return undefined;
	}
	const probe = await runAgentBrowserProcess({ args: ["--version"], cwd, signal, timeoutMs: 5000 });
	try {
		if (unavailableProbe(probe)) {
			return undefined;
		}
		const { error, observedVersion } = probeVersion(probe);
		if (error === undefined || error === "") {
			cache.add(key);
			return undefined;
		}
		return {
			content: [{ type: "text", text: error }],
			details: {
				expectedVersion: TARGET_AGENT_BROWSER_VERSION,
				failureCategory: "validation-error",
				observedVersion,
				resultCategory: "failure",
				minimumSupportedVersion: MINIMUM_AGENT_BROWSER_VERSION,
				versionValidation: {
					expected: SUPPORTED_AGENT_BROWSER_VERSION_LABEL,
					observed: observedVersion,
				},
			},
			isError: true,
		};
	} finally {
		if (probe.stdoutSpillPath !== undefined) {
			await rm(probe.stdoutSpillPath, { force: true }).catch(() => {
				// Temp-root cleanup owns leftovers; unlink failure must not mask validation.
			});
		}
	}
}
