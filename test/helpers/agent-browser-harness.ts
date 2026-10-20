/**
 * Purpose: Provide shared test harness utilities for the pi-agent-browser extension test suites.
 * Responsibilities: Build fake pi extension contexts, run registered extension events/tools, patch process env safely, create fake agent-browser binaries, read invocation logs, and manage child-process fixtures.
 * Scope: Test-only utilities for `test/agent-browser.*.test.ts`; production code must not import this module.
 * Usage: Import focused helpers from `./helpers/agent-browser-harness.js` inside Node test-runner suites.
 * Invariants/Assumptions: Helpers preserve caller-owned cleanup responsibilities and restore patched environment variables after each run. `writeFakeAgentBrowserBinary` installs a Unix shell-script launcher or a Windows `agent-browser.cmd`; its default virtual daemon retains launch/close and process-generation metadata. Stateful daemon tests set `PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO=1`; spawn/PATHEXT behavior still needs a real Windows runner.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath as nodeExecPath, platform as processPlatform } from "node:process";

import type {
	ExtensionAPI,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

import agentBrowserExtension from "../../extensions/agent-browser/index.js";
import { TARGET_AGENT_BROWSER_VERSION_LABEL } from "../../scripts/agent-browser-target.mjs";
import { hasErrorCode } from "./assertions.js";

// Fixtures use their own Pi identity. Root-default tests can opt into delegation explicitly.
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_SUBAGENT_ROOT_SESSION_ID;
delete process.env.PI_SESSION_ID;

// Stable across this file worker's harness/resume instances, distinct from unrelated parallel
// workers. Native Windows root browsers key off the Pi ID, not the fixture cwd/socket root.
export const TEST_SESSION_ID = randomUUID();
export const DOWNLOAD_FIXTURE_CONTENT = "download contract fixture report\n";
export const DOWNLOAD_FIXTURE_FILENAME = "pi-agent-browser-wait-download-contract.txt";
const journalFixtures = mkdtempSync(join(tmpdir(), "piab-journal-fixtures-"));
process.once("exit", () => rmSync(journalFixtures, { recursive: true, force: true }));

// macOS caps Unix socket paths at 103 characters, and realpath-canonicalized CI temp roots can push
// mkdtemp()-based socket directories past that cap. Host browser sockets in a short private 0700
// directory (production's own remediation guidance) instead; journal, state, and artifact roots stay
// wherever the fixture placed them. The literal /tmp prefix must stay unresolved so the path string
// itself stays short. Windows uses named pipes without a path cap, so it keeps the fixture root.
export function createShortPrivateSocketDir(fallbackRoot: string): string {
	if (process.platform !== "win32") {
		try {
			return mkdtempSync("/tmp/piab-s-");
		} catch {
			// Fall back to the fixture root when /tmp is unusable.
		}
	}
	return join(fallbackRoot, "s");
}

// File workers must not coordinate through the operator's live browser socket pool.
// PI_AGENT_BROWSER_SOCKET_DIR wins over inherited AGENT_BROWSER_SOCKET_DIR for owned and caller
// sessions; explicit per-call native env still wins. Keep caller-supplied PI overrides intact.
if (process.env.PI_AGENT_BROWSER_SOCKET_DIR === undefined) {
	const socketDir = createShortPrivateSocketDir(journalFixtures);
	mkdirSync(socketDir, { recursive: true, mode: 0o700 });
	process.env.PI_AGENT_BROWSER_SOCKET_DIR = socketDir;
	process.once("exit", () => rmSync(socketDir, { recursive: true, force: true }));
}

export interface FixtureServer {
	baseUrl: string;
	close: () => Promise<void>;
}

function sendFixtureHtml(response: ServerResponse, html: string): void {
	response.writeHead(200, {
		"cache-control": "no-store",
		"content-type": "text/html; charset=utf-8",
	});
	response.end(html);
}

export async function startAgentBrowserContractFixtureServer(): Promise<FixtureServer> {
	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (["/", "/contract"].includes(url.pathname)) {
			sendFixtureHtml(
				response,
				`<!doctype html>
<html lang="en">
<head>
	<title>Agent Browser Contract Fixture</title>
	<style>
		body { min-height: 2200px; }
		#drop-target { border: 2px dashed #666; margin-top: 1rem; padding: 1rem; }
		#far-target { margin-top: 1600px; }
		#contract-frame { width: 420px; height: 180px; border: 1px solid #999; }
	</style>
</head>
<body>
	<main id="main">
		<h1>Agent Browser Contract Fixture</h1>
		<p id="status">Ready for real upstream contract validation.</p>
		<a id="next-link" href="/next">Go to next fixture page</a>
		<button id="mark-ready" type="button" onclick="document.body.dataset.clicked='yes'; document.getElementById('status').textContent='Clicked';">Mark ready</button>
		<button id="double-action" type="button" ondblclick="document.getElementById('status').textContent='Double clicked';">Double action</button>
		<label for="name-input">Name</label>
		<input id="name-input" placeholder="Name input" />
		<input id="aria-label-input" aria-label="Codename" />
		<span id="alias-label">Alias Name</span>
		<input id="aria-labelledby-input" aria-labelledby="alias-label" />
		<label for="notes-input">Notes</label>
		<textarea id="notes-input"></textarea>
		<button id="focus-target" type="button" onfocus="document.body.dataset.focused='yes';">Focus target</button>
		<label><input id="agree-checkbox" type="checkbox" /> Agree to terms</label>
		<select id="flavor-select" aria-label="Flavor">
			<option value="vanilla">Vanilla</option>
			<option value="chocolate">Chocolate</option>
		</select>
		<input id="file-input" type="file" aria-label="Upload file" />
		<div id="drag-source" draggable="true" ondragstart="event.dataTransfer.setData('text/plain', 'fixture-dragged')">Drag source</div>
		<div id="drop-target" ondragover="event.preventDefault()" ondrop="event.preventDefault(); document.body.dataset.dropped=event.dataTransfer.getData('text/plain') || 'yes'; this.textContent='Dropped';">Drop target</div>
		<button id="hover-target" type="button" onmouseover="document.body.dataset.hovered='yes';">Hover target</button>
		<button id="keyboard-target" type="button" onclick="document.getElementById('name-input').focus();">Keyboard target</button>
		<div id="far-target" tabindex="0">Far scroll target</div>
		<button id="far-click-target" type="button" onclick="document.getElementById('status').textContent='Far clicked';">Far click target</button>
		<iframe id="contract-frame" src="/frame-child" title="Contract child frame"></iframe>
	</main>
</body>
</html>`,
			);
			return;
		}

		if (url.pathname === "/browser-regressions") {
			sendFixtureHtml(
				response,
				`<!doctype html><title>Browser regression fixture</title>
				<style>#panel { width:400px; height:200px; overflow:auto; scroll-behavior:smooth } #rows { height:2000px }</style>
				<a id="export" href="#" download="report.csv">Export report</a>
				<a id="static-download" href="/download-file" download="static.txt">Static report</a>
				<a id="redirect-download" href="/browser-download-redirect" download="redirect.txt">Redirected report</a>
				<button id="save" title="Save changes" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1); this.dataset.trusted=String(event.isTrusted)">Save</button>
				<button id="copy" aria-labelledby="copy-label" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Save</button><span id="copy-label">Save a copy</span>
				<button id="observe">Observe</button>
				<button id="frame-button">Main frame button</button>
				<iframe id="child-frame" src="/frame-child" title="Child frame"></iframe>
				<div id="panel"><div id="rows">Report table</div></div>
				<script>
					document.querySelector('#export').addEventListener('click', event => {
						event.preventDefault(); window.exportClicks=(window.exportClicks||0)+1;
						const a=document.createElement('a');
						a.href=URL.createObjectURL(new Blob(['name,total\\nAlice,42\\n'], {type:'text/csv'}));
						a.download='report.csv'; a.click();
					});
					fetch('/browser-regression-api?access_token=fixture-url-secret', {headers:{Authorization:'Bearer fixture-header-secret'}})
						.then(r=>r.json()).then(()=>document.body.dataset.ready='yes');
				</script>`,
			);
			return;
		}
		if (url.pathname === "/browser-download-redirect") {
			response.writeHead(302, { location: "/download-file" });
			response.end();
			return;
		}
		if (url.pathname === "/browser-regression-api") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end('{"ok":true}');
			return;
		}

		if (url.pathname === "/qa-error-residue") {
			sendFixtureHtml(
				response,
				`<!doctype html><title>Repeated error fixture</title>
				<h1>Repeated error fixture</h1><script>
				window.qaErrorsThrown = 0;
				const requested = sessionStorage.getItem("qa-error-count");
				const count = requested === "0" ? 0 : requested === "1" ? 1 : 1100;
				function raiseError() {
					window.qaErrorsThrown += 1;
					throw new Error("qa-repeat-error");
				}
				for (let i = 0; i < count; i++) setTimeout(raiseError, 0);
			</script>`,
			);
			return;
		}

		if (url.pathname === "/duplicate-buttons") {
			sendFixtureHtml(
				response,
				`<!doctype html><title>Duplicate buttons</title>
				<button id="first" onclick="this.dataset.clicks = String(Number(this.dataset.clicks || 0) + 1); this.dataset.trusted = String(event.isTrusted); this.textContent = 'Remove';">Add to cart</button>
				<button id="second" onclick="this.dataset.clicks = String(Number(this.dataset.clicks || 0) + 1); this.dataset.trusted = String(event.isTrusted); this.textContent = 'Remove';">Add to cart</button>`,
			);
			return;
		}

		if (url.pathname === "/headers") {
			sendFixtureHtml(
				response,
				`<title>Header Fixture</title><input id="header-value" value="${request.headers["x-fixture"] === "batch-fidelity" ? "present" : "missing"}" />`,
			);
			return;
		}

		if (url.pathname === "/frame-child") {
			sendFixtureHtml(
				response,
				`<!doctype html>
<html lang="en">
<head><title>Frame Child Contract Fixture</title></head>
<body>
	<main>
		<h1>Frame Child Contract Fixture</h1>
		<p id="frame-status">Frame ready</p>
		<button id="frame-button" type="button" onclick="document.getElementById('frame-status').textContent='Frame clicked';">Frame button</button>
	</main>
</body>
</html>`,
			);
			return;
		}

		if (url.pathname === "/next") {
			sendFixtureHtml(
				response,
				`<!doctype html>
<html lang="en">
<head><title>Next Contract Fixture</title></head>
<body><main><h1>Next Contract Fixture</h1><p>Navigation target.</p></main></body>
</html>`,
			);
			return;
		}

		if (url.pathname === "/webmcp") {
			sendFixtureHtml(
				response,
				`<!doctype html>
<html lang="en">
<head><title>WebMCP Contract Fixture</title></head>
<body>
	<main>
		<h1>WebMCP Contract Fixture</h1>
		<output id="webmcp-result">idle</output>
	</main>
	<script>
		if (document.modelContext) {
			document.modelContext.registerTool({
				name: "set_message",
				description: "Sets the visible fixture message",
				inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
				annotations: { readOnlyHint: false, untrustedContentHint: false },
				execute: async ({ message }) => {
					document.getElementById("webmcp-result").textContent = message;
					return { message };
				}
			});
			document.modelContext.registerTool({
				name: "wait_for_cancel",
				description: "Waits until the invocation is canceled",
				inputSchema: { type: "object", properties: {} },
				annotations: { readOnlyHint: true, untrustedContentHint: false },
				execute: async () => new Promise(() => {})
			});
		}
	</script>
</body>
</html>`,
			);
			return;
		}

		if (url.pathname === "/download") {
			sendFixtureHtml(
				response,
				`<!doctype html>
<html lang="en">
<head><title>Download Contract Fixture</title></head>
<body>
	<main>
		<h1>Download Contract Fixture</h1>
		<button id="delayed-download" type="button" onclick="setTimeout(() => { window.location.href = '/download-file'; }, 1000);">Export report</button>
		<button id="delayed-anchor-download" type="button" onclick="setTimeout(() => {
			const link = document.createElement('a');
			link.href = '/download-file';
			link.download = '${DOWNLOAD_FIXTURE_FILENAME}';
			document.body.appendChild(link);
			link.click();
			link.remove();
		}, 1000);">Export report with anchor</button>
		<a id="direct-download" href="/download-file" download="${DOWNLOAD_FIXTURE_FILENAME}">Direct report</a>
	</main>
</body>
</html>`,
			);
			return;
		}

		if (url.pathname === "/download-file") {
			response.writeHead(200, {
				"cache-control": "no-store",
				"content-disposition": `attachment; filename="${DOWNLOAD_FIXTURE_FILENAME}"`,
				"content-type": "text/plain; charset=utf-8",
			});
			response.end(DOWNLOAD_FIXTURE_CONTENT);
			return;
		}

		response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		response.end("not found");
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});

	const address = server.address();
	assert.ok(
		address !== null && typeof address === "object",
		"expected fixture server to bind to a local port",
	);
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		},
	};
}

export function buildUserBranch(prompt = ""): unknown[] {
	return prompt.length === 0
		? []
		: [{ type: "message", message: { role: "user", content: [{ type: "text", text: prompt }] } }];
}

export function createToolBranchEntry(options: {
	readonly details: Readonly<Record<string, unknown>>;
	readonly isError?: boolean;
}): unknown {
	return {
		type: "message",
		message: {
			isError: options.isError,
			details: options.details,
			toolName: "agent_browser",
		},
	};
}

export type AgentBrowserToolParams = {
	readonly code?: string;
	readonly args?: readonly string[];
	readonly semanticAction?: {
		readonly action: "check" | "click" | "fill" | "select";
		readonly locator?: "alt" | "label" | "placeholder" | "role" | "testid" | "text" | "title";
		readonly value?: string;
		readonly values?: readonly string[];
		readonly selector?: string;
		readonly text?: string;
		readonly role?: string;
		readonly name?: string;
		readonly session?: string;
	};
	readonly job?: {
		readonly steps: readonly {
			readonly action:
				| "open"
				| "click"
				| "fill"
				| "type"
				| "select"
				| "wait"
				| "assertText"
				| "assertUrl"
				| "waitForDownload"
				| "screenshot"
				| "snapshot";
			readonly url?: string;
			readonly loadState?: "domcontentloaded" | "load" | "networkidle";
			readonly selector?: string;
			readonly locator?: "alt" | "label" | "placeholder" | "role" | "testid" | "text" | "title";
			readonly role?: string;
			readonly name?: string;
			readonly text?: string;
			readonly value?: string;
			readonly values?: readonly string[];
			readonly path?: string;
			readonly delayMs?: number;
			readonly press?: string;
			readonly milliseconds?: number;
		}[];
	};
	readonly qa?:
		| {
				readonly attached: true;
				readonly expectedText?: string | readonly string[];
				readonly expectedSelector?: string;
				readonly screenshotPath?: string;
				readonly checkConsole?: boolean;
				readonly checkErrors?: boolean;
				readonly checkNetwork?: boolean;
		  }
		| {
				readonly attached?: false;
				readonly url: string;
				readonly expectedText?: string | readonly string[];
				readonly expectedSelector?: string;
				readonly screenshotPath?: string;
				readonly checkConsole?: boolean;
				readonly checkErrors?: boolean;
				readonly checkNetwork?: boolean;
		  };
	readonly sourceLookup?: {
		readonly selector?: string;
		readonly reactFiberId?: string;
		readonly componentName?: string;
		readonly includeDomHints?: boolean;
		readonly maxWorkspaceFiles?: number;
	};
	readonly networkSourceLookup?: {
		readonly filter?: string;
		readonly requestId?: string;
		readonly session?: string;
		readonly url?: string;
		readonly maxWorkspaceFiles?: number;
	};
	readonly electron?: {
		readonly action: "list" | "launch" | "status" | "cleanup" | "probe";
		readonly query?: string;
		readonly maxResults?: number;
		readonly appPath?: string;
		readonly appName?: string;
		readonly bundleId?: string;
		readonly executablePath?: string;
		readonly appArgs?: readonly string[];
		readonly handoff?: "connect" | "tabs" | "snapshot";
		readonly targetType?: "page" | "webview" | "any";
		readonly timeoutMs?: number;
		readonly allow?: readonly string[];
		readonly deny?: readonly string[];
		readonly launchId?: string;
		readonly all?: boolean;
	};
	readonly outputPath?: string;
	readonly sessionMode?: "auto" | "fresh";
	readonly stdin?: string;
	readonly timeoutMs?: number;
};

export interface AgentBrowserToolRenderContext {
	args: unknown;
	argsComplete: boolean;
	cwd: string;
	executionStarted: boolean;
	expanded: boolean;
	invalidate: () => void;
	isError: boolean;
	isPartial: boolean;
	lastComponent: Component | undefined;
	showImages: boolean;
	state: unknown;
	toolCallId: string;
}

const JSON_VALUE = Type.Cyclic(
	{
		Json: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("Json")),
			Type.Record(Type.String(), Type.Ref("Json")),
		]),
	},
	"Json",
);
const TOOL_RESULT = Type.Object({
	content: Type.Array(
		Type.Union([
			Type.Object({ type: Type.Literal("text"), text: Type.String() }),
			Type.Object({
				type: Type.Literal("image"),
				data: Type.String(),
				mimeType: Type.String(),
				text: Type.Optional(Type.String()),
			}),
		]),
	),
	details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	isError: Type.Optional(Type.Boolean()),
	structuredContent: Type.Optional(JSON_VALUE),
});
export type TestToolResult = Static<typeof TOOL_RESULT>;

export type RegisteredTool = {
	readonly description: string;
	readonly parameters: TSchema;
	readonly outputSchema?: ToolDefinition["outputSchema"];
	readonly namespace?: ToolDefinition["namespace"];
	readonly execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: ((update: unknown) => void) | undefined,
		ctx: unknown,
	) => Promise<TestToolResult>;
	readonly name: string;
	readonly promptGuidelines: readonly string[];
	readonly promptSnippet: string;
	readonly renderCall?: (args: unknown, theme: Theme, context: unknown) => Component;
	readonly renderResult?: (
		result: unknown,
		options: Readonly<ToolRenderResultOptions>,
		theme: Theme,
		context: unknown,
	) => Component;
};

function assertComponent(value: unknown): asserts value is Component {
	assert.ok(typeof value === "object" && value !== null, "expected a TUI component");
	assert.ok("render" in value && typeof value.render === "function", "expected component.render");
	assert.ok(
		"invalidate" in value && typeof value.invalidate === "function",
		"expected component.invalidate",
	);
	assert.ok(
		!("handleInput" in value) ||
			value.handleInput === undefined ||
			typeof value.handleInput === "function",
		"expected an optional component.handleInput callback",
	);
	assert.ok(
		!("handleMouse" in value) ||
			value.handleMouse === undefined ||
			typeof value.handleMouse === "function",
		"expected an optional component.handleMouse callback",
	);
	assert.ok(
		!("wantsKeyRelease" in value) ||
			value.wantsKeyRelease === undefined ||
			typeof value.wantsKeyRelease === "boolean",
		"expected an optional component.wantsKeyRelease flag",
	);
}

function adaptRegisteredTool<TParams extends TSchema, TDetails, TState>(
	tool: ToolDefinition<TParams, TDetails, TState>,
): RegisteredTool {
	const sourceRenderCall = tool.renderCall;
	const sourceRenderResult = tool.renderResult;

	return {
		description: tool.description,
		outputSchema: tool.outputSchema,
		namespace: tool.namespace,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			// Tests intentionally send invalid params and partial contexts to registered callbacks.
			// Dynamic invocation preserves that negative boundary; only the actual output is trusted.
			const result: unknown = await Reflect.apply(tool.execute.bind(tool), tool, [
				toolCallId,
				params,
				signal,
				onUpdate,
				ctx,
			]);
			assert.ok(Check(TOOL_RESULT, result), "registered tool returned an invalid result envelope");
			return result;
		},
		name: tool.name,
		parameters: tool.parameters,
		promptGuidelines: tool.promptGuidelines ?? [],
		promptSnippet: tool.promptSnippet ?? "",
		renderCall:
			sourceRenderCall === undefined
				? undefined
				: (args, theme, context) => {
						const result: unknown = Reflect.apply(sourceRenderCall, undefined, [
							args,
							theme,
							context,
						]);
						assertComponent(result);
						return result;
					},
		renderResult:
			sourceRenderResult === undefined
				? undefined
				: (result, options, theme, context) => {
						const rendered: unknown = Reflect.apply(sourceRenderResult, undefined, [
							result,
							options,
							theme,
							context,
						]);
						assertComponent(rendered);
						return rendered;
					},
	};
}

/** Mutable, caller-owned replay array shared with the harness's branch synchronization. */
export type FixtureBranch = unknown[];

