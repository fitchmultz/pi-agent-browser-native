import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveOperationPaths } from "../extensions/agent-browser/lib/orchestration/operation-paths.js";
import { getUpstreamEffectiveBatchSteps } from "../extensions/agent-browser/lib/orchestration/batch-stdin.js";

const cwd = resolve("operation workspace");

test("operation paths bind only native file operands, preserving literals and absolute paths", () => {
	const cases: Array<[string[], string[]]> = [
		[["screenshot", "#target", "images/a.png", "--full"], ["screenshot", "#target", join(cwd, "images/a.png"), "--full"]],
		[["download", "same.bin", "same.bin"], ["download", "same.bin", join(cwd, "same.bin")]],
		[["pdf", "report.pdf"], ["pdf", join(cwd, "report.pdf")]],
		[["record", "start", "--fps", "24", "--contact-sheet", "take.webm"], ["record", "start", "--fps", "24", "--contact-sheet", join(cwd, "take.webm")]],
		[["record", "stop"], ["record", "stop"]],
		[["record", "restart", "--contact-sheet-threshold", "0.4", "next.webm"], ["record", "restart", "--contact-sheet-threshold", "0.4", join(cwd, "next.webm")]],
		[["wait", "--download", "--timeout", "3000", "export.csv"], ["wait", "--download", "--timeout", "3000", join(cwd, "export.csv")]],
		[["upload", "#upload", "one.txt", "two.txt"], ["upload", "#upload", join(cwd, "one.txt"), join(cwd, "two.txt")]],
		[["state", "save", "state.json"], ["state", "save", join(cwd, "state.json")]],
		[["state", "load", "state.json"], ["state", "load", join(cwd, "state.json")]],
		[["state", "show", "saved-identity"], ["state", "show", "saved-identity"]],
		[["trace", "stop", "trace.json"], ["trace", "stop", join(cwd, "trace.json")]],
		[["profiler", "stop", "cpu.json"], ["profiler", "stop", join(cwd, "cpu.json")]],
		[["network", "har", "stop", "network.har"], ["network", "har", "stop", join(cwd, "network.har")]],
		[["network", "har", "start", "ignored.har"], ["network", "har", "start", "ignored.har"]],
		[["diff", "screenshot", "--baseline", "old.png", "--output", "diff.png"], ["diff", "screenshot", "--baseline", join(cwd, "old.png"), "--output", join(cwd, "diff.png")]],
		[["diff", "screenshot", "--selector", "--baseline", "--baseline", "old.png"], ["diff", "screenshot", "--selector", "--baseline", "--baseline", join(cwd, "old.png")]],
		[["cookies", "set", "--curl", "cookies.txt"], ["cookies", "set", "--curl", join(cwd, "cookies.txt")]],
		[["cookies", "set", "name", "value", "--path", "/"], ["cookies", "set", "name", "value", "--path", "/"]],
		[["webmcp", "invoke", "search", "--params", "@data.json"], ["webmcp", "invoke", "search", "--params", "@" + join(cwd, "data.json")]],
		[["webmcp", "invoke", "search", "--params", '{"query":"@data.json"}'], ["webmcp", "invoke", "search", "--params", '{"query":"@data.json"}']],
		[["fill", "#field", "relative.txt"], ["fill", "#field", "relative.txt"]],
		[["--profile", "Default", "--init-script", "init.js", "--state", "state.json", "get", "url"], ["--profile", "Default", "--init-script", join(cwd, "init.js"), "--state", join(cwd, "state.json"), "get", "url"]],
		[["--profile", "./profile", "get", "url"], ["--profile", join(cwd, "profile"), "get", "url"]],
		[["wait", "#button", "--state", "visible"], ["wait", "#button", "--state", "visible"]],
		[["--state", "state.json", "wait", "#button", "--state", "visible"], ["--state", join(cwd, "state.json"), "wait", "#button", "--state", "visible"]],
		[["--config", "native.json", "--session", "one", "get", "url"], ["--config", join(cwd, "native.json"), "--session", "one", "get", "url"]],
	];
	for (const [args, expected] of cases) {
		assert.deepEqual(resolveOperationPaths(args, undefined, cwd).args, expected, JSON.stringify(args));
		assert.deepEqual(resolveOperationPaths(expected, undefined, cwd).args, expected, "absolute paths are not rebased");
	}
});

test("raw and nested batch paths bind without dispatching ignored stdin or cleaning batch literals", () => {
	const ignored = JSON.stringify([["screenshot", "ignored.png"]]);
	const raw = resolveOperationPaths(["batch", "--bail", "download '#link' '--quiet' ignored.bin", "batch \"screenshot 'shot with spaces.png'\"", "fill '#field' 'relative.txt'"], ignored, cwd);
	assert.equal(raw.stdin, ignored);
	const rows = getUpstreamEffectiveBatchSteps(raw.args, raw.stdin);
	assert.deepEqual(rows[0], ["download", "#link", join(cwd, "--quiet"), "ignored.bin"]);
	assert.deepEqual(getUpstreamEffectiveBatchSteps(rows[1], undefined), [["screenshot", join(cwd, "shot with spaces.png")]]);
	assert.deepEqual(rows[2], ["fill", "#field", "relative.txt"]);
	const stdin = resolveOperationPaths(["batch"], JSON.stringify([["screenshot", "apostrophe's.png"], ["pdf", "--quick", "ignored.pdf"]]), cwd);
	assert.deepEqual(JSON.parse(stdin.stdin!), [["screenshot", join(cwd, "apostrophe's.png")], ["pdf", join(cwd, "--quick"), "ignored.pdf"]]);
	const blank = resolveOperationPaths(["batch", ""], ignored, cwd);
	assert.equal(blank.stdin, ignored, "an empty raw row still displaces stdin");
});
