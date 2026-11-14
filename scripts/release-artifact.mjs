#!/usr/bin/env node
/** Verify the candidate identity before and after each package-owned release gate. */
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { loadCommonAutomation } from "./automation-common.mjs";
import { preparedHostSchema } from "./automation-hosts.mjs";
import { isConfigObject } from "../extensions/agent-browser/lib/config-policy.js";

export const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** @satisfies {import("node:util").ParseArgsOptionsConfig} */
export const options = {
	artifact: { type: "string" },
	automation: { type: "string" },
	repository: { type: "string" },
	"source-ref": { type: "string" },
	"release-source": { type: "string" },
	"official-version": { type: "string" },
	"fork-ref": { type: "string" },
};

/** @typedef {ReturnType<typeof parseArgs<{options: typeof options}>>["values"]} CandidateValues */

// Shared npm-release.mjs:280-284 writes the complete native hosts and opaque extra receipt metadata.
const candidateSchema = Type.Object({
	repository: Type.String(),
	name: Type.String(),
	version: Type.String(),
	source: Type.String(),
	releaseSource: Type.String(),
	filename: Type.String(),
	sha256: Type.String(),
	hosts: Type.Object({
		official: preparedHostSchema,
		fork: Type.Intersect([
			preparedHostSchema,
			Type.Object({ provenance: Type.Object({ ref: Type.String() }) }),
		]),
	}),
});

/** @param {Readonly<CandidateValues>} values
 * @returns {asserts values is Required<Readonly<CandidateValues>>}
 */
function requireCandidateValues(values) {
	/** @type {Readonly<Record<string, string | undefined>>} */
	const entries = values;
	for (const key of Object.keys(options)) {
		const value = entries[key];
		assert.ok(value !== undefined && value.length > 0, `Missing --${key}`);
	}
}

/** @param {Readonly<CandidateValues>} values */
export async function inspectCandidate(values) {
	requireCandidateValues(values);
	const common = await loadCommonAutomation(values.automation);
	const candidate = common.readJson(join(resolve(values.artifact), "release.json"));
	assert.ok(
		Check(candidateSchema, candidate),
		"Candidate receipt is missing release or host identity fields.",
	);
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
		common.capture("git", ["rev-parse", "HEAD"], { cwd: source, quiet: true }).trim(),
		candidate.source,
	);
	assert.equal(
		common.capture("git", ["status", "--porcelain"], { cwd: source, quiet: true }).trim(),
		"",
		"Qualification source must be clean",
	);
	const manifest = common.readJson(join(source, "package.json"));
	assert.ok(isConfigObject(manifest));
	assert.equal(manifest.version, candidate.version);
	assert.equal(candidate.hosts.official.version, values["official-version"]);
	assert.equal(candidate.hosts.fork.provenance.ref, values["fork-ref"]);
	assert.equal(basename(candidate.filename), candidate.filename);
	const tarball = join(resolve(values.artifact), candidate.filename);
	assert.equal(
		common.sha256(tarball),
		candidate.sha256,
		"Candidate tarball differs from its receipt",
	);
	return { candidate, tarball, common, values };
}

if (import.meta.main) {
	const { values } = parseArgs({ options });
	const { candidate, tarball } = await inspectCandidate(values);
	console.log(`Retained ${candidate.name}@${candidate.version}, SHA-256 ${candidate.sha256}`);
	const githubEnv = process.env.GITHUB_ENV;
	if (githubEnv !== undefined && githubEnv.length > 0) {
		appendFileSync(githubEnv, `PI_AGENT_BROWSER_RELEASE_TARBALL=${tarball}\n`);
	}
}