export interface ExtensionHarnessOptions {
	// Live fixture-owned replay array: normalize in place so external append/fault tests stay visible.
	readonly branch?: FixtureBranch;
	readonly cwd: string;
	readonly onBusEvent?: (channel: string, request: unknown) => void;
	readonly onAppendEntry?: (customType: string, data: unknown) => void;
	readonly projectTrusted?: boolean;
	readonly prompt?: string;
	readonly sessionDir?: string;
	readonly sessionFile?: string | null;
	readonly sessionId?: string;
}
type HarnessHandler = (...args: readonly unknown[]) => unknown;
interface HarnessContext {
	readonly cwd: string;
	readonly isProjectTrusted: () => boolean;
	readonly sessionManager: {
		readonly getBranch: () => unknown[];
		readonly getEntries: () => unknown[];
		readonly getEntry: (id: string) => unknown;
		readonly getHeader: () => {
			type: string;
			version: number;
			id: string;
			cwd: string;
			timestamp: string;
		};
		readonly getLeafId: () => string | null;
		readonly buildSessionProjection: () => { messages: unknown[] };
		readonly getSessionDir: () => string | undefined;
		readonly getSessionFile: () => string | undefined;
		readonly getSessionId: () => string;
	};
}
export interface ExtensionHarness {
	readonly appendedEntries: Array<{ customType: string; data: unknown }>;
	readonly ctx: HarnessContext;
	readonly events: ExtensionAPI["events"];
	readonly getTool: (name: string) => RegisteredTool | undefined;
	readonly getActiveTools: () => string[];
	readonly handlers: Map<string, HarnessHandler[]>;
	readonly tools: Map<string, RegisteredTool>;
	readonly setBranch: (nextBranch: FixtureBranch) => void;
	readonly tool: RegisteredTool;
}
function entryId(value: unknown): string | undefined {
	return typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string"
		? value.id
		: undefined;
}
function unsupportedHarnessOperation(): never {
	throw new Error("This SDK operation is outside the focused extension harness");
}

