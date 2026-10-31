#!/usr/bin/env node
/** Verify the candidate identity before and after each package-owned release gate. */
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const options = {
	artifact: { type: "string" },
	automation: { type: "string" },
	repository: { type: "string" },
	"source-ref": { type: "string" },
	"release-source": { type: "string" },
	"official-version": { type: "string" },
	"fork-ref": { type: "string" },
};

export async function inspectCandidate(values) {
	for (const key of Object.keys(options)) {
		assert.ok(values[key], `Missing --${key}`);
	}
	const common = await import(
		pathToFileURL(join(resolve(values.automation), "scripts/common.mjs"))
	);
	const { readJson, run, sha256 } = common;
	const candidate = readJson(join(resolve(values.artifact), "release.json"));
	assert.equal(
		candidate.repository,
		values.repository,
		"Candidate repository differs from the caller",
	);
	assert.equal(candidate.name, "pi-agent-browser-native");
	assert.equal(candidate.source, values["source-ref"], "Candidate source differs from the plan");
	assert.equal(
		candidate.releaseSource,
		values["release-source"],
		"Candidate queue source differs from the plan",
	);
	assert.equal(
		run("git", ["rev-parse", "HEAD"], { cwd: source, quiet: true }).trim(),
		candidate.source,
	);
	assert.equal(
		run("git", ["status", "--porcelain"], { cwd: source, quiet: true }).trim(),
		"",
		"Qualification source must be clean",
	);
	assert.equal(readJson(join(source, "package.json")).version, candidate.version);
	assert.equal(candidate.hosts.official.version, values["official-version"]);
	assert.equal(candidate.hosts.fork.provenance.ref, values["fork-ref"]);
	assert.equal(basename(candidate.filename), candidate.filename);
	const tarball = join(resolve(values.artifact), candidate.filename);
	assert.equal(sha256(tarball), candidate.sha256, "Candidate tarball differs from its receipt");
	return { candidate, tarball, common };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const { values } = parseArgs({ options });
	const { candidate, tarball } = await inspectCandidate(values);
	console.log(`Retained ${candidate.name}@${candidate.version}, SHA-256 ${candidate.sha256}`);
	if (process.env.GITHUB_ENV) {
		appendFileSync(process.env.GITHUB_ENV, `PI_AGENT_BROWSER_RELEASE_TARBALL=${tarball}\n`);
	}
}
