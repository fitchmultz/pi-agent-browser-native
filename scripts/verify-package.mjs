/**
 * Purpose: Verify the published npm tarball shape, package-path Pi loadability, and key repo release prerequisites for pi-agent-browser.
 * Responsibilities: Parse CLI options, run `npm pack`, validate required and forbidden repo and packed files, catch repo-local auto-discovery shims, smoke-load and deterministically smoke-execute the packed package in an isolated Pi resource loader when requested, and print concise release reports.
 * Scope: Packaging and release verification only; code compilation/tests stay in the normal npm verify scripts.
 * Usage: Run with `node scripts/verify-package.mjs`, `node scripts/verify-package.mjs --smoke-pi`, `npm run verify -- package`, `npm run verify -- package-pi`, or `npm run verify -- release`.
 * Invariants/Assumptions: The package is built directly from the current repo checkout, npm and tar are available on PATH, installed Pi SDK APIs match the current dev dependency, and the package should publish only canonical docs plus the extension source and license.
 */

import { execFile as execFileCallback } from "node:child_process";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createAgentSession, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";
import {
	FORBIDDEN_PACKED_FILES,
	FORBIDDEN_REPO_FILES,
	REQUIRED_REPO_FILES,
	loadPublishContract,
} from "./publish-contract.mjs";

export { FORBIDDEN_PACKED_FILES, FORBIDDEN_REPO_FILES, REQUIRED_REPO_FILES, loadPublishContract };

const execFile = promisify(execFileCallback);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const tarCommand = process.platform === "win32" ? "tar.exe" : "tar";
const SUPPORTED_ARGS = new Set(["--list-files", "--smoke-pi"]);
const PACKAGED_AGENT_BROWSER_SMOKE_ARGS = ["--version"];
const PACKAGED_AGENT_BROWSER_SMOKE_TOOL_CALL_ID = "verify-package-agent-browser-smoke";
const FAKE_AGENT_BROWSER_VERSION = "agent-browser 0.0.0-packaged-smoke";

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
                 agent_browser tool from that package in isolation, and execute
                 a deterministic fake-binary-backed agent_browser --version smoke.
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
		throw new UsageError(`Unknown option${unknownArgs.length === 1 ? "" : "s"}: ${unknownArgs.join(", ")}`);
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
			await access(resolve(cwd, path));
			presentPaths.push(path);
		} catch {
			// expected: absent
		}
	}
	return presentPaths;
}

function parseSinglePackResult(stdout, stderr) {
	const parsed = JSON.parse(stdout);
	if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== "object" || parsed[0] === null) {
		throw new Error(`Unexpected npm pack output.\nstdout:\n${stdout}\n\nstderr:\n${stderr}`);
	}

	return parsed[0];
}

async function getDryRunPackResult(cwd = process.cwd()) {
	const { stdout, stderr } = await execFile(npmCommand, ["pack", "--json", "--dry-run"], {
		cwd,
		maxBuffer: 5 * 1024 * 1024,
	});

	return parseSinglePackResult(stdout, stderr);
}

async function packToTemporaryPackageDir(cwd = process.cwd()) {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-package-"));
	let tarballPath;

	try {
		const { stdout, stderr } = await execFile(npmCommand, ["pack", "--json", "--pack-destination", tempDir], {
			cwd,
			maxBuffer: 5 * 1024 * 1024,
		});
		const packResult = parseSinglePackResult(stdout, stderr);
		if (typeof packResult.filename !== "string" || packResult.filename.length === 0) {
			throw new Error(`Unexpected npm pack result without a filename.\nstdout:\n${stdout}\n\nstderr:\n${stderr}`);
		}

		tarballPath = resolve(tempDir, packResult.filename);
		await execFile(tarCommand, ["xzf", tarballPath, "-C", tempDir], {
			maxBuffer: 5 * 1024 * 1024,
		});

		return {
			cleanup: async () => {
				await rm(tempDir, { force: true, recursive: true });
				if (tarballPath) await rm(tarballPath, { force: true });
			},
			packageDir: join(tempDir, "package"),
			packResult,
		};
	} catch (error) {
		await rm(tempDir, { force: true, recursive: true });
		if (tarballPath) await rm(tarballPath, { force: true });
		throw error;
	}
}

export function collectPackedPaths(files) {
	return new Set(
		files
			.filter((entry) => typeof entry?.path === "string")
			.map((entry) => entry.path),
	);
}

export function pluralize(count, singular, plural = `${singular}s`) {
	return count === 1 ? singular : plural;
}