export function createExtensionHarness(options: ExtensionHarnessOptions): ExtensionHarness {
	const handlers = new Map<string, Array<(...args: readonly unknown[]) => unknown>>();
	const registeredTools = new Map<string, RegisteredTool>();
	let activeTools: string[] = ["read", "bash"];
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const events = new EventEmitter();
	const sessionId = options.sessionId ?? TEST_SESSION_ID;
	const sessionFile =
		options.sessionFile === null
			? undefined
			: (options.sessionFile ?? join(journalFixtures, `${randomUUID()}.jsonl`));
	const header = {
		type: "session",
		version: 3,
		id: sessionId,
		cwd: options.cwd,
		timestamp: new Date().toISOString(),
	};
	const normalizeBranch = (entries = options.branch ?? buildUserBranch(options.prompt)) => {
		let parentId: string | null = null;
		const normalized = entries.map((value) => {
			if (typeof value !== "object" || value === null) {
				return value;
			}
			const entry = {
				...value,
				id: "id" in value && typeof value.id === "string" ? value.id : randomUUID(),
				parentId: "parentId" in value ? value.parentId : parentId,
				timestamp: "timestamp" in value ? value.timestamp : new Date().toISOString(),
			};
			parentId = entry.id;
			return entry;
		});
		entries.splice(0, entries.length);
		for (const entry of normalized) {
			entries.push(entry);
		}
		return entries;
	};
	let branch = normalizeBranch();
	const entries = [...branch];
	if (sessionFile !== undefined && sessionFile.length > 0) {
		mkdirSync(dirname(sessionFile), { recursive: true });
		writeFileSync(
			sessionFile,
			[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
			{ mode: 0o600 },
		);
	}
	const syncFixtureEntries = () => {
		const ids = new Set(entries.map(entryId));
		if (!branch.some((entry) => !ids.has(entryId(entry)))) {
			return;
		}
		normalizeBranch(branch);
		for (const entry of branch) {
			if (!ids.has(entryId(entry))) {
				ids.add(entryId(entry));
				entries.push(entry);
				if (sessionFile !== undefined && sessionFile.length > 0) {
					appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
				}
			}
		}
	};

	const pi: ExtensionAPI &
		Readonly<
			Record<"refreshTools" | "registerProviderAuthFallback", typeof unsupportedHarnessOperation>
		> = {
		refreshTools: unsupportedHarnessOperation,
		registerProviderAuthFallback: unsupportedHarnessOperation,
		registerCommand: unsupportedHarnessOperation,
		registerShortcut: unsupportedHarnessOperation,
		registerFlag: unsupportedHarnessOperation,
		getFlag: unsupportedHarnessOperation,
		registerMessageRenderer: unsupportedHarnessOperation,
		registerMarkdownTransformer: unsupportedHarnessOperation,
		registerEntryRenderer: unsupportedHarnessOperation,
		registerToolRenderer: unsupportedHarnessOperation,
		sendMessage: unsupportedHarnessOperation,
		sendUserMessage: unsupportedHarnessOperation,
		setSessionName: unsupportedHarnessOperation,
		getSessionName: unsupportedHarnessOperation,
		setLabel: unsupportedHarnessOperation,
		exec: unsupportedHarnessOperation,
		getSettings: unsupportedHarnessOperation,
		setModel: unsupportedHarnessOperation,
		getThinkingLevel: unsupportedHarnessOperation,
		setThinkingLevel: unsupportedHarnessOperation,
		registerProvider: unsupportedHarnessOperation,
		unregisterProvider: unsupportedHarnessOperation,
		registerMcpServer: unsupportedHarnessOperation,
		unregisterMcpServer: unsupportedHarnessOperation,
		getMcpServers: unsupportedHarnessOperation,
		registerVirtualModel: unsupportedHarnessOperation,
		unregisterVirtualModel: unsupportedHarnessOperation,
		events: {
			emit(channel, request) {
				options.onBusEvent?.(channel, request);
				events.emit(channel, request);
			},
			on(channel, handler) {
				events.on(channel, handler);
				return () => {
					events.off(channel, handler);
				};
			},
		},
		getCommands: () => [],
		getActiveTools() {
			return [...activeTools];
		},
		getAllTools() {
			return [...registeredTools.values()].map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				promptGuidelines: [...tool.promptGuidelines],
				namespace: tool.namespace,
				outputSchema: tool.outputSchema,
				id: tool.name,
				exposure: "direct",
				sourceInfo: {
					path: "test",
					source: "test",
					scope: "temporary",
					origin: "top-level",
				},
			}));
		},
		setActiveTools(names) {
			activeTools = [...names];
		},
		appendEntry(customType, data) {
			syncFixtureEntries();
			appendedEntries.push({ customType, data });
			const entry = {
				type: "custom",
				customType,
				data,
				id: randomUUID(),
				parentId: entryId(branch.at(-1)) ?? null,
				timestamp: new Date().toISOString(),
			};
			branch.push(entry);
			entries.push(entry);
			options.onAppendEntry?.(customType, data);
			if (sessionFile !== undefined && sessionFile.length > 0) {
				appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
			}
		},
		on(event, handler) {
			const existingHandlers = handlers.get(event) ?? [];
			const registeredHandler = (...args: readonly unknown[]): unknown =>
				Reflect.apply(handler, undefined, args);
			existingHandlers.push(registeredHandler);
			handlers.set(event, existingHandlers);
			return () => {
				handlers.set(
					event,
					existingHandlers.filter((candidate) => candidate !== registeredHandler),
				);
			};
		},
		registerTool(tool) {
			const registeredTool = adaptRegisteredTool(tool);
			registeredTools.set(registeredTool.name, registeredTool);
			activeTools.push(registeredTool.name);
		},
	};
	agentBrowserExtension(pi);

	const registeredTool = registeredTools.get("agent_browser");
	assert.ok(registeredTool, "expected the extension to register the agent_browser tool");

	const sessionDir =
		options.sessionDir ??
		(typeof options.sessionFile === "string" && options.sessionFile.length > 0
			? dirname(options.sessionFile)
			: undefined);
	const ctx = {
		cwd: options.cwd,
		isProjectTrusted: () => options.projectTrusted ?? true,
		sessionManager: {
			getBranch: () => {
				syncFixtureEntries();
				return branch;
			},
			getEntries: () => {
				syncFixtureEntries();
				return entries;
			},
			getEntry: (id: string) => {
				syncFixtureEntries();
				return entries.find(
					(entry) =>
						typeof entry === "object" && entry !== null && "id" in entry && entry.id === id,
				);
			},
			getHeader: () => header,
			getLeafId: () => {
				syncFixtureEntries();
				return entryId(branch.at(-1)) ?? null;
			},
			buildSessionProjection: () => ({
				messages: branch.flatMap((entry) =>
					typeof entry === "object" &&
					entry !== null &&
					"type" in entry &&
					entry.type === "message" &&
					"message" in entry
						? [entry.message]
						: [],
				),
			}),
			getSessionDir: () => sessionDir,
			getSessionFile: () => sessionFile,
			getSessionId: () => sessionId,
		},
	} as const;

	return {
		appendedEntries,
		ctx,
		events: pi.events,
		getTool(name: string): RegisteredTool | undefined {
			return registeredTools.get(name);
		},
		getActiveTools: (): string[] => [...activeTools],
		handlers,
		tools: registeredTools,
		setBranch(nextBranch): void {
			branch = normalizeBranch(nextBranch);
			syncFixtureEntries();
		},
		tool: registeredTool,
	};
}

