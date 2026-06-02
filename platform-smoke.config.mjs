// Platform smoke configuration for pi-agent-browser-native.
// Crabbox owns the target lease/sync loop; this file is the project source of truth for release-blocking platform coverage.

import { CAPABILITY_BASELINE } from "./scripts/agent-browser-capability-baseline.mjs";

export default {
	packageName: "pi-agent-browser-native",
	artifactRoot: ".artifacts/platform-smoke",
	requiredTargets: ["macos", "ubuntu", "windows-native"],
	requiredSuites: ["platform-build", "browser-dogfood-smoke"],
	requiredCrabbox: {
		install: "Homebrew package or PLATFORM_SMOKE_CRABBOX override",
		minVersion: "0.24.0",
	},
	ubuntuContainerImage: "pi-agent-browser-native-platform:node24-agent-browser0.27.1",
	nodeValidationMajor: 22,
	agentBrowserVersion: CAPABILITY_BASELINE.targetVersion,
};
