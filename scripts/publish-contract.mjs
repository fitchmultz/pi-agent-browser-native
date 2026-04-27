/**
 * Purpose: Build the canonical npm publish contract for pi-agent-browser-native.
 * Responsibilities: Read package.json's files list, expand declared package file and directory entries into package-relative file paths, and expose shared required/forbidden release-gate rules.
 * Scope: Package contract data only; npm packing, CLI parsing, Pi smoke loading, and report printing stay in verify-package.mjs.
 * Usage: Import loadPublishContract from verifier scripts and tests that need the publish contract.
 * Invariants/Assumptions: package.json is the declarative npm publish surface, paths are POSIX-style package-relative paths, and this repository intentionally verifies the current explicit package layout rather than implementing a general npm-packlist clone.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

class PublishContractError extends Error {
	constructor(message) {
		super(message);
		this.name = "PublishContractError";
	}
}

export const REQUIRED_REPO_FILES = Object.freeze(["LICENSE"]);
export const FORBIDDEN_REPO_FILES = Object.freeze([".pi/extensions/agent-browser.ts"]);
export const FORBIDDEN_PACKED_FILES = Object.freeze([
	".pi/extensions/agent-browser.ts",
	"AGENTS.md",
	"docs/IMPLEMENTATION_PLAN.md",
	"docs/native-integration-design.md",
	"docs/v1-tool-contract.md",
	"progress.md",
	"scripts/verify-package.mjs",
	"test/agent-browser.test.ts",
	"test/verify-package.test.ts",
]);

const ALWAYS_INCLUDED_PACKED_FILES = Object.freeze(["package.json"]);

function toPackagePath(path) {
	return path.split(/[\\/]+/).filter(Boolean).join("/");
}

async function readPackageJson(cwd) {
	const rawPackageJson = await readFile(resolve(cwd, "package.json"), "utf8");
	return JSON.parse(rawPackageJson);
}

async function expandDeclaredPackageFile(cwd, declaredPath) {
	const normalizedPath = toPackagePath(declaredPath);
	const absolutePath = resolve(cwd, normalizedPath);
	let pathStat;
	try {
		pathStat = await stat(absolutePath);
	} catch (error) {
		throw new PublishContractError(
			`package.json files entry "${normalizedPath}" does not exist or cannot be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (pathStat.isFile()) return [normalizedPath];
	if (!pathStat.isDirectory()) return [];

	const entries = await readdir(absolutePath, { withFileTypes: true });
	const expandedPaths = [];
	for (const entry of entries) {
		const childPath = `${normalizedPath}/${entry.name}`;
		if (entry.isDirectory()) {
			expandedPaths.push(...(await expandDeclaredPackageFile(cwd, childPath)));
		} else if (entry.isFile()) {
			expandedPaths.push(toPackagePath(childPath));
		}
	}
	return expandedPaths;
}

export async function loadPublishContract(options = {}) {
	const cwd = options.cwd ?? process.cwd();
	const packageJson = await readPackageJson(cwd);
	const declaredPackageFiles = Array.isArray(packageJson.files) ? packageJson.files.map(toPackagePath) : [];
	const requiredPackedFiles = new Set(ALWAYS_INCLUDED_PACKED_FILES);

	for (const declaredPath of declaredPackageFiles) {
		for (const expandedPath of await expandDeclaredPackageFile(cwd, declaredPath)) {
			requiredPackedFiles.add(expandedPath);
		}
	}

	return Object.freeze({
		declaredPackageFiles: Object.freeze([...declaredPackageFiles].sort()),
		forbiddenPackedFiles: Object.freeze([...FORBIDDEN_PACKED_FILES].sort()),
		forbiddenRepoFiles: Object.freeze([...FORBIDDEN_REPO_FILES].sort()),
		requiredPackedFiles: Object.freeze([...requiredPackedFiles].sort()),
		requiredRepoFiles: Object.freeze([...REQUIRED_REPO_FILES].sort()),
	});
}