export async function runExtensionEvent(
	handlers: ReadonlyMap<string, readonly HarnessHandler[]>,
	eventName: string,
	...args: readonly unknown[]
): Promise<void> {
	for (const handler of handlers.get(eventName) ?? []) {
		// Registered handlers share event/context state and must execute in registration order.
		// oxlint-disable-next-line no-await-in-loop
		await handler(...args);
	}
}

export async function getBrowserInstructions(harness: {
	readonly handlers: ReadonlyMap<string, readonly HarnessHandler[]>;
	readonly ctx: unknown;
}): Promise<string> {
	const event: {
		prompt: string;
		systemPromptOptions: { sections: Partial<Record<string, string>> };
	} = {
		prompt: "Please continue.",
		systemPromptOptions: { sections: {} },
	};
	await runExtensionEvent(harness.handlers, "before_agent_start", event, harness.ctx);
	return event.systemPromptOptions.sections.agent_browser ?? "";
}

export async function runExtensionEventResults(
	handlers: ReadonlyMap<string, readonly HarnessHandler[]>,
	eventName: string,
	...args: readonly unknown[]
): Promise<unknown[]> {
	const results: unknown[] = [];
	for (const handler of handlers.get(eventName) ?? []) {
		// Result handlers must observe preceding handler mutations.
		// oxlint-disable-next-line no-await-in-loop
		const result = await handler(...args);
		if (result !== undefined) {
			results.push(result);
		}
	}
	return results;
}

