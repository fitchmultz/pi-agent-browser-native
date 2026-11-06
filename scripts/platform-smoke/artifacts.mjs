/** Artifact helpers for platform smoke suites. */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

/** @import { ProcessResult } from "./crabbox-runner.mjs" */
/** @typedef {Pick<ProcessResult, "code" | "signal"> & {readonly stdout?: ProcessResult["stdout"] | undefined; readonly stderr?: ProcessResult["stderr"] | undefined}} ProcessReceipt */

/** @param {string} artifactRoot
 * @param {string} runId
 * @param {string} targetName
 * @param {string} suiteName */
export function createSuiteDir(artifactRoot, runId, targetName, suiteName) {
	const dir = resolve(process.cwd(), artifactRoot, runId, targetName, suiteName);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** @param {string} dir
 * @param {string} command */
export function writeCommand(dir, command) {
	writeFileSync(resolve(dir, "command.txt"), `${command}\n`);
}

/** @param {string} dir
 * @param {ProcessReceipt["code"]} code
 * @param {ProcessReceipt["signal"]} signal */
export function writeExitCode(dir, code, signal) {
	writeFileSync(
		resolve(dir, "exit-code.txt"),
		`code=${String(code)}\nsignal=${signal ?? "none"}\n`,
	);
}

/** @param {string} dir
 * @param {Readonly<Record<string, unknown>>} data */
export function writeSummary(dir, data) {
	writeFileSync(
		resolve(dir, "summary.json"),
		JSON.stringify({ ...data, writtenAt: new Date().toISOString() }, null, 2),
	);
}

/** @param {string} dir
 * @param {readonly string[]} expectedFiles */
export function writeManifest(dir, expectedFiles) {
	/** @type {string[]} */
	const present = [];
	/** @param {string} current */
	function walk(current) {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = resolve(current, entry.name);
			if (entry.isDirectory()) {
				walk(path);
			} else if (entry.isFile()) {
				present.push(relative(dir, path));
			}
		}
	}
	if (existsSync(dir)) {
		walk(dir);
	}
	const allPresent = [...new Set([...present, "artifact-manifest.json"])].sort((left, right) =>
		left < right ? -1 : Number(left > right),
	);
	const manifest = {
		expected: expectedFiles,
		present: allPresent,
		missing: expectedFiles.filter((file) => !allPresent.includes(file)),
		writtenAt: new Date().toISOString(),
	};
	writeFileSync(resolve(dir, "artifact-manifest.json"), JSON.stringify(manifest, null, 2));
	return manifest;
}

/** @param {readonly string[]} envNames
 * @param {Readonly<NodeJS.ProcessEnv>} env */
export function collectSecretValues(envNames, env = process.env) {
	return [
		...new Set(
			envNames.flatMap((name) => {
				const value = env[name];
				return typeof value === "string" && value.length >= 8 ? [value] : [];
			}),
		),
	];
}

/** @param {string | null | undefined} text
 * @param {Iterable<string>} secretValues */
export function redactSecrets(text, secretValues = []) {
	let redacted = text ?? "";
	for (const secret of secretValues) {
		redacted = redacted.split(secret).join("[REDACTED_SECRET]");
	}
	return redacted;
}

/** @param {string | null | undefined} text
 * @param {Iterable<string>} secretValues */
export function scanForSecrets(text, secretValues = []) {
	const content = text ?? "";
	/** @type {string[]} */
	const violations = [];
	for (const secret of secretValues) {
		if (secret.length > 0 && content.includes(secret)) {
			violations.push("raw forwarded secret value");
		}
	}
	/** @type {readonly (readonly [RegExp, string])[]} */
	const patterns = [
		[/bearer\s+[A-Za-z0-9\-._~+/]{20,}=*/gi, "bearer token"],
		[/Authorization:\s*Bearer\s+[A-Za-z0-9\-._~+/]{20,}=*/gi, "authorization header"],
		[
			/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|cookie)\s*[:=]\s*["']?[A-Za-z0-9_./+\-=]{20,}/gi,
			"token-like field",
		],
	];
	for (const [pattern, label] of patterns) {
		if (pattern.test(content)) {
			violations.push(label);
		}
	}
	return [...new Set(violations)];
}

/** @param {string} dir
 * @param {Iterable<string>} secretValues */
export function scanArtifactTextFiles(dir, secretValues = []) {
	/** @type {{file: string, violation: string}[]} */
	const findings = [];
	/** @param {string} current */
	function walk(current) {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = resolve(current, entry.name);
			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			if (!entry.isFile()) {
				continue;
			}
			if (!/\.(?:txt|json|jsonl|md|log|ps1|mjs|js)$/i.test(entry.name)) {
				continue;
			}
			try {
				const text = readFileSync(path, "utf8");
				for (const violation of scanForSecrets(text, secretValues)) {
					findings.push({ file: relative(dir, path), violation });
				}
			} catch {
				// Ignore unreadable or non-text files.
			}
		}
	}
	walk(dir);
	return findings;
}
