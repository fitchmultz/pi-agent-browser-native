/**
 * Purpose: Verify the published npm tarball shape, package-path Pi loadability, and key repo release prerequisites for pi-agent-browser.
 * Responsibilities: Parse CLI options, run `npm pack`, validate required and forbidden repo and packed files, catch repo-local auto-discovery shims, smoke-load and deterministically smoke-execute the packed package in an isolated Pi resource loader when requested, and print concise release reports.
 * Scope: Packaging and release verification only; code compilation/tests stay in the normal npm verify scripts.
 * Usage: Run with `node scripts/verify-package.mjs`, `node scripts/verify-package.mjs --smoke-pi`, `npm run verify -- package`, `npm run verify -- package-pi`, or `npm run verify -- release`.
 * Invariants/Assumptions: The package is built directly from the current repo checkout, npm and tar are available on PATH, installed Pi SDK APIs match the current dev dependency, and the package should publish only canonical docs plus the extension source and license.
 */

import { access, readFile } from "node:fs/promises";

import { posix as posixPath, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { getDryRunPackResult } from "./package-pack.mjs";
import { verifyPackagedPiLoad } from "./package-pi.mjs";
export { packToTemporaryPackageDir } from "./package-pack.mjs";
export {
	evaluatePiSmokeResult,
	executePackagedAgentBrowserSmoke,
	verifyPackagedPiLoad,
} from "./package-pi.mjs";
import {
	FORBIDDEN_PACKED_FILES,
	FORBIDDEN_REPO_FILES,
	REQUIRED_REPO_FILES,
	loadPublishContract,
} from "./publish-contract.mjs";

export { FORBIDDEN_PACKED_FILES, FORBIDDEN_REPO_FILES, REQUIRED_REPO_FILES, loadPublishContract };

const SUPPORTED_ARGS = new Set(["--list-files", "--smoke-pi"]);

class UsageError extends Error {
	constructor(message) {
		super(message);
		this.name = "UsageError";
	}
}

function printHelp() {
	console.log(`verify-package.mjs

Usage:
  node scripts/verify-package.mjs [options]

Options:
  --list-files   Print every packed file path after validation.
  --smoke-pi     Pack and extract the package, verify Pi can load exactly one
                 agent_browser tool from that package in isolation after installing
                 runtime dependencies (no lifecycle scripts), and execute a
                 deterministic fake-binary-backed agent_browser --version smoke.
  -h, --help     Show this help text.

Checks:
  1. Required repo files exist and conflicting repo-local autoload shims are absent.
  2. npm pack --json --dry-run succeeds.
  3. Required published files are present.
  4. Development-only or superseded files are absent from the tarball.
  5. With --smoke-pi, the packed package load path registers exactly one
     agent_browser tool whose source resolves inside the extracted package.
  6. With --smoke-pi, that packaged tool executes through Pi's native tool
     handler using a temporary fake agent-browser --version binary.

Examples:
  npm run verify -- package
  npm run verify -- package-pi
  npm run verify -- release
  node scripts/verify-package.mjs --list-files
  node scripts/verify-package.mjs --smoke-pi

Exit codes:
  0  Verification passed.
  1  Verification failed.
  2  Usage error.
`);
}

export function parseCliArgs(argv = process.argv.slice(2)) {
	const args = new Set(argv);
	if (args.has("-h") || args.has("--help")) {
		return { listFiles: false, showHelp: true, smokePi: false };
	}

	const unknownArgs = [...args].filter((arg) => !SUPPORTED_ARGS.has(arg));
	if (unknownArgs.length > 0) {
		throw new UsageError(
			`Unknown option${unknownArgs.length === 1 ? "" : "s"}: ${unknownArgs.join(", ")}`,
		);
	}

	return {
		listFiles: args.has("--list-files"),
		showHelp: false,
		smokePi: args.has("--smoke-pi"),
	};
}

async function collectMissingPaths(paths, cwd = process.cwd()) {
	const missingPaths = [];
	for (const path of paths) {
		try {
			// Bound stat pressure and preserve path-order diagnostics during package prerequisite inspection.
			// oxlint-disable-next-line no-await-in-loop
			await access(resolve(cwd, path));
		} catch {
			missingPaths.push(path);
		}
	}
	return missingPaths;
}

async function collectPresentPaths(paths, cwd = process.cwd()) {
	const presentPaths = [];
	for (const path of paths) {
		try {
			// Bound stat pressure and preserve path-order diagnostics during package prerequisite inspection.
			// oxlint-disable-next-line no-await-in-loop
			await access(resolve(cwd, path));
			presentPaths.push(path);
		} catch {
			// expected: absent
		}
	}
	return presentPaths;
}

export function collectPackedPaths(files) {
	return new Set(
		files.filter((entry) => typeof entry?.path === "string").map((entry) => entry.path),
	);
}

const MARKDOWN_LINK_PATTERN = /!?\[[^\]\n]*(?:\][^[\]\n]*)*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const EXTERNAL_LINK_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