export async function executeRegisteredTool(
	tool: Readonly<RegisteredTool>,
	ctx: unknown,
	params: unknown,
	signal: AbortSignal = new AbortController().signal,
): Promise<TestToolResult> {
	return await tool.execute("test-tool-call", params, signal, undefined, ctx);
}

const patchedEnvScope = new AsyncLocalStorage<boolean>();
let patchedEnvQueue: Promise<void> = Promise.resolve();

async function runWithPatchedEnv<T>(
	patch: Readonly<Record<string, string | undefined>>,
	run: () => Promise<T>,
): Promise<T> {
	const previousValues = new Map<string, string | undefined>();
	for (const [name, value] of Object.entries(patch)) {
		previousValues.set(name, process.env[name]);
		if (value === undefined) {
			delete process.env[name];
		} else if (
			processPlatform === "win32" &&
			name.toLowerCase() === "path" &&
			(previousValues.get(name)?.length ?? 0) > 0
		) {
			const previousPath = previousValues.get(name) ?? "";
			const posixStyleSuffix = `:${previousPath}`;
			process.env[name] = value.endsWith(posixStyleSuffix)
				? `${value.slice(0, -posixStyleSuffix.length)};${previousPath}`
				: value;
		} else {
			process.env[name] = value;
		}
	}

	try {
		return await run();
	} finally {
		for (const [name, value] of previousValues) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
	}
}

