/** Isolated packaged Pi SDK/CLI loading and deterministic browser invocation evidence. */
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { npmCommand, npmExecOptions, packToTemporaryPackageDir } from "./package-pack.mjs";

const execFile = promisify(execFileCallback);
const PACKAGED_AGENT_BROWSER_SMOKE_ARGS = ["--version"];
const PACKAGED_AGENT_BROWSER_SMOKE_TOOL_CALL_ID = "verify-package-agent-browser-smoke";
const FAKE_AGENT_BROWSER_VERSION = "agent-browser 0.0.0-packaged-smoke";

function isInsidePath(childPath, parentPath) {
	const normalizedChild = resolve(childPath);
	const normalizedParent = resolve(parentPath);
	return (
		normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${sep}`)
	);
}

export function evaluatePiSmokeResult({ packageDir, tools }) {
	const agentBrowserTools = tools.filter((tool) => tool.name === "agent_browser");
	const failures = [];
	if (agentBrowserTools.length !== 1) {
		failures.push(
			`Expected exactly one packaged agent_browser tool, found ${agentBrowserTools.length}.`,
		);
	}
	for (const tool of agentBrowserTools) {
		const sourcePath = tool.sourceInfo?.path ?? tool.source?.path ?? tool.path;
		if (typeof sourcePath !== "string" || sourcePath.length === 0) {
			failures.push(
				"agent_browser tool did not expose source path metadata for package-path verification.",
			);
			continue;
		}
		if (!isInsidePath(sourcePath, packageDir)) {
			failures.push(
				`agent_browser loaded from ${sourcePath}; expected a source inside packed package ${packageDir}.`,
			);
		}
	}
	return failures;
}

function objectDetails(result) {
	return result &&
		typeof result === "object" &&
		result.details &&
		typeof result.details === "object"
		? result.details
		: {};
}

function summarizeToolResult(result) {
	if (!result || typeof result !== "object") {
		return String(result);
	}
	const textContent = Array.isArray(result.content)
		? result.content
				.filter((item) => item?.type === "text" && typeof item.text === "string")
				.map((item) => item.text)
				.join("\n")
		: "";
	const details = objectDetails(result);
	const summary = [
		textContent.trim(),
		details.summary ? `summary: ${details.summary}` : undefined,
		details.exitCode !== undefined ? `exitCode: ${details.exitCode}` : undefined,
		details.spawnError ? `spawnError: ${details.spawnError}` : undefined,
		details.stderr ? `stderr: ${details.stderr}` : undefined,
	]
		.filter((part) => typeof part === "string" && part.length > 0)
		.join("\n");
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
	const launcherPath = join(binDir, "agent-browser");
	await writeFile(launcherPath, fakeScript, "utf8");
	await chmod(launcherPath, 0o755);
	await writeFile(
		join(binDir, "agent-browser.cmd"),
		`@echo off\n${nodeExecutable} "%~dp0agent-browser" %*\n`,
		"utf8",
	);
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
		process.env.PATH = previousPath
			? `${fakeBinary.binDir}${delimiter}${previousPath}`
			: fakeBinary.binDir;
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

function invocationFailures(result) {
	const text = summarizeToolResult(result);
	const details = objectDetails(result);
	const failures = [];
	if (result?.isError === true) {
		failures.push(
			`Packaged agent_browser invocation failed for args ${JSON.stringify(PACKAGED_AGENT_BROWSER_SMOKE_ARGS)}:\n${text}`,
		);
	}
	if (details.inspection !== true) {
		failures.push(
			"Packaged agent_browser --version smoke did not report a plain-text inspection result.",
		);
	}
	if (details.exitCode !== 0) {
		failures.push(
			`Packaged agent_browser --version smoke exited with ${String(details.exitCode)}; expected 0.`,
		);
	}
	if (!text.includes(FAKE_AGENT_BROWSER_VERSION)) {
		failures.push(
			`Packaged agent_browser --version smoke did not return expected fake version text ${JSON.stringify(FAKE_AGENT_BROWSER_VERSION)}.`,
		);
	}
	return failures;
}

function smokeContext(session, packageDir) {
	if (typeof session.createReplacedSessionContext === "function") {
		return session.createReplacedSessionContext();
	}
	return {
		cwd: packageDir,
		sessionManager: {
			getBranch: () => [],
			getSessionDir: () => {
				/* This isolated session has no transcript directory. */
			},
			getSessionFile: () => {
				/* This isolated session has no transcript file. */
			},
			getSessionId: () => {
				/* Sessionless inspection has no persistent Pi identity. */
			},
		},
	};
}

export async function executePackagedAgentBrowserSmoke({ packageDir, session }) {
	const toolDefinition =
		typeof session.getToolDefinition === "function"
			? session.getToolDefinition("agent_browser")
			: undefined;
	if (!toolDefinition || typeof toolDefinition.execute !== "function") {
		return {
			failures: [
				"Packaged agent_browser tool definition was not executable via Pi session.getToolDefinition().",
			],
			invocation: undefined,
		};
	}
	const ctx = smokeContext(session, packageDir);
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
	return {
		failures: invocationFailures(result),
		invocation: { args: PACKAGED_AGENT_BROWSER_SMOKE_ARGS, result, updates },
	};
}

async function verifyPackagedCli(packageDir, tempAgentDir, hostCli) {
	const marker = join(tempAgentDir, "cli.json");
	const observer = join(tempAgentDir, "observer.ts");
	await writeFile(
		observer,
		`import { writeFileSync } from "node:fs";
export default function(pi) { pi.on("session_start", (_event, ctx) => { writeFileSync(${JSON.stringify(marker)}, JSON.stringify(pi.getActiveTools())); ctx.shutdown(); }); }`,
	);
	const cliProcess = execFile(
		process.execPath,
		[
			hostCli,
			"--mode",
			"rpc",
			"--no-session",
			"-ne",
			"-ns",
			"-np",
			"-nc",
			"--no-themes",
			"--approve",
			"-e",
			packageDir,
			"-e",
			observer,
		],
		{
			cwd: packageDir,
			timeout: 30_000,
			env: {
				...process.env,
				HOME: tempAgentDir,
				USERPROFILE: tempAgentDir,
				PI_CODING_AGENT_DIR: tempAgentDir,
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
			},
		},
	);
	cliProcess.child.stdin.end();
	const child = await cliProcess;
	assert.doesNotMatch(child.stderr, /Failed to load extension|Extension error/);
	assert.ok(JSON.parse(await readFile(marker, "utf8")).includes("agent_browser"));
}

async function installRuntimeConsumer(tarballPath) {
	const consumerDir = join(dirname(tarballPath), "consumer");
	await mkdir(consumerDir);
	await writeFile(
		join(consumerDir, "package.json"),
		JSON.stringify({ name: "pi-agent-browser-smoke-consumer", private: true }),
	);
	// Install the tarball as a dependency: package devDependencies are not consumer roots.
	// Pi supplies host peers, so neither install nor resolve their optional peer graph here.
	await execFile(
		npmCommand,
		[
			"install",
			tarballPath,
			"--omit=dev",
			"--omit=peer",
			"--ignore-scripts",
			"--legacy-peer-deps",
			"--no-audit",
			"--no-fund",
		],
		{ ...npmExecOptions, cwd: consumerDir, maxBuffer: 5 * 1024 * 1024 },
	);
	const packageDir = join(consumerDir, "node_modules", "pi-agent-browser-native");
	for (const peer of [
		"@earendil-works/pi-ai",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
		"typebox",
	]) {
		assert.equal(existsSync(join(consumerDir, "node_modules", peer)), false, peer);
		assert.equal(existsSync(join(packageDir, "node_modules", peer)), false, peer);
	}
	return packageDir;
}

async function verifyPackagedRuntimeFiles(packageDir, tempAgentDir) {
	const options = {
		cwd: tempAgentDir,
		env: { ...process.env, HOME: tempAgentDir, USERPROFILE: tempAgentDir },
		timeout: 10_000,
	};
	const config = await execFile(
		process.execPath,
		[join(packageDir, "scripts/config.mjs"), "paths"],
		options,
	);
	assert.ok(config.stdout.includes(join(tempAgentDir, ".pi", "config")));
	const source = join(tempAgentDir, "legacy.jsonl");
	const destination = join(tempAgentDir, "converted.jsonl");
	const bytes = `${JSON.stringify({ type: "session", version: 3, id: "packaged-conversion", timestamp: "2026-01-01T00:00:00.000Z", cwd: tempAgentDir })}\n`;
	await writeFile(source, bytes, { mode: 0o600 });
	await execFile(
		process.execPath,
		[
			join(packageDir, "scripts/convert-browser-session.mjs"),
			"--source",
			source,
			"--output",
			destination,
			"--confirm-stopped",
		],
		options,
	);
	assert.equal(await readFile(source, "utf8"), bytes);
	assert.equal(JSON.parse(await readFile(destination, "utf8")).id, "packaged-conversion");
	const worker = execFile(
		process.execPath,
		[
			"--permission",
			"--max-old-space-size=64",
			realpathSync(join(packageDir, "dist/extensions/agent-browser/script-worker.js")),
			"1048576",
			"8388608",
		],
		{ cwd: tempAgentDir, env: {}, timeout: 10_000 },
	);
	worker.child.stdin.end(`${JSON.stringify({ type: "start", code: "return 42;" })}\n`);
	const { stdout } = await worker;
	assert.ok(
		stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.some((row) => row.type === "complete" && row.hasValue === true && row.value === 42),
	);
}

export async function verifyPackagedPiLoad(options = {}) {
	const cwd = options.cwd ?? process.cwd();
	const { hostCli } = await import("./compat-host.mjs");
	const { cleanup, packResult, tarballPath } = await packToTemporaryPackageDir(cwd);
	let session;
	let tempAgentDir;
	try {
		tempAgentDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-agent-"));
		const packageDir = await installRuntimeConsumer(tarballPath);
		await verifyPackagedRuntimeFiles(packageDir, tempAgentDir);
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
		await session.bindExtensions({ mode: "print", onError: (error) => failures.push(error.error) });
		failures.push(
			...resourceLoader
				.getExtensions()
				.errors.map(({ path, error }) => `Packaged extension ${path} failed to load: ${error}`),
		);
		let invocation;
		if (failures.length === 0) {
			const executionReport = await withFakeAgentBrowserOnPath(() =>
				executePackagedAgentBrowserSmoke({ packageDir, session }),
			);
			failures.push(...executionReport.failures);
			invocation = executionReport.invocation;
			await verifyPackagedCli(packageDir, tempAgentDir, hostCli);
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
		try {
			if (session) {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			}
		} finally {
			session?.dispose();
		}
		await cleanup();
		if (tempAgentDir) {
			await rm(tempAgentDir, { force: true, recursive: true });
		}
	}
}