function isInsidePath(childPath, parentPath) {
	const normalizedChild = resolve(childPath);
	const normalizedParent = resolve(parentPath);
	return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${sep}`);
}

export function evaluatePiSmokeResult(options) {
	const { packageDir, tools } = options;
	const agentBrowserTools = tools.filter((tool) => tool.name === "agent_browser");
	const failures = [];

	if (agentBrowserTools.length !== 1) {
		failures.push(`Expected exactly one packaged agent_browser tool, found ${agentBrowserTools.length}.`);
	}

	for (const tool of agentBrowserTools) {
		const sourcePath = tool.sourceInfo?.path ?? tool.source?.path ?? tool.path;
		if (typeof sourcePath !== "string" || sourcePath.length === 0) {
			failures.push("agent_browser tool did not expose source path metadata for package-path verification.");
			continue;
		}
		if (!isInsidePath(sourcePath, packageDir)) {
			failures.push(`agent_browser loaded from ${sourcePath}; expected a source inside packed package ${packageDir}.`);
		}
	}

	return failures;
}

function summarizeToolResult(result) {
	if (!result || typeof result !== "object") return String(result);

	const textContent = Array.isArray(result.content)
		? result.content
				.filter((item) => item?.type === "text" && typeof item.text === "string")
				.map((item) => item.text)
				.join("\n")
		: "";
	const details = result.details && typeof result.details === "object" ? result.details : undefined;
	const summaryParts = [
		textContent.trim(),
		details?.summary ? `summary: ${details.summary}` : undefined,
		details?.exitCode !== undefined ? `exitCode: ${details.exitCode}` : undefined,
		details?.spawnError ? `spawnError: ${details.spawnError}` : undefined,
		details?.stderr ? `stderr: ${details.stderr}` : undefined,
	].filter((part) => typeof part === "string" && part.length > 0);
	const summary = summaryParts.join("\n");
	return summary.length > 1_200 ? `${summary.slice(0, 1_197)}...` : summary;
}

async function createFakeAgentBrowserBinary() {
	const binDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-fake-bin-"));
	const nodeExecutable = JSON.stringify(process.execPath);
	const fakeScript = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-V")) {
  console.log(${JSON.stringify(FAKE_AGENT_BROWSER_VERSION)});
  process.exit(0);
}
console.error("fake agent-browser only supports --version for packaged smoke validation; received: " + args.join(" "));
process.exit(64);
`;

	const posixPath = join(binDir, "agent-browser");
	await writeFile(posixPath, fakeScript, "utf8");
	await chmod(posixPath, 0o755);

	const cmdPath = join(binDir, "agent-browser.cmd");
	await writeFile(cmdPath, `@echo off\n${nodeExecutable} "%~dp0agent-browser" %*\n`, "utf8");

	return {
		binDir,
		cleanup: async () => {
			await rm(binDir, { force: true, recursive: true });
		},
	};
}

async function withFakeAgentBrowserOnPath(work) {
	const fakeBinary = await createFakeAgentBrowserBinary();
	const previousPath = process.env.PATH;
	try {
		process.env.PATH = previousPath ? `${fakeBinary.binDir}${delimiter}${previousPath}` : fakeBinary.binDir;
		return await work();
	} finally {
		if (previousPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = previousPath;
		}
		await fakeBinary.cleanup();
	}
}

export async function executePackagedAgentBrowserSmoke(options) {
	const { packageDir, session } = options;
	const toolDefinition =
		typeof session.getToolDefinition === "function" ? session.getToolDefinition("agent_browser") : undefined;

	if (!toolDefinition || typeof toolDefinition.execute !== "function") {
		return {
			failures: ["Packaged agent_browser tool definition was not executable via Pi session.getToolDefinition()."],
			invocation: undefined,
		};
	}

	const ctx =
		typeof session.createReplacedSessionContext === "function"
			? session.createReplacedSessionContext()
			: {
					cwd: packageDir,
					sessionManager: {
						getBranch: () => [],
						getSessionDir: () => undefined,
						getSessionFile: () => undefined,
						getSessionId: () => undefined,
					},
				};
	const updates = [];
	let result;
	try {
		result = await toolDefinition.execute(
			PACKAGED_AGENT_BROWSER_SMOKE_TOOL_CALL_ID,
			{ args: PACKAGED_AGENT_BROWSER_SMOKE_ARGS },
			undefined,
			(update) => updates.push(update),
			ctx,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			failures: [
				`Packaged agent_browser invocation threw for args ${JSON.stringify(PACKAGED_AGENT_BROWSER_SMOKE_ARGS)}: ${message}`,
			],
			invocation: { args: PACKAGED_AGENT_BROWSER_SMOKE_ARGS, error: message, updates },
		};
	}

	const text = summarizeToolResult(result);
	const details = result && typeof result === "object" && result.details && typeof result.details === "object" ? result.details : {};
	const failures = [];
	if (result?.isError === true) {
		failures.push(
			`Packaged agent_browser invocation failed for args ${JSON.stringify(PACKAGED_AGENT_BROWSER_SMOKE_ARGS)}:\n${text}`,
		);
	}
	if (details.inspection !== true) {
		failures.push("Packaged agent_browser --version smoke did not report a plain-text inspection result.");
	}
	if (details.exitCode !== 0) {
		failures.push(`Packaged agent_browser --version smoke exited with ${String(details.exitCode)}; expected 0.`);
	}
	if (!text.includes(FAKE_AGENT_BROWSER_VERSION)) {
		failures.push(
			`Packaged agent_browser --version smoke did not return expected fake version text ${JSON.stringify(FAKE_AGENT_BROWSER_VERSION)}.`,
		);
	}

	return {
		failures,
		invocation: { args: PACKAGED_AGENT_BROWSER_SMOKE_ARGS, result, updates },
	};
}