function stripMarkdownLinkFragment(target) {
	const hashIndex = target.indexOf("#");
	return hashIndex >= 0 ? target.slice(0, hashIndex) : target;
}

function normalizePackedMarkdownTarget(sourcePath, rawTarget) {
	const withoutFragment = stripMarkdownLinkFragment(rawTarget.trim());
	if (!withoutFragment || withoutFragment.startsWith("#")) {
		return;
	}
	if (
		withoutFragment.startsWith("//") ||
		withoutFragment.startsWith("/") ||
		EXTERNAL_LINK_PATTERN.test(withoutFragment)
	) {
		return;
	}
	let decoded = withoutFragment;
	try {
		decoded = decodeURI(withoutFragment);
	} catch {
		// Keep the raw target when it is not URI-encoded cleanly; the normalized lookup will fail if absent.
	}
	return posixPath.normalize(posixPath.join(posixPath.dirname(sourcePath), decoded));
}

function packedPathExists(packedPaths, targetPath) {
	if (packedPaths.has(targetPath)) {
		return true;
	}
	const directoryPrefix = targetPath.endsWith("/") ? targetPath : `${targetPath}/`;
	for (const packedPath of packedPaths) {
		if (packedPath.startsWith(directoryPrefix)) {
			return true;
		}
	}
	return false;
}

function isRepositoryReadmeArtwork(sourcePath, markdownLink, targetPath) {
	return (
		sourcePath === "README.md" &&
		markdownLink.startsWith("![") &&
		/^\.github\/readme\/[^/]+\.png$/.test(targetPath)
	);
}

