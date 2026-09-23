#!/usr/bin/env node
/**
 * Purpose: Run the Chrome relay sidecar — the opt-in server + extension pair that lets
 *          `agent-browser` drive the user's real, headed Chrome through chrome.debugger.
 * Responsibilities: Subcommands start/status/stop/token/extension-path; `start` runs the
 *                   relay in the foreground and records its state so `status`/`stop` work
 *                   from other shells.
 * Scope: Sidecar lifecycle only; CDP protocol behavior lives in dist/chrome-relay.
 * Usage: `pi-agent-browser-chrome-relay start [--port 9224] [--token <secret>|--token-gen]`
 *        `pi-agent-browser-chrome-relay status|stop|token|extension-path`
 * Invariants/Assumptions: The server binds 127.0.0.1 only; anything that can reach the
 *                         port can drive the logged-in browser, so share tokens carefully.
 *                         Run `npm run build` (or `npx pi-agent-browser` install) first —
 *                         `start` loads the compiled server from dist/.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const STATE_FILE = join(tmpdir(), "pi-agent-browser-chrome-relay.json");
const DEFAULT_PORT = 9224;

const usage = `Usage: pi-agent-browser-chrome-relay <command> [options]

Commands:
  start [--port N] [--token SECRET | --token-gen]   Run the relay in the foreground (Ctrl-C to stop)
  status                                            Report whether the relay is up and the extension connected
  stop                                              Stop the relay recorded by a previous start
  token                                             Print a freshly generated shared token
  extension-path                                    Print the unpacked extension directory to load in Chrome`;

function fail(message) {
	console.error(message);
	process.exitCode = 1;
}

function readState() {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return null;
	}
}

function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function probe(port) {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
		const body = await res.json().catch(() => ({}));
		return { up: true, ready: res.status === 200, extensionSeen: body.extensionSeen === true };
	} catch {
		return { up: false, ready: false, extensionSeen: false };
	}
}

function loadServer() {
	try {
		return require("../dist/chrome-relay/server.js");
	} catch {
		return null;
	}
}

function start(args) {
	const portFlag = args.get("port");
	const port = portFlag ? Number(portFlag) : DEFAULT_PORT;
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return fail(`invalid port: ${portFlag}`);
	const state = readState();
	if (pidAlive(state?.pid) && state?.port === port) {
		return fail(`a relay is already running on port ${port} (pid ${state.pid}); stop it first`);
	}
	const token = args.get("token-gen") ? randomBytes(24).toString("base64url") : (args.get("token") ?? undefined);
	const mod = loadServer();
	if (!mod) return fail("dist/chrome-relay/server.js not found — run `npm run build` first (or reinstall the package)");

	const srv = mod.startRelayServer({ port, ...(token ? { token } : {}) });
	writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, port: srv.port }));
	const origin = new URL(import.meta.url);
	console.log(`chrome relay listening on ws://127.0.0.1:${srv.port}/cdp`);
	if (args.get("token-gen") && token) console.log(`token (paste into the extension options): ${token}`);
	console.log(`extension: load unpacked from "${join(dirname(fileURLToPath(origin)), "..", "chrome-relay", "extension")}"`);
	console.log("press Ctrl-C to stop");
	let stopped = false;
	const shutdown = () => {
		if (stopped) return;
		stopped = true;
		srv.stop();
		rmSync(STATE_FILE, { force: true });
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	process.on("exit", () => rmSync(STATE_FILE, { force: true }));
	srv.ready.catch(error => {
		fail(`relay failed to start: ${error?.message ?? error}`);
		rmSync(STATE_FILE, { force: true });
		process.exit(1);
	});
}

async function status() {
	const state = readState();
	if (!state || !pidAlive(state.pid)) {
		console.log(JSON.stringify({ running: false }, null, 2));
		return;
	}
	const probeResult = await probe(state.port);
	console.log(
		JSON.stringify(
			{
				running: true,
				pid: state.pid,
				port: state.port,
				extensionConnected: probeResult.ready,
				extensionSeen: probeResult.extensionSeen,
			},
			null,
			2,
		),
	);
}

function stop() {
	const state = readState();
	if (!state) return console.log("no relay state found");
	rmSync(STATE_FILE, { force: true });
	if (!pidAlive(state.pid)) return console.log(`stale state removed (pid ${state.pid} not running)`);
	try {
		process.kill(state.pid, "SIGTERM");
		console.log(`sent SIGTERM to pid ${state.pid}`);
	} catch (error) {
		fail(`failed to stop pid ${state.pid}: ${error?.message ?? error}`);
	}
}

function main() {
	const argv = process.argv.slice(2);
	const command = argv.shift();
	const args = new Map();
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith("--")) continue;
		const key = argv[i].slice(2);
		const next = argv[i + 1];
		args.set(key, next !== undefined && !next.startsWith("--") ? (argv.splice(i + 1, 1)[0] ?? true) : true);
	}
	switch (command) {
		case "start":
			return start(args);
		case "status":
			return status();
		case "stop":
			return stop();
		case "token":
			return console.log(randomBytes(24).toString("base64url"));
		case "extension-path":
			return console.log(join(dirname(fileURLToPath(import.meta.url)), "..", "chrome-relay", "extension"));
		default:
			return fail(usage);
	}
}

main();
