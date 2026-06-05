// Platform smoke configuration for pi-agent-browser-native.
// Crabbox owns the target lease/sync loop; this file is the project source of truth for release-blocking platform coverage.

import { CAPABILITY_BASELINE } from "./scripts/agent-browser-capability-baseline.mjs";

export const PLATFORM_SMOKE_AGENT_BROWSER_VERSION = CAPABILITY_BASELINE.targetVersion;
export const PLATFORM_SMOKE_UBUNTU_IMAGE = `pi-agent-browser-native-platform:node24-agent-browser${PLATFORM_SMOKE_AGENT_BROWSER_VERSION}`;

export default {
	packageName: "pi-agent-browser-native",
	artifactRoot: ".artifacts/platform-smoke",
	requiredTargets: ["macos", "ubuntu", "windows-native"],
	requiredSuites: ["platform-build", "browser-dogfood-smoke"],
	supportedTargets: ["macos", "ubuntu", "windows-native"],
	requiredCrabbox: {
		install: "Homebrew package or PLATFORM_SMOKE_CRABBOX override",
		minVersion: "0.26.0",
	},
	macos: {
		host: "localhost",
		port: 22,
	},
	ubuntuContainerImage: PLATFORM_SMOKE_UBUNTU_IMAGE,
	windowsParallels: {
		sourceVm: "pi-extension-windows-template",
		snapshot: "crabbox-ready",
	},
	nodeValidationMajor: 22,
	agentBrowserVersion: PLATFORM_SMOKE_AGENT_BROWSER_VERSION,
};