export async function collectPackedMarkdownLinkFailures(options) {
	const { cwd = process.cwd(), packedPaths } = options;
	const failures = [];
	const repositoryArtwork = new Set();
	const markdownPaths = [...packedPaths].filter((path) => path.endsWith(".md")).sort();
	for (const sourcePath of markdownPaths) {
		let text;
		try {
			// Inspect one packaged document at a time, bounding memory and retaining sorted failure order.
			// oxlint-disable-next-line no-await-in-loop
			text = await readFile(resolve(cwd, sourcePath), "utf8");
		} catch (error) {
			failures.push(
				`Packed Markdown file ${sourcePath} could not be read for link verification: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		for (const match of text.matchAll(MARKDOWN_LINK_PATTERN)) {
			const rawTarget = match[1] ?? "";
			const targetPath = normalizePackedMarkdownTarget(sourcePath, rawTarget);
			if (!targetPath || packedPathExists(packedPaths, targetPath)) {
				continue;
			}
			// README artwork is hosted by GitHub; verify it in the repo while keeping it out of npm.
			if (isRepositoryReadmeArtwork(sourcePath, match[0], targetPath)) {
				repositoryArtwork.add(targetPath);
				continue;
			}
			failures.push(
				`Packed Markdown link ${sourcePath} -> ${rawTarget} resolves to missing packed file ${targetPath}.`,
			);
		}
	}
	failures.push(
		...(await collectMissingPaths(repositoryArtwork, cwd)).map(
			(path) => `README artwork is missing from the repository: ${path}.`,
		),
	);
	return failures;
}

export function pluralize(count, singular, plural = `${singular}s`) {
	return count === 1 ? singular : plural;
}

export function collectVerificationFailures(options) {
	const { forbiddenPackedFiles, forbiddenRepoFiles, missingPackedFiles, missingRepoFiles } =
		options;
	const failures = [];

	if (missingRepoFiles.length > 0) {
		failures.push(
			`Missing required repo file${missingRepoFiles.length === 1 ? "" : "s"}: ${missingRepoFiles.join(", ")}`,
		);
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

	return failures;
}

export function evaluatePackResult(options) {
	const { forbiddenRepoFiles, missingRepoFiles, packResult, publishContract } = options;
	const packedPaths = collectPackedPaths(Array.isArray(packResult.files) ? packResult.files : []);
	const missingPackedFiles = publishContract.requiredPackedFiles.filter(
		(path) => !packedPaths.has(path),
	);
	// ponytail: Only the two canonical leak patterns are supported; add explicit rules if the publish contract grows.
	const forbiddenPackedFiles = publishContract.forbiddenPackedFiles.filter((pattern) =>
		[...packedPaths].some(
			(path) =>
				(pattern.endsWith("/") && path.startsWith(pattern)) ||
				(pattern === ".env*" && path.startsWith(".env")) ||
				(pattern === "**/*.tgz" && path.endsWith(".tgz")) ||
				path === pattern,
		),
	);
	const failures = collectVerificationFailures({
		forbiddenPackedFiles,
		forbiddenRepoFiles,
		missingPackedFiles,
		missingRepoFiles,
	});

	return {
		failures,
		forbiddenPackedFiles,
		forbiddenRepoFiles,
		missingPackedFiles,
		missingRepoFiles,
		packResult,
		packedPaths,
		publishContract,
	};
}

function printVerificationReport(report, options) {
	console.log(`Tarball: ${report.packResult.filename}`);
	console.log(
		`Packed files: ${report.packResult.entryCount} ${pluralize(report.packResult.entryCount, "entry", "entries")}`,
	);
	console.log(`Tarball size: ${report.packResult.size} bytes`);
	console.log(`Unpacked size: ${report.packResult.unpackedSize} bytes`);

	if (options.listFiles) {
		console.log("Packed file list:");
		for (const path of [...report.packedPaths].sort()) {
			console.log(`- ${path}`);
		}
	}

	if (report.failures.length > 0) {
		console.error("Package verification failed:");
		for (const failure of report.failures) {
			console.error(`- ${failure}`);
		}
		return;
	}

	console.log("Package verification passed.");
}

function printPiSmokeReport(report) {
	console.log(`Pi package smoke path: ${report.packageDir}`);
	console.log(`agent_browser tools found: ${report.agentBrowserToolCount}`);
	console.log(
		`Packaged agent_browser invocation: ${
			report.agentBrowserSmokeExecuted ? report.agentBrowserSmokeArgs.join(" ") : "not run"
		}`,
	);
	if (report.failures.length > 0) {
		console.error("Pi package smoke failed:");
		for (const failure of report.failures) {
			console.error(`- ${failure}`);
		}
		return;
	}
	console.log("Pi package smoke passed.");
}

export async function verifyPackageRelease(options = {}) {
	const cwd = options.cwd ?? process.cwd();
	const packResult = await getDryRunPackResult(cwd);
	const publishContract = await loadPublishContract({ cwd });
	const missingRepoFiles = await collectMissingPaths(publishContract.requiredRepoFiles, cwd);
	const forbiddenRepoFiles = await collectPresentPaths(publishContract.forbiddenRepoFiles, cwd);
	const report = evaluatePackResult({
		forbiddenRepoFiles,
		missingRepoFiles,
		packResult,
		publishContract,
	});
	const packedMarkdownLinkFailures = await collectPackedMarkdownLinkFailures({
		cwd,
		packedPaths: report.packedPaths,
	});
	return {
		...report,
		failures: [...report.failures, ...packedMarkdownLinkFailures],
		packedMarkdownLinkFailures,
	};
}

function isDirectRun(metaUrl, argv = process.argv) {
	if (!argv[1]) {
		return false;
	}
	return metaUrl === pathToFileURL(argv[1]).href;
}

export async function main(argv = process.argv.slice(2)) {
	try {
		const cliArgs = parseCliArgs(argv);
		if (cliArgs.showHelp) {
			printHelp();
			return 0;
		}

		const report = await verifyPackageRelease();
		printVerificationReport(report, cliArgs);
		if (report.failures.length > 0) {
			return 1;
		}

		if (cliArgs.smokePi) {
			const smokeReport = await verifyPackagedPiLoad();
			printPiSmokeReport(smokeReport);
			return smokeReport.failures.length > 0 ? 1 : 0;
		}

		return 0;
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(error.message);
			console.error("Run with --help for usage.");
			return 2;
		}
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

if (isDirectRun(import.meta.url)) {
	main()
		.then((exitCode) => {
			process.exitCode = exitCode;
		})
		.catch((error) => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		});
}
