#!/usr/bin/env node
// Run the CI host contract against one complete, selected Pi dependency graph.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MINIMUM_PI_VERSION } from "./doctor.mjs";

if (process.argv.slice(2).some(arg => arg === "-h" || arg === "--help")) {
	console.log(`Qualify one complete Pi dependency graph without changing source metadata.

Usage: node scripts/ci-host-compat.mjs <locked|fork|floor> <full|smoke> <automation-path> [fork-package-path]
  locked  Exact official development host from package-lock.json.
  fork    Genuine native packs with receipt.json in fork-package-path.
  floor   Minimum supported official Pi release.
  full    Build, types, full serial offline contracts and package/SDK/CLI smoke.
  smoke   Types and package/SDK/CLI smoke only.
Requires the packageManager npm version on PATH (or its native npm_execpath).

Examples:
  node scripts/ci-host-compat.mjs locked full ../automation
  node scripts/ci-host-compat.mjs fork full ../automation /path/to/fork-package
  node scripts/ci-host-compat.mjs floor smoke ../automation

Exit codes: 0 passed; 1 qualification or usage failure.`);
	process.exit(0);
}

const [flavor, mode, automationPath, forkPackages] = process.argv.slice(2);
assert.ok(["locked", "fork", "floor"].includes(flavor), "Host must be locked, fork, or floor");
assert.ok(["full", "smoke"].includes(mode), "Mode must be full or smoke");
assert.ok(automationPath, "Pass the pinned automation checkout");
assert.equal(Boolean(forkPackages), flavor === "fork", "Fork requires the built package directory");

const source = process.cwd();
const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
const candidate = manifest.devDependencies?.["@earendil-works/pi-coding-agent"];
assert.match(candidate, /^\d+\.\d+\.\d+$/, "Development Pi host must be an exact release");
// Resolve and verify the native npm CLI before HOME/PATH isolation, avoiding CMD shell transport.
let npmCli = process.env.npm_execpath;
if (!npmCli) {
	const launcher = execFileSync(process.platform === "win32" ? "where.exe" : "/usr/bin/which",
		[process.platform === "win32" ? "npm.cmd" : "npm"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
	const npmLauncher = realpathSync(launcher);
	npmCli = process.platform === "win32"
		? join(dirname(npmLauncher), "node_modules", "npm", "bin", "npm-cli.js")
		: npmLauncher;
}
const npmVersion = execFileSync(process.execPath, [npmCli, "--version"], { encoding: "utf8" }).trim();
assert.equal(`npm@${npmVersion}`, manifest.packageManager, "Use the package's declared native npm CLI");
if (flavor === "floor" && candidate === MINIMUM_PI_VERSION) {
	console.log(`Pi ${MINIMUM_PI_VERSION} is already the qualified candidate; no separate floor check.`);
	process.exit(0);
}

const automation = resolve(automationPath);
const { isolatedEnvironment } = await import(pathToFileURL(join(automation, "scripts/common.mjs")));
const { prepareHost, selectDevelopmentHost } = await import(pathToFileURL(join(automation, "scripts/hosts.mjs")));
// Nested test sockets need the same short temporary root as the pinned qualifier.
const root = mkdtempSync(join(process.platform === "darwin" ? "/private/var/tmp" : tmpdir(), "pc-"));
const env = isolatedEnvironment(root);

function execute(command, args) {
	const nativeArgs = command === "npm" ? [npmCli, ...args] : args;
	const nativeCommand = command === "npm" ? process.execPath : command;
	console.log(`$ ${nativeCommand} ${nativeArgs.join(" ")}`);
	const result = spawnSync(nativeCommand, nativeArgs, { cwd: source, env, stdio: "inherit" });
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
