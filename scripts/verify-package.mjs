/**
 * Purpose: Verify the published npm tarball shape and key repo release prerequisites for pi-agent-browser.
 * Responsibilities: Run `npm pack --json --dry-run`, validate required and forbidden repo and packed files, catch repo-local auto-discovery shims that would conflict with the installed package path, and print a concise release report.
 * Scope: Packaging and release verification only; code compilation/tests stay in the normal npm verify scripts.
 * Usage: Run with `node scripts/verify-package.mjs`, `npm run verify:package`, or `npm run verify:release`.
 * Invariants/Assumptions: The package is built directly from the current repo checkout, npm is available on PATH, and the package should publish only canonical docs plus the extension source and license.
 */

import { execFile as execFileCallback } from "node:child_process";
import { access } from "node:fs/promises";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const REQUIRED_REPO_FILES = ["LICENSE"];
const FORBIDDEN_REPO_FILES = [".pi/extensions/agent-browser.ts"];
const REQUIRED_PACKED_FILES = [
	"CHANGELOG.md",
	"LICENSE",
	"README.md",
	"docs/ARCHITECTURE.md",
	"docs/RELEASE.md",
	"docs/REQUIREMENTS.md",
	"docs/TOOL_CONTRACT.md",
	"extensions/agent-browser/index.ts",
	"extensions/agent-browser/lib/process.ts",
	"extensions/agent-browser/lib/results.ts",
	"extensions/agent-browser/lib/runtime.ts",
	"extensions/agent-browser/lib/temp.ts",
	"package.json",
];
const FORBIDDEN_PACKED_FILES = [
	".pi/extensions/agent-browser.ts",
	"AGENTS.md",
	"docs/IMPLEMENTATION_PLAN.md",
	"docs/native-integration-design.md",
	"docs/v1-tool-contract.md",
	"progress.md",
	"scripts/verify-package.mjs",
	"test/agent-browser.test.ts",
];

function printHelp() {
	console.log(`verify-package.mjs

Usage:
  node scripts/verify-package.mjs [options]

Options:
  --list-files   Print every packed file path after validation.
  -h, --help     Show this help text.

Checks:
  1. Required repo files exist and conflicting repo-local autoload shims are absent.
  2. npm pack --json --dry-run succeeds.
  3. Required published files are present.
  4. Development-only or superseded files are absent from the tarball.

Examples:
  npm run verify:package
  npm run verify:release
  node scripts/verify-package.mjs --list-files

Exit codes:
  0  Verification passed.
  1  Verification failed.
  2  Usage error.
`);
}

async function assertRepoFilesExist(paths) {
	const missingPaths = [];
	for (const path of paths) {
		try {
			await access(path);
		} catch {
			missingPaths.push(path);
		}
	}
	return missingPaths;
}

async function getDryRunPackResult() {
	const { stdout, stderr } = await execFile(npmCommand, ["pack", "--json", "--dry-run"], {
		cwd: process.cwd(),
		maxBuffer: 5 * 1024 * 1024,
	});

	const parsed = JSON.parse(stdout);
	if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== "object" || parsed[0] === null) {
		throw new Error(`Unexpected npm pack output.\nstdout:\n${stdout}\n\nstderr:\n${stderr}`);
	}

	return parsed[0];
}

function collectPaths(files) {
	return new Set(
		files
			.filter((entry) => typeof entry?.path === "string")
			.map((entry) => entry.path),
	);
}

function pluralize(count, singular, plural = `${singular}s`) {
	return count === 1 ? singular : plural;
}

async function main() {
	const args = new Set(process.argv.slice(2));
	if (args.has("-h") || args.has("--help")) {
		printHelp();
		return 0;
	}

	const supportedArgs = new Set(["--list-files"]);
	const unknownArgs = [...args].filter((arg) => !supportedArgs.has(arg));
	if (unknownArgs.length > 0) {
		console.error(`Unknown option${unknownArgs.length === 1 ? "" : "s"}: ${unknownArgs.join(", ")}`);
		console.error("Run with --help for usage.");
		return 2;
	}

	const missingRepoFiles = await assertRepoFilesExist(REQUIRED_REPO_FILES);
	const forbiddenRepoFiles = [];
	for (const path of FORBIDDEN_REPO_FILES) {
		try {
			await access(path);
			forbiddenRepoFiles.push(path);
		} catch {
			// expected: absent
		}
	}
	const packResult = await getDryRunPackResult();
	const packedPaths = collectPaths(Array.isArray(packResult.files) ? packResult.files : []);
	const missingPackedFiles = REQUIRED_PACKED_FILES.filter((path) => !packedPaths.has(path));
	const forbiddenPackedFiles = FORBIDDEN_PACKED_FILES.filter((path) => packedPaths.has(path));
	const failures = [];

	if (missingRepoFiles.length > 0) {
		failures.push(`Missing required repo file${missingRepoFiles.length === 1 ? "" : "s"}: ${missingRepoFiles.join(", ")}`);
	}
	if (forbiddenRepoFiles.length > 0) {
		failures.push(
			`Forbidden repo file${forbiddenRepoFiles.length === 1 ? "" : "s"} present: ${forbiddenRepoFiles.join(", ")}`,
		);
	}
	if (missingPackedFiles.length > 0) {
		failures.push(
			`Missing required packed file${missingPackedFiles.length === 1 ? "" : "s"}: ${missingPackedFiles.join(", ")}`,
		);
	}
	if (forbiddenPackedFiles.length > 0) {
		failures.push(
			`Forbidden packed file${forbiddenPackedFiles.length === 1 ? "" : "s"} present: ${forbiddenPackedFiles.join(", ")}`,
		);
	}

	console.log(`Tarball: ${packResult.filename}`);
	console.log(`Packed files: ${packResult.entryCount} ${pluralize(packResult.entryCount, "entry", "entries")}`);
	console.log(`Tarball size: ${packResult.size} bytes`);
	console.log(`Unpacked size: ${packResult.unpackedSize} bytes`);

	if (args.has("--list-files")) {
		console.log("Packed file list:");
		for (const path of [...packedPaths].sort()) {
			console.log(`- ${path}`);
		}
	}

	if (failures.length > 0) {
		console.error("Package verification failed:");
		for (const failure of failures) {
			console.error(`- ${failure}`);
		}
		return 1;
	}

	console.log("Package verification passed.");
	return 0;
}

main()
	.then((exitCode) => {
		process.exitCode = exitCode;
	})
	.catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
