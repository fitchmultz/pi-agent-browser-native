// Platform smoke configuration for pi-agent-browser-native.
// Crabbox owns the target lease/sync loop; this file is the project source of truth for required and explicitly selected best-effort platform coverage.

import { CAPABILITY_BASELINE } from "./scripts/agent-browser-capability-baseline.mjs";

/**
 * @typedef {{
 *   readonly packageName: string;
 *   readonly artifactRoot: string;
 *   readonly requiredTargets: readonly string[];
 *   readonly optionalTargets?: readonly string[];
 *   readonly requiredSuites: readonly string[];
 *   readonly requiredCrabbox?: { readonly install?: string; readonly minVersion?: string };
 *   readonly macos?: { readonly host?: string; readonly port?: string | number; readonly workRoot?: string };
 *   readonly ubuntuContainerImage?: string;
 *   readonly localContainer?: { readonly workRoot?: string };
 *   readonly windowsParallels?: { readonly sourceVm?: string; readonly snapshot?: string; readonly user?: string; readonly workRoot?: string };
 *   readonly nodeValidationVersion: string;
 *   readonly agentBrowserVersion: string;
 *   readonly defaultAuthEnv?: readonly string[];
 * }} PlatformSmokeConfig
 */

const PLATFORM_SMOKE_AGENT_BROWSER_VERSION = CAPABILITY_BASELINE.targetVersion;
export const DEFAULT_UBUNTU_IMAGE = `pi-agent-browser-native-platform:node24-agent-browser${PLATFORM_SMOKE_AGENT_BROWSER_VERSION}`;

/** @satisfies {PlatformSmokeConfig} */
const config = {
	packageName: "pi-agent-browser-native",
	artifactRoot: ".artifacts/platform-smoke",
	requiredTargets: ["macos", "ubuntu"],
	optionalTargets: ["windows-native"],
	requiredSuites: ["platform-build", "browser-dogfood-smoke"],
	requiredCrabbox: {
		install: "Homebrew package or PLATFORM_SMOKE_CRABBOX override",
		minVersion: "0.26.0",
	},
	macos: {
		host: "localhost",
		port: 22,
	},
	ubuntuContainerImage: DEFAULT_UBUNTU_IMAGE,
	windowsParallels: {
		sourceVm: "pi-extension-windows-template",
		// Shared template snapshot; refresh when the Windows image moves past agent-browser 0.34.0.
		// Parent crabbox-ready remains for other projects' linked clones.
		snapshot: "crabbox-ready-ab-0.34.0-d",
	},
	nodeValidationVersion: "24.22.3",
	agentBrowserVersion: PLATFORM_SMOKE_AGENT_BROWSER_VERSION,
};

export default config;