export function collectVerificationFailures(options) {
	const { forbiddenPackedFiles, forbiddenRepoFiles, missingPackedFiles, missingRepoFiles } = options;
	const failures = [];

	if (missingRepoFiles.length > 0) {
		failures.push(`Missing required repo file${missingRepoFiles.length === 1 ? "" : "s"}: ${missingRepoFiles.join(", ")}`);
	}
	if (forbiddenRepoFiles.length > 0) {
		failures.push(`Forbidden repo file${forbiddenRepoFiles.length === 1 ? "" : "s"} present: ${forbiddenRepoFiles.join(", ")}`);
	}
	if (missingPackedFiles.length > 0) {
		failures.push(`Missing required packed file${missingPackedFiles.length === 1 ? "" : "s"}: ${missingPackedFiles.join(", ")}`);
	}
	if (forbiddenPackedFiles.length > 0) {
		failures.push(`Forbidden packed file${forbiddenPackedFiles.length === 1 ? "" : "s"} present: ${forbiddenPackedFiles.join(", ")}`);
	}

	return failures;
}

export function evaluatePackResult(options) {
	const { forbiddenRepoFiles, missingRepoFiles, packResult, publishContract } = options;
	const packedPaths = collectPackedPaths(Array.isArray(packResult.files) ? packResult.files : []);
	const missingPackedFiles = publishContract.requiredPackedFiles.filter((path) => !packedPaths.has(path));
	const forbiddenPackedFiles = publishContract.forbiddenPackedFiles.filter((path) => packedPaths.has(path));
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
	console.log(`Packed files: ${report.packResult.entryCount} ${pluralize(report.packResult.entryCount, "entry", "entries")}`);
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
	const publishContract = await loadPublishContract({ cwd });
	const missingRepoFiles = await collectMissingPaths(publishContract.requiredRepoFiles, cwd);
	const forbiddenRepoFiles = await collectPresentPaths(publishContract.forbiddenRepoFiles, cwd);
	const packResult = await getDryRunPackResult(cwd);
	return evaluatePackResult({ forbiddenRepoFiles, missingRepoFiles, packResult, publishContract });
}

export async function verifyPackagedPiLoad(options = {}) {
	const cwd = options.cwd ?? process.cwd();
	const { cleanup, packageDir, packResult } = await packToTemporaryPackageDir(cwd);
	let session;
	let tempAgentDir;

	try {
		tempAgentDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-agent-"));
		const resourceLoader = new DefaultResourceLoader({
			agentDir: tempAgentDir,
			cwd: packageDir,
			additionalExtensionPaths: [packageDir],
			noContextFiles: true,
			noExtensions: true,
			noPromptTemplates: true,
			noSkills: true,
			noThemes: true,
		});
		await resourceLoader.reload();
		const result = await createAgentSession({
			agentDir: tempAgentDir,
			cwd: packageDir,
			noTools: "builtin",
			resourceLoader,
		});
		session = result.session;

		const tools = session.getAllTools();
		const failures = evaluatePiSmokeResult({ packageDir, tools });
		let invocation;

		if (failures.length === 0) {
			const executionReport = await withFakeAgentBrowserOnPath(() =>
				executePackagedAgentBrowserSmoke({ packageDir, session }),
			);
			failures.push(...executionReport.failures);
			invocation = executionReport.invocation;
		}

		return {
			agentBrowserSmokeArgs: PACKAGED_AGENT_BROWSER_SMOKE_ARGS,
			agentBrowserSmokeExecuted: invocation !== undefined,
			agentBrowserToolCount: tools.filter((tool) => tool.name === "agent_browser").length,
			failures,
			invocation,
			packageDir,
			packResult,
			tools,
		};
	} finally {
		session?.dispose();
		await cleanup();
		if (tempAgentDir) await rm(tempAgentDir, { force: true, recursive: true });
	}
}

function isDirectRun(metaUrl, argv = process.argv) {
	if (!argv[1]) return false;
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
		if (report.failures.length > 0) return 1;

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
	main().then((exitCode) => {
		process.exitCode = exitCode;
	});
}