export async function withPatchedEnv<T>(
	patch: Readonly<Record<string, string | undefined>>,
	run: () => Promise<T>,
): Promise<T> {
	if (patchedEnvScope.getStore() === true) {
		return await runWithPatchedEnv(patch, run);
	}

	const queuedRun = patchedEnvQueue.then(() =>
		patchedEnvScope.run(true, () => runWithPatchedEnv(patch, run)),
	);
	patchedEnvQueue = queuedRun.then(
		() => {
			/* Queue tracks completion only; the caller owns the actual result. */ return;
		},
		() => {
			/* The original queuedRun rejection is returned to its caller below. */ return;
		},
	);
	return await queuedRun;
}

/** Fake script body that spawns a detached descendant inheriting stdio (stdio-linger regressions). */
export function buildStdioLingerFakeScript(options: { readonly afterSpawnBody: string }): string {
	return `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const linger = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 10000); setInterval(() => undefined, 1000);"], {
	cwd: tmpdir(),
	detached: true,
	stdio: ["ignore", "inherit", "inherit"],
});
writeFileSync(process.env.PI_AGENT_BROWSER_TEST_LINGER_PID_PATH, String(linger.pid));
linger.unref();
${options.afterSpawnBody}`;
}

export async function writeFakeAgentBrowserBinary(
	tempDir: string,
	scriptBody: string,
	platform: NodeJS.Platform = processPlatform,
): Promise<string> {
	// The virtual daemon belongs to this fixture owner, not Windows' per-invocation cmd.exe parent.
	const defaultSessionInfo = `if (process.env.PI_AGENT_BROWSER_TEST_PRESERVE_INTERNAL_LAUNCH_FLAGS !== "1") {
  const rawArgsIndex = process.argv.indexOf("--args");
  if (rawArgsIndex >= 0 && ["", "--no-startup-window"].includes(process.argv[rawArgsIndex + 1])) process.argv.splice(rawArgsIndex, 2);
  const fileAccessIndex = process.argv.indexOf("--allow-file-access");
  if (fileAccessIndex >= 0 && process.argv[fileAccessIndex + 1] === "false") process.argv.splice(fileAccessIndex, 2);
}
const __piabFakeArgs = process.argv.slice(2);
const __piabFs = require("node:fs");
const __piabRuntimeRoot = ${JSON.stringify(tempDir)};
const __piabSession = __piabFakeArgs.includes("--session") ? __piabFakeArgs[__piabFakeArgs.indexOf("--session")+1] : process.env.AGENT_BROWSER_SESSION || "default";
const __piabNamespace = (__piabFakeArgs.includes("--namespace") ? __piabFakeArgs[__piabFakeArgs.indexOf("--namespace")+1] : process.env.AGENT_BROWSER_NAMESPACE || "").toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const __piabKey = require('node:crypto').createHash('sha256').update(JSON.stringify([__piabNamespace, __piabSession])).digest('hex');
const __piabRuntimePath = require('node:path').join(__piabRuntimeRoot, 'fake-daemon-' + __piabKey + '.json');
let __piabRuntime; try { __piabRuntime = JSON.parse(__piabFs.readFileSync(__piabRuntimePath, "utf8")); } catch {}
const __piabWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  try {
    const reply = JSON.parse(String(chunk));
    const info = __piabFakeArgs.includes("session") && __piabFakeArgs.includes("info");
    if (!info && reply.success === true && __piabFakeArgs.some(arg => ["open","get","snapshot","eval","click","fill","batch","screenshot","record","connect","close","quit","exit"].includes(arg))) {
      const closed = __piabFakeArgs.some(arg => ["close","quit","exit"].includes(arg)) && !__piabFakeArgs.includes("batch");
      __piabRuntime = closed ? { active: false, runtime: null } : { active: true, runtime: {
        restoreKey: process.env.AGENT_BROWSER_RESTORE || null, backgroundPid: ${process.pid}, socketDir: "test-fixture-runtime", browserLaunched: true
      }};
      __piabFs.writeFileSync(__piabRuntimePath, JSON.stringify(__piabRuntime), { mode: 0o600 });
    }
  } catch {}
  return __piabWrite(chunk, ...rest);
};
if (process.env.PI_AGENT_BROWSER_TEST_CUSTOM_VERSION !== "1" && __piabFakeArgs.includes("--version")) {
  process.stdout.write(${JSON.stringify(`${TARGET_AGENT_BROWSER_VERSION_LABEL}\n`)});
  process.exit(0);
}
if (process.env.PI_AGENT_BROWSER_TEST_PAGE_URL && __piabFakeArgs.at(-2) === "get" && __piabFakeArgs.at(-1) === "url") {
  process.stdout.write(JSON.stringify({ success: true, data: { url: process.env.PI_AGENT_BROWSER_TEST_PAGE_URL } }));
  process.exit(0);
}
if (process.env.PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO !== "1" && __piabFakeArgs.includes("session") && __piabFakeArgs.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: __piabRuntime || { active: false, runtime: null } }));
  process.exit(0);
}`;
	const wrappedScriptBody = `${defaultSessionInfo}\n${scriptBody}`;
	const scriptPath = join(tempDir, "agent-browser-fake.cjs");
	await writeFile(scriptPath, `${wrappedScriptBody}\n`, "utf8");

	if (platform === "win32") {
		const launcherPath = join(tempDir, "agent-browser.cmd");
		await writeFile(
			launcherPath,
			`@ECHO OFF\r\n"${nodeExecPath.replaceAll('"', '""')}" "${scriptPath.replaceAll('"', '""')}" %*\r\n`,
			"utf8",
		);
		return launcherPath;
	}

	const fakeAgentBrowserPath = join(tempDir, "agent-browser");
	await writeFile(fakeAgentBrowserPath, `#!/usr/bin/env node\n${wrappedScriptBody}\n`, "utf8");
	await chmod(fakeAgentBrowserPath, 0o755);
	return fakeAgentBrowserPath;
}

