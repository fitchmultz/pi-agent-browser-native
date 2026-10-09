#!/usr/bin/env node
// Run the CI host contract against one complete, selected Pi dependency graph.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(
		"Usage: ci-host-compat.mjs official|fork full|smoke|install AUTOMATION_PATH [VERSION|FORK_PACKAGES]\nOfficial defaults to latest stable; CI passes its once-resolved version. Fork requires packed artifacts.\nExample: node scripts/ci-host-compat.mjs official full ../automation latest\nExit codes: 0 passed/help, 1 invalid input or verification failure.",
	);
	process.exit(0);
}
const [flavor, mode, automationPath, target] = process.argv.slice(2);
assert.ok(["official", "fork"].includes(flavor), "Host must be official or fork");
assert.ok(["full", "smoke", "install"].includes(mode), "Mode must be full, smoke, or install");
assert.ok(automationPath, "Pass the pinned automation checkout");
assert.ok(flavor !== "fork" || target, "Fork requires the built package directory");

const source = process.cwd();
const automation = resolve(automationPath);
const { isolatedEnvironment, writeJson } = await import(
	pathToFileURL(join(automation, "scripts/common.mjs"))
);
const { prepareHost, selectDevelopmentHost } = await import(
	pathToFileURL(join(automation, "scripts/hosts.mjs"))
);
// Install-mode links outlive this process; the caller owns their isolated source cleanup.
// Full/smoke test sockets retain the pinned qualifier's short temporary root.
const rootParent = mode === "install" ? join(source, ".artifacts") : "/tmp";
mkdirSync(rootParent, { recursive: true });
const root = mkdtempSync(join(rootParent, "pc-"));
const env = isolatedEnvironment(root);
let goRoot;
let retainInstalledHost = false;

function execute(command, args) {
	console.log(`$ ${command} ${args.join(" ")}`);
	const result = spawnSync(command, args, { cwd: source, env, stdio: "inherit" });
	if (result.error) {
		throw result.error;
	}
	assert.equal(
		result.status,
		0,
		`${command} ${args.join(" ")} exited ${result.status ?? result.signal}`,
	);
}

try {
	execute("npm", ["ci", "--ignore-scripts"]);
	const host = await prepareHost(
		join(root, "host"),
		flavor,
		flavor === "fork" ? resolve(target) : target || "latest",
		env,
	);
	const selected = selectDevelopmentHost(source, host, env);
	const receipt = { flavor, provenance: host.provenance, ...selected };
	console.log(JSON.stringify(receipt));
	const evidence = process.env.PI_COMPAT_EVIDENCE_DIR || join(source, ".artifacts", "ci-host");
	mkdirSync(evidence, { recursive: true });
	writeJson(join(evidence, "host.json"), receipt);
	Object.assign(env, {
		PI_COMPAT_HOST: flavor,
		PI_COMPAT_EXPECTED_VERSION: selected.version,
		PI_COMPAT_EXPECTED_PACKAGE_DIR: selected.packageDir,
		PI_PACKAGE_DIR: selected.packageDir,
		PI_HOST_INDEX: selected.index,
		PI_HOST_CLI: selected.cli,
	});
	if (mode === "full") {
		// Keep sockets short and large cold-compiler work/caches in owned workspace scratch.
		const cache = join(source, "node_modules", ".cache");
		mkdirSync(cache, { recursive: true });
		goRoot = mkdtempSync(join(cache, "pi-compat-go-"));
		for (const name of ["GOCACHE", "GOMODCACHE", "GOTMPDIR"]) {
			const directory = join(goRoot, name);
			mkdirSync(directory);
			env[name] = directory;
		}
		// This disposable module cache must remain removable by the owning unprivileged job.
		env.GOFLAGS = "-modcacherw";
		execute("npm", ["run", "check:compat"]);
	} else if (mode === "smoke") {
		execute("npm", ["run", "typecheck"]);
		execute("node", ["scripts/verify-package.mjs", "--smoke-pi"]);
	} else {
		retainInstalledHost = true;
	}
} finally {
	try {
		if (goRoot !== undefined) {
			rmSync(goRoot, { recursive: true, force: true });
		}
	} finally {
		if (!retainInstalledHost) {
			rmSync(root, { recursive: true, force: true });
		}
	}
}
