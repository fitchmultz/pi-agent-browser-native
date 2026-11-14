/**
 * Purpose: Build the canonical npm publish contract for pi-agent-browser-native.
 * Responsibilities: Read package.json's files list, expand declared package file and directory entries into package-relative file paths, and expose shared required/forbidden release-gate rules.
 * Scope: Package contract data only; npm packing, CLI parsing, Pi smoke loading, and report printing stay in verify-package.mjs.
 * Usage: Import loadPublishContract from verifier scripts and tests that need the publish contract.
 * Invariants/Assumptions: package.json is the declarative npm publish surface, paths are POSIX-style package-relative paths, and this repository intentionally verifies the current explicit package layout rather than implementing a general npm-packlist clone.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { isConfigObject } from "../extensions/agent-browser/lib/config-policy.js";

class PublishContractError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = "PublishContractError";
	}
}

export const REQUIRED_REPO_FILES = Object.freeze(["LICENSE"]);
export const FORBIDDEN_REPO_FILES = Object.freeze([".pi/extensions/agent-browser.ts"]);
export const FORBIDDEN_PACKED_FILES = Object.freeze([
	".artifacts/",
	".crabbox/",
	".debug/",
	".github/readme/",
	".platform-smoke-runs/",
	".env*",
	"**/*.tgz",
	".pi/extensions/agent-browser.ts",
	"dist/extensions/agent-browser/lib/",
	"AGENTS.md",
	"docs/plans/",
	"extensions/agent-browser/index.ts",
	"progress.md",
	"scripts/verify-package.mjs",
	"test/agent-browser.test.ts",
	"test/verify-package.test.ts",
]);

const ALWAYS_INCLUDED_PACKED_FILES = Object.freeze(["package.json"]);
const NPM_IGNORED_METADATA_FILES = new Set([".DS_Store"]);

/** @param {string} path */
function toPackagePath(path) {
	return path
		.split(/[\\/]+/)
		.filter(Boolean)
		.join("/");
}

/** @param {string} cwd */
export async function readPackageJson(cwd) {
	/** @type {unknown} */
	const parsed = JSON.parse(await readFile(resolve(cwd, "package.json"), "utf8"));
	if (!isConfigObject(parsed)) {
		throw new PublishContractError("package.json must contain an object.");
	}
	return parsed;
}

/** @param {string} cwd
 * @param {string} declaredPath
 * @returns {Promise<string[]>}
 */
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
	if (pathStat.isFile()) {
		return [normalizedPath];
	}
	if (!pathStat.isDirectory()) {
		return [];
	}

	const entries = await readdir(absolutePath, { recursive: true, withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && !NPM_IGNORED_METADATA_FILES.has(entry.name))
		.map((entry) => toPackagePath(relative(cwd, resolve(entry.parentPath, entry.name))));
}

/** @param {{ readonly cwd?: string }} [options] */
export async function loadPublishContract(options = {}) {
	const cwd = options.cwd ?? process.cwd();
	const packageJson = await readPackageJson(cwd);
	/** @type {unknown[]} */
	const files = Array.isArray(packageJson.files) ? packageJson.files : [];
	if (!files.every((path) => typeof path === "string")) {
		throw new PublishContractError("package.json files entries must be strings.");
	}
	const declaredPackageFiles = files.map(toPackagePath);
	const requiredPackedFiles = new Set(ALWAYS_INCLUDED_PACKED_FILES);

	for (const declaredPath of declaredPackageFiles) {
		// Expand each declared tree before the next to bound filesystem traversal resources.
		for (const expandedPath of await expandDeclaredPackageFile(cwd, declaredPath)) {
			requiredPackedFiles.add(expandedPath);
		}
	}

	return Object.freeze({
		declaredPackageFiles: Object.freeze(
			declaredPackageFiles.toSorted((left, right) => (left < right ? -1 : Number(left > right))),
		),
		forbiddenPackedFiles: Object.freeze(
			FORBIDDEN_PACKED_FILES.toSorted((left, right) => (left < right ? -1 : Number(left > right))),
		),
		forbiddenRepoFiles: Object.freeze(
			FORBIDDEN_REPO_FILES.toSorted((left, right) => (left < right ? -1 : Number(left > right))),
		),
		requiredPackedFiles: Object.freeze(
			[...requiredPackedFiles].sort((left, right) => (left < right ? -1 : Number(left > right))),
		),
		requiredRepoFiles: Object.freeze(
			REQUIRED_REPO_FILES.toSorted((left, right) => (left < right ? -1 : Number(left > right))),
		),
	});
}
