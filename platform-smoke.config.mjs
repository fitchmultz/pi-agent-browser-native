// Platform smoke configuration for pi-agent-browser-native.
// Crabbox owns the target lease/sync loop; this file is the project source of truth for release-blocking platform coverage.

import { CAPABILITY_BASELINE } from "./scripts/agent-browser-capability-baseline.mjs";

const PLATFORM_SMOKE_AGENT_BROWSER_VERSION = CAPABILITY_BASELINE.targetVersion;
const PLATFORM_SMOKE_UBUNTU_IMAGE = `pi-agent-browser-native-platform:node24-agent-browser${PLATFORM_SMOKE_AGENT_BROWSER_VERSION}`;

export default {
	packageName: "pi-agent-browser-native",
	artifactRoot: ".artifacts/platform-smoke",
	requiredTargets: ["macos", "ubuntu", "windows-native"],
	requiredSuites: ["platform-build", "browser-dogfood-smoke"],
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
		// Shared template snapshot with agent-browser 0.33.0 (+ Chrome 151 for the SSH user).
		// Parent crabbox-ready remains for other projects' linked clones.
		snapshot: "crabbox-ready-ab-0.33.0",
	},
	nodeValidationMajor: 22,
	agentBrowserVersion: PLATFORM_SMOKE_AGENT_BROWSER_VERSION,
};
