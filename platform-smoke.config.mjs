// Platform smoke configuration for pi-agent-browser-native.
// Crabbox owns the target lease/sync loop; this file is the project source of truth for release-blocking platform coverage.

import { CAPABILITY_BASELINE } from "./scripts/agent-browser-capability-baseline.mjs";

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
	ubuntuContainerImage: "pi-agent-browser-native-platform:node24-agent-browser0.27.1",
	windowsParallels: {
		sourceVm: "pi-extension-windows-template",
		snapshot: "crabbox-ready",
	},
	nodeValidationMajor: 22,
	agentBrowserVersion: CAPABILITY_BASELINE.targetVersion,
};