const NULLABLE_LOG_STRING = Type.Optional(Type.Union([Type.String(), Type.Null()]));
const INVOCATION_LOG_ENTRY = Type.Object({
	agentcoreApiKey: NULLABLE_LOG_STRING,
	apiKey: NULLABLE_LOG_STRING,
	args: Type.Array(Type.String()),
	autosave: NULLABLE_LOG_STRING,
	browserbaseApiKey: NULLABLE_LOG_STRING,
	browserlessApiKey: NULLABLE_LOG_STRING,
	browserUseApiKey: NULLABLE_LOG_STRING,
	confirmActions: NULLABLE_LOG_STRING,
	defaultTimeout: NULLABLE_LOG_STRING,
	event: Type.Optional(Type.String()),
	idleTimeout: NULLABLE_LOG_STRING,
	iosDevice: NULLABLE_LOG_STRING,
	kernelApiKey: NULLABLE_LOG_STRING,
	model: NULLABLE_LOG_STRING,
	sessionName: Type.Optional(Type.String()),
	socketDir: NULLABLE_LOG_STRING,
	stdin: NULLABLE_LOG_STRING,
});
export type InvocationLogEntry = Static<typeof INVOCATION_LOG_ENTRY>;
function parseInvocationLogEntry(value: unknown): InvocationLogEntry {
	assert.ok(Check(INVOCATION_LOG_ENTRY, value), "invalid fake-upstream invocation log entry");
	return value;
}

