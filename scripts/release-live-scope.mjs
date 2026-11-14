/** Compare the published Pi agent runtime before deciding whether model calls apply. */
import assert from "node:assert/strict";
import { mkdirSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseSinglePackResult } from "./package-pack.mjs";
import { isConfigObject } from "../extensions/agent-browser/lib/config-policy.js";
import { Type } from "typebox";
import { Check } from "typebox/value";

/** @import { CommonAutomation } from "./automation-common.mjs" */
const packageIdentitySchema = Type.Object({ name: Type.String(), version: Type.String() });

/** @param {unknown} value
 * @returns {unknown}
 */
function normalize(value) {
	if (Array.isArray(value)) {
		return value.map(normalize);
	}
	if (isConfigObject(value)) {
		return Object.fromEntries(
			Object.keys(value)
				.sort((left, right) => (left < right ? -1 : Number(left > right)))
				.map((key) => [key, normalize(value[key])]),
		);
	}
	return value;
}

/** @param {unknown} manifest */
function runtimeManifest(manifest) {
	assert.ok(isConfigObject(manifest), "Runtime package metadata must be an object.");
	const fields = [
		"type",
		"main",
		"module",
		"exports",
		"imports",
		"engines",
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
		"peerDependenciesMeta",
		"bundledDependencies",
	];
	const resources = ["extensions", "skills", "prompts", "themes"];
	const pi = isConfigObject(manifest.pi) ? manifest.pi : {};
	return normalize({
		...Object.fromEntries(fields.map((key) => [key, manifest[key]])),
		pi: Object.fromEntries(resources.map((key) => [key, pi[key]])),
	});
}

/** @param {{readonly tarball: string; readonly directory: string; readonly env: Readonly<NodeJS.ProcessEnv>; readonly common: Readonly<CommonAutomation>}} options */
export function inspectLiveScope({ tarball, directory, env, common }) {
	const candidateDirectory = join(directory, "candidate");
	const baselineDirectory = join(directory, "published");
	for (const path of [candidateDirectory, baselineDirectory]) {
		mkdirSync(path, { recursive: true });
	}
	/** @param {string} archive
	 * @param {string} destination
	 */
	const extract = (archive, destination) =>
		common.run("tar", ["-xzf", archive, "-C", destination], { env, quiet: true });
	extract(tarball, candidateDirectory);
	const candidate = common.readJson(join(candidateDirectory, "package", "package.json"));
	assert.ok(
		Check(packageIdentitySchema, candidate),
		"Candidate package must declare name and version.",
	);
	const published = parseSinglePackResult(
		common.capture(
			"npm",
			[
				"pack",
				`${candidate.name}@latest`,
				"--ignore-scripts",
				"--json",
				"--registry=https://registry.npmjs.org/",
			],
			{ cwd: baselineDirectory, env, quiet: true },
		),
	);
	assert.equal(published.name, candidate.name, "Published baseline package differs");
	const baselineTarball = join(baselineDirectory, published.filename);
	extract(baselineTarball, baselineDirectory);
	const baseline = common.readJson(join(baselineDirectory, "package", "package.json"));
	assert.ok(
		Check(packageIdentitySchema, baseline),
		"Published package must declare name and version.",
	);
	assert.equal(baseline.version, published.version, "Published baseline version differs");
	/** @param {string} root */
	const snapshot = (root) => {
		/** @type {Record<string, string>} */
		const files = {};
		const distRoot = join(root, "dist");
		for (const entry of readdirSync(distRoot, { recursive: true, withFileTypes: true })) {
			if (!entry.isDirectory()) {
				const fullPath = resolve(entry.parentPath, entry.name);
				const relativePath = relative(root, fullPath).replaceAll("\\", "/");
				files[relativePath] = common.sha256(fullPath);
			}
		}
		files["package.json (runtime metadata)"] = JSON.stringify(
			runtimeManifest(common.readJson(join(root, "package.json"))),
		);
		return files;
	};
	const baselineFiles = snapshot(join(baselineDirectory, "package"));
	const candidateFiles = snapshot(join(candidateDirectory, "package"));
	const changedPaths = [...new Set([...Object.keys(baselineFiles), ...Object.keys(candidateFiles)])]
		.filter((path) => baselineFiles[path] !== candidateFiles[path])
		.sort((left, right) => (left < right ? -1 : Number(left > right)));
	const report = {
		candidateVersion: candidate.version,
		candidateSha256: common.sha256(tarball),
		baselineVersion: baseline.version,
		baselineSha256: common.sha256(baselineTarball),
		required: changedPaths.length > 0,
		changedPaths,
		reason:
			changedPaths.length > 0
				? "Published Pi agent runtime changed"
				: "Published Pi agent runtime unchanged",
	};
	common.writeJson(join(directory, "report.json"), report);
	return report;
}
