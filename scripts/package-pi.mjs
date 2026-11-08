/** Isolated packaged Pi SDK/CLI loading and deterministic browser invocation evidence. */
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { npmCommand, npmExecOptions, packToTemporaryPackageDir } from "./package-pack.mjs";
import { isConfigObject } from "../extensions/agent-browser/lib/config-policy.js";

/** @typedef {import("@earendil-works/pi-coding-agent").AgentSession} AgentSession */
/** @typedef {Pick<import("@earendil-works/pi-agent-core").AgentTool<import("typebox").TSchema, unknown>, "name" | "execute">} SmokeTool */

const execFile = promisify(execFileCallback);
const PACKAGED_AGENT_BROWSER_SMOKE_ARGS = ["--version"];
const PACKAGED_AGENT_BROWSER_SMOKE_TOOL_CALL_ID = "verify-package-agent-browser-smoke";
const FAKE_AGENT_BROWSER_VERSION = "agent-browser 0.0.0-packaged-smoke";

/** @param {string} childPath
 * @param {string} parentPath
 */
function isInsidePath(childPath, parentPath) {
	const normalizedChild = resolve(childPath);
	const normalizedParent = resolve(parentPath);
	return (
		normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${sep}`)
	);
}

/** @param {{ readonly packageDir: string; readonly tools: readonly { readonly name: string; readonly sourceInfo?: Pick<import("@earendil-works/pi-coding-agent").ToolInfo["sourceInfo"], "path"> }[] }} options */
export function evaluatePiSmokeResult({ packageDir, tools }) {
	const agentBrowserTools = tools.filter((tool) => tool.name === "agent_browser");
	const failures = [];
	if (agentBrowserTools.length !== 1) {
		failures.push(
			`Expected exactly one packaged agent_browser tool, found ${agentBrowserTools.length}.`,
		);
	}
	for (const tool of agentBrowserTools) {
		const sourcePath = tool.sourceInfo?.path;
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

/** @param {unknown} result */
function objectDetails(result) {
	return isConfigObject(result) && isConfigObject(result.details) ? result.details : {};
}

/** @param {unknown} result */
function summarizeToolResult(result) {
	if (!isConfigObject(result)) {
		return String(result);
	}
	/** @type {unknown[]} */
	const content = Array.isArray(result.content) ? result.content : [];
	const textContent = content
		.flatMap((item) =>
			isConfigObject(item) && item.type === "text" && typeof item.text === "string"
				? [item.text]
				: [],
		)
		.join("\n");
	const details = objectDetails(result);
	const fields = [
		{ name: "summary", value: details.summary },
		{ name: "exitCode", value: details.exitCode },
		{ name: "spawnError", value: details.spawnError },
		{ name: "stderr", value: details.stderr },
	];
	const summary = [
		textContent.trim(),
		...fields
			.filter(({ name, value }) => (name === "exitCode" ? value !== undefined : Boolean(value)))
			.map(({ name, value }) => `${name}: ${String(value)}`),
	]
		.filter((part) => part.length > 0)
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

/** @template T
 * @param {() => Promise<T>} work
 */
async function withFakeAgentBrowserOnPath(work) {
	const fakeBinary = await createFakeAgentBrowserBinary();
	const previousPath = process.env.PATH;
	try {
		process.env.PATH =
			previousPath !== undefined && previousPath.length > 0
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

/** @param {unknown} result */
function invocationFailures(result) {
	const text = summarizeToolResult(result);
	const details = objectDetails(result);
	const failures = [];
	if (isConfigObject(result) && result.isError === true) {
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

/** @param {readonly SmokeTool[]} tools */
export async function executePackagedAgentBrowserSmoke(tools) {
	const toolDefinition = tools.find((tool) => tool.name === "agent_browser");
	if (toolDefinition === undefined) {
		return {
			failures: ["Packaged agent_browser tool was not executable via Pi's active tool registry."],
			invocation: undefined,
		};
	}
	/** @type {unknown[]} */
	const updates = [];
	let result;
	try {
		result = await toolDefinition.execute(
			PACKAGED_AGENT_BROWSER_SMOKE_TOOL_CALL_ID,
			{ args: PACKAGED_AGENT_BROWSER_SMOKE_ARGS },
			undefined,
			(update) => updates.push(update),
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

/** Start of the browser's one-time notice when no active tool_search or codemode reaches its deferred tools. */
const UNREACHABLE_NOTICE = "Browser tools that are not selected directly are only reachable";

/**
 * Runs one prompt with the packed package in the real CLI (RPC mode), answered by Pi's faux provider.
 * Reports the active tools at session start and when the run starts, and the browser's notices.
 *
 * @param {string} packageDir
 * @param {string} tempAgentDir
 * @param {string} hostCli
 * @param {readonly string[]} hostExtensions additional extension arguments, such as Pi built-ins
 */
async function runPackagedCli(packageDir, tempAgentDir, hostCli, hostExtensions) {
	const marker = join(tempAgentDir, "cli.json");
	const observer = join(tempAgentDir, "observer.ts");
	await writeFile(
		observer,
		`import { writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
export default function(pi) {
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("ok")]);
	pi.registerProvider("faux", { api: faux.api, baseUrl: faux.getModel().baseUrl, apiKey: "faux-key", models: faux.models, streamSimple: faux.provider.streamSimple });
	const tools = {};
	pi.on("session_start", () => { tools.sessionStart = pi.getActiveTools(); });
	pi.on("before_agent_start", () => { tools.runStart = pi.getActiveTools(); });
	pi.on("agent_settled", (_event, ctx) => { writeFileSync(${JSON.stringify(marker)}, JSON.stringify(tools)); ctx.shutdown(); });
}`,
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
			"--model",
			"faux/faux-1",
			...hostExtensions,
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
	assert.ok(cliProcess.child.stdin);
	// The observer shuts Pi down once the run settles.
	cliProcess.child.stdin.write(`${JSON.stringify({ type: "prompt", message: "Reply ok." })}\n`);
	const child = await cliProcess;
	assert.doesNotMatch(child.stderr, /Failed to load extension|Extension error/);
	/** @type {unknown} */
	const tools = JSON.parse(await readFile(marker, "utf8"));
	assert.ok(isConfigObject(tools));
	const { sessionStart, runStart } = tools;
	assert.ok(Array.isArray(sessionStart) && sessionStart.includes("agent_browser"));
	assert.ok(Array.isArray(runStart));
	const notices = child.stdout
		.split("\n")
		.filter((line) => line.includes(UNREACHABLE_NOTICE))
		.map((line) => /** @type {unknown} */ (JSON.parse(line)))
		.filter(
			(event) =>
				isConfigObject(event) &&
				event.type === "extension_ui_request" &&
				event.method === "notify" &&
				typeof event.message === "string" &&
				event.message.startsWith(UNREACHABLE_NOTICE),
		);
	return { sessionStart, runStart, notices: notices.length };
}

/** @param {string} packageDir
 * @param {string} tempAgentDir
 * @param {string} hostCli
 */
async function verifyPackagedCli(packageDir, tempAgentDir, hostCli) {
	// -ne loads neither tool_search nor codemode, so nothing reaches the deferred tools.
	const isolated = await runPackagedCli(packageDir, tempAgentDir, hostCli, []);
	assert.equal(
		isolated.notices,
		1,
		"The browser must warn once that its deferred tools are unreachable.",
	);
	const withSearch = await runPackagedCli(packageDir, tempAgentDir, hostCli, [
		"-e",
		"builtin:tool-search",
	]);
	assert.ok(
		withSearch.sessionStart.includes("tool_search"),
		"The browser did not activate tool_search.",
	);
	assert.equal(
		withSearch.notices,
		0,
		"The browser warned although tool_search reaches its deferred tools.",
	);
	// Pi's MCP extension loads after the package and activates codemode for a configured server
	// in its own session_start handler.
	await writeFile(
		join(tempAgentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: { probe: { command: process.execPath, args: ["-e", "process.exit(0)"] } },
		}),
	);
	const withMcp = await runPackagedCli(packageDir, tempAgentDir, hostCli, [
		"-e",
		"builtin:codemode",
		"-e",
		"builtin:mcp",
	]);
	assert.ok(withMcp.runStart.includes("codemode"), "Pi's MCP extension did not activate codemode.");
	assert.equal(
		withMcp.notices,
		0,
		"The browser warned although codemode, activated by a later extension, reaches its deferred tools.",
	);
}

/** @param {string} tarballPath */
export async function installRuntimeConsumer(tarballPath) {
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
	const linkedConsumerDir = join(dirname(tarballPath), "linked-consumer");
	await symlink(consumerDir, linkedConsumerDir, "junction");
	const packageDir = join(linkedConsumerDir, "node_modules", "pi-agent-browser-native");
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

/** @param {string} packageDir
 * @param {string} tempAgentDir
 */
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
	/** @type {unknown} */
	const converted = JSON.parse(await readFile(destination, "utf8"));
	assert.ok(isConfigObject(converted));
	assert.equal(converted.id, "packaged-conversion");
}

/** @param {{ readonly cwd?: string; readonly tarballPath?: string | undefined }} [options] */
export async function verifyPackagedPiLoad(options = {}) {
	const cwd = options.cwd ?? process.cwd();
	const { hostCli } = await import("./compat-host.mjs");
	const { cleanup, packResult, tarballPath } = await packToTemporaryPackageDir(
		cwd,
		options.tarballPath,
	);
	/** @type {AgentSession | undefined} */
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
		const sessionManager = SessionManager.create(packageDir, tempAgentDir);
		sessionManager.appendMessage({
			role: "user",
			content: "Run the packaged smoke.",
			timestamp: Date.now(),
		});
		const result = await createAgentSession({
			agentDir: tempAgentDir,
			cwd: packageDir,
			noTools: "builtin",
			resourceLoader,
			sessionManager,
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
				executePackagedAgentBrowserSmoke(result.session.agent.state.tools),
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
		if (tempAgentDir !== undefined) {
			await rm(tempAgentDir, { force: true, recursive: true });
		}
	}
}
