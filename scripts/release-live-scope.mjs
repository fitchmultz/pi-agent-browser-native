/** Compare the actual published runtime before deciding whether model calls apply. */
import assert from "node:assert/strict";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

function normalize(value) {
	if (Array.isArray(value)) {
		return value.map(normalize);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, normalize(value[key])]),
		);
	}
	return value;
}

function runtimeManifest(manifest) {
	const fields = [
		"type",
		"main",
		"module",
		"exports",
		"imports",
		"bin",
		"engines",
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
		"peerDependenciesMeta",
		"bundledDependencies",
	];
	const resources = ["extensions", "skills", "prompts", "themes"];
	return normalize({
		...Object.fromEntries(fields.map((key) => [key, manifest[key]])),
		pi: Object.fromEntries(resources.map((key) => [key, manifest.pi?.[key]])),
	});
}

export function inspectLiveScope({ tarball, directory, env, common }) {
	const { readJson, run, sha256, writeJson } = common;
	const candidateDirectory = join(directory, "candidate");
	const baselineDirectory = join(directory, "published");
	for (const path of [candidateDirectory, baselineDirectory]) {
		mkdirSync(path, { recursive: true });
	}
	const extract = (archive, destination) =>
		run("tar", ["-xzf", archive, "-C", destination], { env, quiet: true });
	extract(tarball, candidateDirectory);
	const candidate = readJson(join(candidateDirectory, "package", "package.json"));
	const [published] = JSON.parse(
		run(
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
	const baseline = readJson(join(baselineDirectory, "package", "package.json"));
	assert.equal(baseline.version, published.version, "Published baseline version differs");
	const snapshot = (root) => {
		const files = {};
		const visit = (path) => {
			for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
				const relative = `${path}/${entry.name}`;
				if (entry.isDirectory()) {
					visit(relative);
				} else {
					files[relative] = sha256(join(root, relative));
				}
			}
		};
		visit("dist");
		files["package.json (runtime metadata)"] = JSON.stringify(
			runtimeManifest(readJson(join(root, "package.json"))),
		);
		return files;
	};
	const left = snapshot(join(baselineDirectory, "package"));
	const right = snapshot(join(candidateDirectory, "package"));
	const changedPaths = [...new Set([...Object.keys(left), ...Object.keys(right)])]
		.filter((path) => left[path] !== right[path])
		.sort();
	const report = {
		candidateVersion: candidate.version,
		candidateSha256: sha256(tarball),
		baselineVersion: baseline.version,
		baselineSha256: sha256(baselineTarball),
		required: changedPaths.length > 0,
		changedPaths,
		reason: changedPaths.length ? "Published runtime changed" : "Published runtime unchanged",
	};
	writeJson(join(directory, "report.json"), report);
	return report;
}
