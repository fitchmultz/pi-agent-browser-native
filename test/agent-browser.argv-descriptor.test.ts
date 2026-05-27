/**
 * Purpose: Verify argv descriptor parsing for current agent-browser command shapes.
 * Responsibilities: Assert command/subcommand extraction across representative command families and flag edge cases.
 * Scope: Unit-style Node test-runner coverage for pure argv-descriptor helpers.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseCommandInfo } from "../extensions/agent-browser/lib/argv-descriptor.js";

test("parseCommandInfo recognizes representative current command families", () => {
	for (const { args, expected } of [
		{ args: ["open", "https://example.com"], expected: { command: "open", subcommand: "https://example.com" } },
		{ args: ["find", "role", "button", "click", "--name", "Export"], expected: { command: "find", subcommand: "role" } },
		{ args: ["wait", "--download", "/tmp/report.csv", "--timeout", "25000"], expected: { command: "wait", subcommand: "--download" } },
		{ args: ["wait", "@button", "--state", "hidden"], expected: { command: "wait", subcommand: "@button" } },
		{ args: ["network", "route", "**/*.js", "--resource-type", "script"], expected: { command: "network", subcommand: "route" } },
		{ args: ["cookies", "set", "--curl", "/tmp/cookies.txt", "--domain", "example.com"], expected: { command: "cookies", subcommand: "set" } },
		{ args: ["auth", "save", "demo", "--password-stdin"], expected: { command: "auth", subcommand: "save" } },
		{ args: ["dashboard", "start", "--port", "4567"], expected: { command: "dashboard", subcommand: "start" } },
		{ args: ["doctor", "--offline", "--quick"], expected: { command: "doctor", subcommand: "--offline" } },
		{ args: ["install", "--with-deps"], expected: { command: "install", subcommand: "--with-deps" } },
		{ args: ["upgrade"], expected: { command: "upgrade", subcommand: undefined } },
		{ args: ["chat", "Summarize", "--model", "gpt-5.1"], expected: { command: "chat", subcommand: "Summarize" } },
		{ args: ["react", "renders", "stop", "--json"], expected: { command: "react", subcommand: "renders" } },
		{ args: ["vitals", "https://example.com", "--json"], expected: { command: "vitals", subcommand: "https://example.com" } },
		{ args: ["stream", "enable", "--port", "7777"], expected: { command: "stream", subcommand: "enable" } },
		{ args: ["tab", "new", "--label", "Docs", "https://example.com"], expected: { command: "tab", subcommand: "new" } },
	] as const) {
		assert.deepEqual(parseCommandInfo([...args]), expected);
	}
});

test("parseCommandInfo recognizes open targets after command-scoped init flags", () => {
	assert.deepEqual(parseCommandInfo(["open", "--enable", "react-devtools", "https://example.com"]), {
		command: "open",
		subcommand: "https://example.com",
	});
	assert.deepEqual(parseCommandInfo(["open", "--init-script", "/tmp/setup.js", "https://example.com"]), {
		command: "open",
		subcommand: "https://example.com",
	});
	assert.deepEqual(parseCommandInfo(["--enable", "react-devtools", "open", "https://example.com"]), {
		command: "open",
		subcommand: "https://example.com",
	});
});

test("parseCommandInfo skips optional boolean flag values before commands", () => {
	assert.deepEqual(parseCommandInfo(["--headed", "false", "open", "https://chatgpt.com"]), {
		command: "open",
		subcommand: "https://chatgpt.com",
	});
	assert.deepEqual(parseCommandInfo(["--debug", "true", "tab", "list"]), {
		command: "tab",
		subcommand: "list",
	});
});
