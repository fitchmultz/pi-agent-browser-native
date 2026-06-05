#!/usr/bin/env node
import { spawnSync } from "node:child_process";

import { CAPABILITY_BASELINE } from "../agent-browser-capability-baseline.mjs";

const version = CAPABILITY_BASELINE.targetVersion;
const image = `pi-agent-browser-native-platform:node24-agent-browser${version}`;
const args = [
	"build",
	"-t",
	image,
	"--build-arg",
	`AGENT_BROWSER_VERSION=${version}`,
	"-f",
	"scripts/platform-smoke/linux-image/Dockerfile",
	".",
];

console.log(`Building ${image}`);
const result = spawnSync("docker", args, { stdio: "inherit" });
if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}
process.exit(result.status ?? 1);
