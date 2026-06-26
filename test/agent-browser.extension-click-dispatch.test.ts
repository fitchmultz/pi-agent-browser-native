/**
 * Purpose: Verify click-dispatch probe diagnostics and lifecycle cleanup for the pi-agent-browser extension.
 * Responsibilities: Assert click-dispatch probes report success-only diagnostics and clean up after failed clicks.
 * Scope: Integration-style Node test-runner coverage with fake agent-browser binaries.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

test("agentBrowserExtension cleans up click dispatch probes after failed clicks", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-click-dispatch-failure-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("eval")) {
  if (stdin.includes("window[marker] = state")) {
    process.stdout.write(JSON.stringify({ success: true, data: { result: { status: "installed" } } }));
  } else if (stdin.includes("cleaned-up")) {
    process.stdout.write(JSON.stringify({ success: true, data: { result: { status: "cleaned-up" } } }));
  } else {
    process.stdout.write(JSON.stringify({ success: true, data: { result: { status: "unexpected" } } }));
  }
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "file:///tmp/fixture.html", refs: { e1: { role: "button", name: "Save" } }, snapshot: '- button "Save" [ref=e1]' } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: false, error: "click failed" }));
  process.exit(2);
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			const click = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(click.isError, true);
			assert.equal(click.details?.clickDispatch, undefined);

			const invocations = await readInvocationLog(logPath);
			const evalInvocations = invocations.filter((entry) => entry.args.includes("eval"));
			assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 1);
			assert.ok(evalInvocations.some((entry) => (entry.stdin ?? "").includes("window[marker] = state")));
			assert.ok(evalInvocations.some((entry) => (entry.stdin ?? "").includes("cleaned-up")));
			assert.equal(evalInvocations.some((entry) => (entry.stdin ?? "").includes("no-native-event-observed")), false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension cleans up click dispatch probes during successful dispatch checks", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-click-dispatch-success-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("eval")) {
  if (stdin.includes("window[marker] = state")) {
    process.stdout.write(JSON.stringify({ success: true, data: { result: { status: "installed" } } }));
  } else if (stdin.includes("native-event-observed")) {
    process.stdout.write(JSON.stringify({ success: true, data: { result: { status: "native-event-observed", nativeEventCount: 1 } } }));
  } else if (stdin.includes("cleaned-up")) {
    process.stdout.write(JSON.stringify({ success: true, data: { result: { status: "cleaned-up" } } }));
  } else {
    process.stdout.write(JSON.stringify({ success: true, data: { result: { status: "unexpected" } } }));
  }
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "file:///tmp/fixture.html", refs: { e1: { role: "button", name: "Save" } }, snapshot: '- button "Save" [ref=e1]' } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args[args.length - 1] } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			const click = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(click.isError, false);
			assert.equal(click.details?.clickDispatch, undefined);

			const invocations = await readInvocationLog(logPath);
			const checkInvocation = invocations.find((entry) => entry.args.includes("eval") && (entry.stdin ?? "").includes("native-event-observed"));
			assert.ok(checkInvocation, "expected a click dispatch check eval");
			assert.ok((checkInvocation.stdin ?? "").includes("state.cleanup"));
			assert.ok((checkInvocation.stdin ?? "").includes("delete window[marker]"));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension probes ref clicks with current snapshot accessibility metadata", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-click-dispatch-ref-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "file:///tmp/fixture.html",
    refs: { e4: { role: "button", name: "RPS (3)" } },
    snapshot: '- button "RPS (3)" [ref=e4]'
  } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args[args.length - 1] } }));
} else if (args.includes("eval")) {
  if (stdin.includes("expectedRole") && stdin.includes("RPS (3)") && stdin.includes("window[marker] = state")) {
    process.stdout.write(JSON.stringify({ success: true, data: { result: { status: "installed" } } }));
  } else if (stdin.includes("no-native-event-observed")) {
    process.stdout.write(JSON.stringify({ success: true, data: { result: { status: "no-native-event-observed", nativeEventCount: 0 } } }));
  } else {
    process.stdout.write(JSON.stringify({ success: true, data: { result: { title: "Fixture", url: "file:///tmp/fixture.html" } } }));
  }
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false);

			const click = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e4"] });
			assert.equal(click.isError, true);
			assert.match((click.content[0] as { text: string }).text, /Click dispatch diagnostic:/);
			assert.deepEqual((click.details?.clickDispatch as { target?: unknown } | undefined)?.target, {
				kind: "accessible",
				name: "RPS (3)",
				refId: "e4",
				role: "button",
			});

			const invocations = await readInvocationLog(logPath);
			assert.ok(invocations.some((entry) => entry.args.includes("eval") && (entry.stdin ?? "").includes("expectedRole") && (entry.stdin ?? "").includes("RPS (3)")));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension probes duplicate-name ref clicks with snapshot order", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-click-dispatch-duplicate-ref-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://shop.example/inventory",
    refs: {
      e1: { role: "button", name: "Add to cart" },
      e2: { role: "button", name: "Add to cart" }
    },
    snapshot: '- button "Add to cart" [ref=e1]\\n- button "Add to cart" [ref=e2]'
  } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args[args.length - 1] } }));
} else if (args.includes("eval")) {
  if (stdin.includes("window[marker] = state")) {
    process.stdout.write(JSON.stringify({ success: true, data: { result: { status: "installed" } } }));
  } else if (stdin.includes("no-native-event-observed")) {
    process.stdout.write(JSON.stringify({ success: true, data: { result: { status: "no-native-event-observed", nativeEventCount: 0 } } }));
  } else {
    process.stdout.write(JSON.stringify({ success: true, data: { result: { title: "Shop", url: "https://shop.example/inventory" } } }));
  }
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false);

			const click = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e2"] });
			assert.equal(click.isError, true);
			assert.deepEqual((click.details?.clickDispatch as { target?: unknown } | undefined)?.target, {
				duplicateIndex: 1,
				kind: "accessible",
				name: "Add to cart",
				refId: "e2",
				role: "button",
			});

			const invocations = await readInvocationLog(logPath);
			const installInvocation = invocations.find((entry) => entry.args.includes("eval") && (entry.stdin ?? "").includes("window[marker] = state"));
			assert.ok(installInvocation, "expected a click dispatch install eval");
			const installScript = installInvocation.stdin ?? "";
			assert.ok(installScript.includes("duplicateIndex"));
			assert.match(installScript, /(?:const|let|var)?\s*duplicateIndex\s*=\s*1\b|"duplicateIndex"\s*:\s*1\b/);
			assert.ok(installScript.includes("candidates[duplicateIndex]"));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension does not run click-dispatch probes for unresolved find locators", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-click-dispatch-find-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { status: "no-native-event-observed", nativeEventCount: 0 } } }));
} else if (args.includes("find")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "[data-agent-browser-located='true']" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const click = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["find", "text", "Add to cart", "click"] });
			assert.equal(click.isError, false);
			assert.equal(click.details?.clickDispatch, undefined);
			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.some((entry) => entry.args.includes("eval") && (entry.stdin ?? "").includes("window[marker] = state")), false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports click dispatch diagnostic when upstream reports success without dispatching DOM events", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-click-dispatch-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://shop.example/inventory",
    refs: {
      e1: { role: "button", name: "Add to cart" },
      e2: { role: "button", name: "Add to cart" }
    },
    snapshot: '- button "Add to cart" [ref=e1]\\n- button "Add to cart" [ref=e2]'
  } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args[args.length - 1] } }));
} else if (args.includes("eval")) {
  if (stdin.includes("window[marker] = state")) {
    process.stdout.write(JSON.stringify({ success: true, data: { result: { status: "installed" } } }));
  } else if (stdin.includes("no-native-event-observed")) {
    process.stdout.write(JSON.stringify({ success: true, data: { result: { status: "no-native-event-observed", nativeEventCount: 0, target: { nearestScrollContainer: { selector: "#todos", targetOutsideContainer: true, targetOutsideViewport: true }, targetOutsideViewport: true } } } }));
  } else {
    process.stdout.write(JSON.stringify({ success: true, data: { result: { title: "Shop", url: "https://shop.example/inventory" } } }));
  }
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			const click = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(click.isError, true);
			assert.match((click.content[0] as { text: string }).text, /Click dispatch diagnostic:/);
			assert.equal((click.details?.clickDispatch as { status?: string } | undefined)?.status, "no-native-event-observed");
			assert.equal((click.details?.clickDispatch as { target?: { kind?: string; refId?: string } } | undefined)?.target?.kind, "accessible");
			assert.equal((click.details?.clickDispatch as { target?: { kind?: string; refId?: string } } | undefined)?.target?.refId, "e1");
			assert.deepEqual((click.details?.clickDispatch as { scrollContainer?: unknown } | undefined)?.scrollContainer, {
				selector: "#todos",
				summary: "Target appears outside nested scroll container #todos; use scrollintoview on the target or scroll that container before retrying.",
				targetOutsideContainer: true,
				targetOutsideViewport: true,
			});
			assert.match(click.content[0]?.text ?? "", /nested scroll container #todos/);
			const nextActionIds = ((click.details?.nextActions as Array<{ id?: string }> | undefined) ?? []).map((action) => action.id);
			assert.ok(nextActionIds.includes("scroll-target-into-view-after-dispatch-miss"));
			assert.ok(nextActionIds.includes("retry-click-after-dispatch-miss"));

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 1);
			assert.ok(invocations.some((entry) => entry.args.includes("eval") && (entry.stdin ?? "").includes("window[marker] = state")));
			const checkInvocation = invocations.find((entry) => entry.args.includes("eval") && (entry.stdin ?? "").includes("no-native-event-observed"));
			assert.ok(checkInvocation, "expected a click dispatch check eval");
			assert.ok((checkInvocation.stdin ?? "").includes("state.cleanup"));
			assert.ok((checkInvocation.stdin ?? "").includes("delete window[marker]"));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