export async function readInvocationLog(logPath: string): Promise<InvocationLogEntry[]> {
	try {
		const text = await readFile(logPath, "utf8");
		return text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => parseInvocationLogEntry(JSON.parse(line)));
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return [];
		}
		throw error;
	}
}

export async function readChildStdoutJsonLine(
	child: ReturnType<typeof spawn>,
	timeoutMs = 15_000,
): Promise<unknown> {
	assert.ok(child.stdout, "expected child stdout pipe");
	assert.ok(child.stderr, "expected child stderr pipe");
	let stdout = "";
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	return await new Promise<unknown>((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(
				new Error(
					`Timed out waiting for child stdout JSON line. stdout=${stdout} stderr=${stderr}`,
				),
			);
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
			const firstLine = stdout.split("\n").find((line) => line.trim().length > 0);
			if (firstLine === undefined || firstLine.length === 0) {
				return;
			}
			clearTimeout(timeout);
			try {
				const value: unknown = JSON.parse(firstLine);
				resolve(value);
			} catch (error) {
				reject(
					error instanceof Error ? error : new Error("Failed parsing child JSON", { cause: error }),
				);
			}
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			reject(
				new Error(
					`Child exited before stdout JSON line: code=${String(code)} signal=${String(signal)} stdout=${stdout} stderr=${stderr}`,
				),
			);
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
}

export async function stopChildProcess(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	child.kill("SIGTERM");
	const timeout = setTimeout(() => {
		child.kill("SIGKILL");
	}, 2_000);
	try {
		await once(child, "exit");
	} finally {
		clearTimeout(timeout);
	}
}
