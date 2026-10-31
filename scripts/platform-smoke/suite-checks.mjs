/** Platform and browser evidence predicates; no success is inferred from process exit alone. */
import { marker, platformFor, section } from "./suite-evidence.mjs";

export function nodeVersionAtLeast(actual, minimum) {
	return (
		/^v?\d+\.\d+\.\d+$/.test(actual) &&
		actual.replace(/^v/, "").localeCompare(minimum, undefined, { numeric: true }) >= 0
	);
}

export function commonChecks(result, secretViolations, stopResult) {
	return [
		{ id: "command-exit-zero", fn: () => result.code === 0, error: `exit ${result.code}` },
		{
			id: "no-secret-artifacts",
			fn: () => secretViolations.length === 0,
			error: secretViolations.join(", "),
		},
		...(stopResult
			? [
					{
						id: "lease-cleanup",
						fn: () => stopResult.code === 0,
						error: `stop exit ${stopResult.code}`,
					},
				]
			: []),
	];
}

export function platformBuildChecks(config, result, candidate) {
	const stdout = result.stdout;
	const listOutput = section(stdout, "PI_LIST_STDOUT");
	const nodeVersion = marker(stdout, "PLATFORM_NODE_VERSION");
	const packagePattern = config.packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return [
		{ id: "platform-marker", fn: () => stdout.includes("PLATFORM_BUILD_OK") },
		{
			id: "node-version",
			fn: () => nodeVersionAtLeast(nodeVersion, config.nodeValidationVersion),
			error: `Node ${nodeVersion || "unknown"} < ${config.nodeValidationVersion}`,
		},
		{ id: "npm-ci", fn: () => /PLATFORM_NPM_CI_EXIT=0/.test(stdout) },
		{ id: "npm-run-verify", fn: () => /PLATFORM_VERIFY_EXIT=0/.test(stdout) },
		{
			id: "npm-pack",
			fn: () =>
				/PLATFORM_NPM_PACK_EXIT=0/.test(stdout) &&
				marker(stdout, "PLATFORM_PACKED_TARBALL").length > 0,
		},
		...(candidate
			? [
					{
						id: "release-candidate-sha256",
						fn: () =>
							marker(stdout, "PLATFORM_CANDIDATE_SHA256_BEFORE") === candidate.sha256 &&
							marker(stdout, "PLATFORM_CANDIDATE_SHA256_AFTER") === candidate.sha256,
					},
				]
			: []),
		{ id: "packed-node-install", fn: () => /PLATFORM_PACKED_NODE_INSTALL_EXIT=0/.test(stdout) },
		{ id: "pi-install-local-package", fn: () => /PLATFORM_PI_INSTALL_EXIT=0/.test(stdout) },
		{
			id: "pi-list-local-package",
			fn: () =>
				/PLATFORM_PI_LIST_EXIT=0/.test(stdout) &&
				new RegExp(`Project packages:[\\s\\S]*${packagePattern}`).test(listOutput),
		},
		{
			id: "no-source-extension-shortcut",
			fn: () => !/\bpi\s+(?:-e|--extension)\s+\./.test(stdout),
		},
	];
}

export function browserDogfoodChecks(targetName, result, dogfoodReport) {
	const platform = platformFor(targetName);
	const reportIds = new Set((dogfoodReport.reports ?? []).map((report) => report.id));
	return [
		{
			id: "browser-dogfood-marker",
			fn: () => result.stdout.includes("PLATFORM_BROWSER_DOGFOOD_OK"),
		},
		{ id: "npm-ci", fn: () => /PLATFORM_NPM_CI_EXIT=0/.test(result.stdout) },
		{
			id: "agent-browser-baseline",
			fn: () => /PLATFORM_AGENT_BROWSER_READY_EXIT=0/.test(result.stdout),
		},
		{
			id: "agent-browser-browser-cache",
			fn: () =>
				platform !== "powershell" ||
				/PLATFORM_AGENT_BROWSER_BROWSER_CACHE_EXIT=0/.test(result.stdout),
		},
		{
			id: "agent-browser-prewarm",
			fn: () =>
				platform !== "powershell" || /PLATFORM_AGENT_BROWSER_PREWARM_EXIT=0/.test(result.stdout),
		},
		{ id: "dogfood-exit-zero", fn: () => /PLATFORM_DOGFOOD_EXIT=0/.test(result.stdout) },
		{
			id: "dogfood-report",
			fn: () => Array.isArray(dogfoodReport.reports) && dogfoodReport.reports.length >= 5,
		},
		{ id: "dogfood-qa", fn: () => reportIds.has("qa-url") },
		{ id: "dogfood-session-close", fn: () => reportIds.has("close-session") },
	];
}
