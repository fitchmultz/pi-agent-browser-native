#!/usr/bin/env node
/** Qualify one retained browser package with one selected Pi host. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { inspectCandidate, options, source } from "./release-artifact.mjs";
import { inspectLiveScope } from "./release-live-scope.mjs";
import { loadHostAutomation } from "./automation-hosts.mjs";

const { values } = parseArgs({
	options: {
		...options,
		"fork-artifact": { type: "string" },
		host: { type: "string" },
		output: { type: "string" },
	},
});
const forkArtifact = values["fork-artifact"];
assert.ok(forkArtifact !== undefined && forkArtifact.length > 0, "Missing --fork-artifact");
const hostFlavor = values.host;
assert.ok(hostFlavor !== undefined && hostFlavor.length > 0, "Missing --host");
const outputPath = values.output;
assert.ok(outputPath !== undefined && outputPath.length > 0, "Missing --output");
assert.ok(hostFlavor === "official" || hostFlavor === "fork", "Host must be official or fork");

const output = resolve(outputPath);
const { candidate, tarball, common, values: candidateValues } = await inspectCandidate(values);
const hosts = await loadHostAutomation(candidateValues.automation);

const env = common.isolatedEnvironment(join(output, "isolation"));
const host = await hosts.prepareHost(
	join(output, "host"),
	hostFlavor,
	hostFlavor === "official" ? candidateValues["official-version"] : resolve(forkArtifact),
	env,
);
const expected = candidate.hosts[hostFlavor];
for (const key of /** @type {const} */ ([
	"version",
	"indexSha256",
	"cliSha256",
	"runtimeLockSha256",
	"runtimeGraphSha256",
])) {
	assert.equal(
		host[key],
		expected[key],
		`${hostFlavor} host ${key} differs from candidate preparation`,
	);
}
assert.deepEqual(host.cohort, expected.cohort, `${hostFlavor} host Pi cohort differs`);
assert.deepEqual(host.companions, expected.companions, `${hostFlavor} host companions differ`);
const selected = hosts.selectDevelopmentHost(source, host, env);
const bin = join(output, "bin");
mkdirSync(bin, { recursive: true });
/** @param {string} value */
const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
writeFileSync(
	join(bin, "pi"),
	`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(selected.cli)} "$@"\n`,
	{ mode: 0o700 },
);
const model = "zai/glm-5.3-flash";
const runtime = {
	...env,
	PATH: `${bin}:${env.PATH}`,
	PI_COMPAT_HOST: hostFlavor,
	PI_COMPAT_EXPECTED_VERSION: host.version,
	PI_COMPAT_EXPECTED_PACKAGE_DIR: selected.packageDir,
	PI_HOST_INDEX: selected.index,
	PI_HOST_CLI: selected.cli,
	PI_AGENT_BROWSER_RELEASE_TARBALL: tarball,
};
/** @param {string} command
 * @param {readonly string[]} args
 * @param {Readonly<NodeJS.ProcessEnv>} [environment]
 */
const execute = (command, args, environment = runtime) =>
	common.run(command, args, {
		cwd: source,
		env: environment,
		timeout: undefined,
		stdio: "inherit",
	});
execute("npm", ["run", "verify", "--", "package-pi"]);
const liveScope = inspectLiveScope({
	tarball,
	directory: join(output, "live-scope"),
	env,
	common,
});
if (liveScope.required) {
	const apiKey = process.env.ZAI_API_KEY;
	assert.ok(
		apiKey !== undefined && apiKey.length > 0,
		"The live qualification model credential is missing",
	);
	const lifecycle = { ...runtime, ZAI_API_KEY: apiKey };
	const executablePath = process.env.AGENT_BROWSER_EXECUTABLE_PATH;
	const live = {
		...lifecycle,
		PIAB_LIVE_MODEL: model,
		PIAB_LIVE_OUTPUT: join(output, "live-sites"),
		...(executablePath !== undefined && executablePath.length > 0
			? { AGENT_BROWSER_EXECUTABLE_PATH: executablePath }
			: {}),
	};
	execute("npm", ["run", "verify", "--", "lifecycle", "--model", model, "--verbose"], lifecycle);
	execute(process.execPath, ["scripts/verify-live-sites.mjs"], live);
}
assert.equal(
	common.sha256(tarball),
	candidate.sha256,
	"Candidate tarball changed during qualification",
);
assert.equal(
	hosts.hostIdentity(host.directory, env).runtimeGraphSha256,
	host.runtimeGraphSha256,
	"Selected host graph changed during qualification",
);
await inspectCandidate(values);
common.writeJson(join(output, "report.json"), {
	source: candidate.source,
	releaseSource: candidate.releaseSource,
	candidateSha256: candidate.sha256,
	candidateVersion: candidate.version,
	host: hostFlavor,
	hostVersion: host.version,
	indexSha256: host.indexSha256,
	cliSha256: host.cliSha256,
	runtimeLockSha256: host.runtimeLockSha256,
	runtimeGraphSha256: host.runtimeGraphSha256,
	live: { ...liveScope, status: liveScope.required ? "passed" : "not_required" },
});
