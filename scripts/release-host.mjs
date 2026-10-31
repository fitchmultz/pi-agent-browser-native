#!/usr/bin/env node
/** Qualify one retained browser package with one selected Pi host. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { inspectCandidate, options, source } from "./release-artifact.mjs";

const { values } = parseArgs({
	options: {
		...options,
		"fork-artifact": { type: "string" },
		host: { type: "string" },
		output: { type: "string" },
	},
});
for (const key of ["fork-artifact", "host", "output"]) {
	assert.ok(values[key], `Missing --${key}`);
}
assert.ok(["official", "fork"].includes(values.host), "Host must be official or fork");
assert.ok(process.env.OPENROUTER_API_KEY, "The live qualification model credential is missing");

const output = resolve(values.output);
const { candidate, tarball, common } = await inspectCandidate(values);
const { isolatedEnvironment, run, sha256, writeJson } = common;
const { hostIdentity, prepareHost, selectDevelopmentHost } = await import(
	pathToFileURL(join(resolve(values.automation), "scripts/hosts.mjs"))
);

const env = isolatedEnvironment(join(output, "isolation"));
const host = await prepareHost(
	join(output, "host"),
	values.host,
	values.host === "official" ? values["official-version"] : resolve(values["fork-artifact"]),
	env,
);
const expected = candidate.hosts[values.host];
for (const key of [
	"version",
	"indexSha256",
	"cliSha256",
	"runtimeLockSha256",
	"runtimeGraphSha256",
]) {
	assert.equal(
		host[key],
		expected[key],
		`${values.host} host ${key} differs from candidate preparation`,
	);
}
assert.deepEqual(host.cohort, expected.cohort, `${values.host} host Pi cohort differs`);
assert.deepEqual(host.companions, expected.companions, `${values.host} host companions differ`);
const selected = selectDevelopmentHost(source, host, env);
const bin = join(output, "bin");
mkdirSync(bin, { recursive: true });
const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
writeFileSync(
	join(bin, "pi"),
	`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(selected.cli)} "$@"\n`,
	{ mode: 0o700 },
);
const model = "openrouter/openai/gpt-5.5:minimal";
const runtime = {
	...env,
	PATH: `${bin}:${env.PATH}`,
	PI_COMPAT_HOST: values.host,
	PI_COMPAT_EXPECTED_VERSION: host.version,
	PI_COMPAT_EXPECTED_PACKAGE_DIR: selected.packageDir,
	PI_HOST_INDEX: selected.index,
	PI_HOST_CLI: selected.cli,
	PI_AGENT_BROWSER_RELEASE_TARBALL: tarball,
	...(process.env.AGENT_BROWSER_EXECUTABLE_PATH
		? { AGENT_BROWSER_EXECUTABLE_PATH: process.env.AGENT_BROWSER_EXECUTABLE_PATH }
		: {}),
};
const live = {
	...runtime,
	OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
	PIAB_LIVE_MODEL: model,
	PIAB_LIVE_OUTPUT: join(output, "live-sites"),
};
const execute = (command, args, environment = runtime) =>
	run(command, args, { cwd: source, env: environment, timeout: undefined, stdio: "inherit" });
execute("npm", ["run", "verify"]);
execute("npm", ["run", "verify", "--", "package-pi"]);
execute("npm", ["run", "verify", "--", "lifecycle", "--model", model, "--verbose"], live);
execute(process.execPath, ["scripts/verify-live-sites.mjs"], live);
assert.equal(sha256(tarball), candidate.sha256, "Candidate tarball changed during qualification");
assert.equal(
	hostIdentity(host.directory, env).runtimeGraphSha256,
	host.runtimeGraphSha256,
	"Selected host graph changed during qualification",
);
await inspectCandidate(values);
writeJson(join(output, "report.json"), {
	source: candidate.source,
	releaseSource: candidate.releaseSource,
	candidateSha256: candidate.sha256,
	candidateVersion: candidate.version,
	host: values.host,
	hostVersion: host.version,
	indexSha256: host.indexSha256,
	cliSha256: host.cliSha256,
	runtimeLockSha256: host.runtimeLockSha256,
	runtimeGraphSha256: host.runtimeGraphSha256,
});
