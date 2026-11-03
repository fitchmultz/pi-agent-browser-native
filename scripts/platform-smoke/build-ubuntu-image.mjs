#!/usr/bin/env node
import { spawnSync } from "node:child_process";

import { DEFAULT_UBUNTU_IMAGE } from "../../platform-smoke.config.mjs";
import { CAPABILITY_BASELINE } from "../agent-browser-capability-baseline.mjs";

const version = CAPABILITY_BASELINE.targetVersion;
const args = [
	"build",
	"-t",
	DEFAULT_UBUNTU_IMAGE,
	"--build-arg",
	`AGENT_BROWSER_VERSION=${version}`,
	"-f",
	"scripts/platform-smoke/linux-image/Dockerfile",
	".",
];

console.log(`Building ${DEFAULT_UBUNTU_IMAGE}`);
const result = spawnSync("docker", args, { stdio: "inherit" });
if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}
process.exit(result.status ?? 1);
