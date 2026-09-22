#!/usr/bin/env node
// Run the CI host contract against one complete, selected Pi dependency graph.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MINIMUM_PI_VERSION } from "./doctor.mjs";

const [flavor, mode, automationPath, forkPackages] = process.argv.slice(2);
assert.ok(["locked", "fork", "floor"].includes(flavor), "Host must be locked, fork, or floor");
assert.ok(["full", "smoke"].includes(mode), "Mode must be full or smoke");
assert.ok(automationPath, "Pass the pinned automation checkout");
assert.equal(Boolean(forkPackages), flavor === "fork", "Fork requires the built package directory");

const source = process.cwd();
const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
const candidate = manifest.devDependencies?.["@earendil-works/pi-coding-agent"];
assert.match(candidate, /^\d+\.\d+\.\d+$/, "Development Pi host must be an exact release");
if (flavor === "floor" && candidate === MINIMUM_PI_VERSION) {
	console.log(`Pi ${MINIMUM_PI_VERSION} is already the qualified candidate; no separate floor check.`);
	process.exit(0);
}

const automation = resolve(automationPath);
const { isolatedEnvironment } = await import(pathToFileURL(join(automation, "scripts/common.mjs")));
const { prepareHost, selectDevelopmentHost } = await import(pathToFileURL(join(automation, "scripts/hosts.mjs")));
const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "piab-ci-host-"));
const env = isolatedEnvironment(root);

function execute(command, args) {
	console.log(`$ ${command} ${args.join(" ")}`);
	const result = spawnSync(command, args, { cwd: source, env, stdio: "inherit" });
	if (result.error) throw result.error;
	assert.equal(result.status, 0, `${command} ${args.join(" ")} exited ${result.status ?? result.signal}`);
}

try {
	execute("npm", ["ci", "--ignore-scripts"]);
	let selected;
	if (flavor !== "locked") {
		const host = await prepareHost(join(root, "host"), flavor === "fork" ? "fork" : "official",
			flavor === "fork" ? resolve(forkPackages) : MINIMUM_PI_VERSION, env);
		selected = selectDevelopmentHost(source, host, env);
		console.log(JSON.stringify({ flavor, version: selected.version, sdkSha256: selected.indexSha256, cliSha256: selected.cliSha256 }));
		Object.assign(env, {
			PI_COMPAT_EXPECTED_PACKAGE_DIR: selected.packageDir,
			PI_PACKAGE_DIR: selected.packageDir,
			PI_HOST_INDEX: selected.index,
			PI_HOST_CLI: selected.cli,
		});
	}
	env.PI_COMPAT_HOST = flavor === "fork" ? "fork" : "official";
	env.PI_COMPAT_EXPECTED_VERSION = selected?.version ?? candidate;
	if (mode === "full") {
		execute("npm", ["run", "check:compat"]);
	} else {
		execute("npm", ["run", "typecheck"]);
		execute("node", ["scripts/verify-package.mjs", "--smoke-pi"]);
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}
