/** Artifact helpers for platform smoke suites. */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export function createSuiteDir(artifactRoot, runId, targetName, suiteName) {
	const dir = resolve(process.cwd(), artifactRoot, runId, targetName, suiteName);
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function writeCommand(dir, command) {
	writeFileSync(resolve(dir, "command.txt"), `${command}\n`);
}

export function writeExitCode(dir, code, signal) {
	writeFileSync(resolve(dir, "exit-code.txt"), `code=${code}\nsignal=${signal ?? "none"}\n`);
}

export function writeSummary(dir, data) {
	writeFileSync(resolve(dir, "summary.json"), JSON.stringify({ ...data, writtenAt: new Date().toISOString() }, null, 2));
}

export function writeManifest(dir, expectedFiles) {
	const present = [];
	function walk(current) {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = resolve(current, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) present.push(relative(dir, path));
		}
	}
	if (existsSync(dir)) walk(dir);
	const allPresent = [...new Set([...present, "artifact-manifest.json"])].sort();
	const manifest = {
		expected: expectedFiles,
		present: allPresent,
		missing: expectedFiles.filter((file) => !allPresent.includes(file)),
		writtenAt: new Date().toISOString(),
	};
	writeFileSync(resolve(dir, "artifact-manifest.json"), JSON.stringify(manifest, null, 2));
	return manifest;
}

export function collectSecretValues(envNames, env = process.env) {
	return [...new Set(envNames.map((name) => env[name]).filter((value) => typeof value === "string" && value.length >= 8))];
}

export function redactSecrets(text, secretValues = []) {
	let redacted = String(text ?? "");
	for (const secret of secretValues) {
		redacted = redacted.split(secret).join("[REDACTED_SECRET]");
	}
	return redacted;
}

export function scanForSecrets(text, secretValues = []) {
	const content = String(text ?? "");
	const violations = [];
	for (const secret of secretValues) {
		if (secret && content.includes(secret)) violations.push("raw forwarded secret value");
	}
	for (const [pattern, label] of [
		[/bearer\s+[A-Za-z0-9\-._~+/]{20,}=*/gi, "bearer token"],
		[/Authorization:\s*Bearer\s+[A-Za-z0-9\-._~+/]{20,}=*/gi, "authorization header"],
		[/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|cookie)\s*[:=]\s*["']?[A-Za-z0-9_./+\-=]{20,}/gi, "token-like field"],
	]) {
		if (pattern.test(content)) violations.push(label);
	}
	return [...new Set(violations)];
}

export function scanArtifactTextFiles(dir, secretValues = []) {
	const findings = [];
	function walk(current) {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = resolve(current, entry.name);
			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!/\.(?:txt|json|jsonl|md|log|ps1|mjs|js)$/i.test(entry.name)) continue;
			try {
				const text = readFileSync(path, "utf8");
				for (const violation of scanForSecrets(text, secretValues)) findings.push({ file: relative(dir, path), violation });
			} catch {
				// Ignore unreadable or non-text files.
			}
		}
	}
	walk(dir);
	return findings;
}
