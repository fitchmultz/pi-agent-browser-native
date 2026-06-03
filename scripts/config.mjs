#!/usr/bin/env node
/**
 * Purpose: Manage pi-agent-browser-native package config under Pi-scoped config paths.
 * Responsibilities: Print config paths/status, write redacted web-search and browser profile settings, preserve safe permissions, and avoid echoing secrets.
 * Scope: Maintainer/user setup CLI only; extension runtime validation and tool execution live under extensions/agent-browser/lib/.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

const CONFIG_ENV = "PI_AGENT_BROWSER_CONFIG";
const BRAVE_API_KEY_ENV = "BRAVE_API_KEY";
const RELATIVE_CONFIG = [".pi", "config", "pi-agent-browser-native", "config.json"];
const DEFAULT_CONFIG = { version: 1 };

class UsageError extends Error {
	constructor(message) {
		super(message);
		this.name = "UsageError";
	}
}

function usage() {
	return `pi-agent-browser-config

Usage:
  pi-agent-browser-config paths
  pi-agent-browser-config show
  pi-agent-browser-config web-search status
  pi-agent-browser-config web-search set-key --stdin [--global]
  pi-agent-browser-config web-search set-env <ENV_VAR> [--global|--project]
  pi-agent-browser-config web-search set-command <command> [--global]
  pi-agent-browser-config web-search clear [--global|--project]
  pi-agent-browser-config browser profile status
  pi-agent-browser-config browser profile set <name> [--policy explicit-only|authenticated-only|always] [--global|--project]
  pi-agent-browser-config browser profile clear [--global|--project]

Notes:
  Global config:  ~/.pi/config/pi-agent-browser-native/config.json
  Project config: .pi/config/pi-agent-browser-native/config.json
  Override:       PI_AGENT_BROWSER_CONFIG=/path/to/config.json
  Project-local plaintext, interpolation-literal, malformed, and command-backed web-search keys are refused; use exact set-env references there.
`;
}

function getHome(env = process.env) {
	return env.HOME?.trim() || env.USERPROFILE?.trim();
}

function getGlobalConfigPath(env = process.env) {
	const home = getHome(env);
	if (!home) throw new Error("Could not resolve home directory for global config.");
	return resolve(home, ...RELATIVE_CONFIG);
}

function getProjectConfigPath(cwd = process.cwd()) {
	return resolve(cwd, ...RELATIVE_CONFIG);
}

function getPaths(env = process.env, cwd = process.cwd()) {
	const override = env[CONFIG_ENV]?.trim();
	return {
		global: getGlobalConfigPath(env),
		project: getProjectConfigPath(cwd),
		override: override ? resolve(override) : undefined,
	};
}

function parseArgs(argv) {
	const positional = [];
	const flags = new Map();
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		if (arg === "--global" || arg === "--project" || arg === "--stdin" || arg === "--help") {
			flags.set(arg, true);
			continue;
		}
		if (arg === "--policy") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) throw new UsageError("--policy requires a value.");
			flags.set(arg, value);
			index += 1;
			continue;
		}
		throw new UsageError(`Unknown option: ${arg}`);
	}
	if (flags.get("--global") && flags.get("--project")) throw new UsageError("Use only one of --global or --project.");
	return { flags, positional };
}

function readConfig(path) {
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };
	const parsed = JSON.parse(readFileSync(path, "utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} must contain a JSON object.`);
	return { ...DEFAULT_CONFIG, ...parsed };
}

function writeConfig(path, config) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	try {
		chmodSync(dirname(path), 0o700);
		chmodSync(path, 0o600);
	} catch {
		// Best effort on platforms/filesystems that do not support POSIX modes.
	}
}

function selectWritePath(flags) {
	const paths = getPaths();
	if (flags.get("--project")) return { path: paths.project, scope: "project" };
	return { path: paths.global, scope: "global" };
}

function classifyCredential(rawValue) {
	const trimmed = String(rawValue ?? "").trim();
	if (!trimmed) return "not configured";
	if (trimmed.startsWith("!")) return "configured via command";
	if (trimmed.includes("$")) return "configured via environment interpolation";
	return "configured as plaintext [redacted]";
}

function mergeConfig() {
	const paths = getPaths();
	const layers = [];
	for (const [scope, path] of [["global", paths.global], ["project", paths.project], ...(paths.override ? [["override", paths.override]] : [])]) {
		if (!existsSync(path)) continue;
		layers.push({ scope, path, config: readConfig(path) });
	}
	const merged = layers.reduce((current, layer) => ({
		...current,
		...layer.config,
		browser: { ...(current.browser ?? {}), ...(layer.config.browser ?? {}) },
		webSearch: { ...(current.webSearch ?? {}), ...(layer.config.webSearch ?? {}) },
	}), { ...DEFAULT_CONFIG });
	return { layers, merged, paths };
}

function printPaths() {
	const paths = getPaths();
	console.log(`Global: ${paths.global}`);
	console.log(`Project: ${paths.project}`);
	console.log(`Override: ${paths.override ?? `${CONFIG_ENV} not set`}`);
}

function printStatus() {
	const { layers, merged, paths } = mergeConfig();
	printPaths();
	console.log("");
	console.log("Config files:");
	for (const [scope, path] of [["global", paths.global], ["project", paths.project], ...(paths.override ? [["override", paths.override]] : [])]) {
		console.log(`  ${scope}: ${path} ${existsSync(path) ? "[exists]" : "[missing]"}`);
	}
	console.log("");
	console.log("Effective config:");
	const source = merged.webSearch?.braveApiKey;
	console.log(`  webSearch.braveApiKey: ${source ? classifyCredential(source) : process.env[BRAVE_API_KEY_ENV]?.trim() ? `configured via ${BRAVE_API_KEY_ENV} environment fallback` : "not configured"}`);
	const profile = merged.browser?.defaultProfile;
	console.log(`  browser.defaultProfile: ${profile?.name ? `${profile.name} (policy: ${profile.policy ?? "authenticated-only"})` : "not configured"}`);
	if (layers.length === 0) console.log("  layers: none");
}

async function readSecretFromStdin(useStdin) {
	if (!useStdin) throw new UsageError("set-key requires --stdin so the key is not passed through argv or an echoed prompt.");
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	const value = input.trim();
	if (!value) throw new UsageError("No key was provided on stdin.");
	return value;
}

function mutateConfig(path, mutate) {
	const config = readConfig(path);
	mutate(config);
	writeConfig(path, config);
}

async function handleWebSearch(args, flags) {
	const action = args[0];
	if (action === "status") {
		printStatus();
		return;
	}
	if (action === "set-key") {
		if (flags.get("--project")) throw new UsageError("Plaintext Brave keys cannot be written to project-local config. Use set-env or set-command.");
		const key = await readSecretFromStdin(Boolean(flags.get("--stdin")));
		const { path } = selectWritePath(flags);
		mutateConfig(path, (config) => {
			config.webSearch = { ...(config.webSearch ?? {}), braveApiKey: key };
		});
		console.log(`Saved Brave Search key to global config: ${path}`);
		return;
	}
	if (action === "set-env") {
		const envName = args[1];
		if (!envName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) throw new UsageError("set-env requires a valid environment variable name.");
		const { path, scope } = selectWritePath(flags);
		mutateConfig(path, (config) => {
			config.webSearch = { ...(config.webSearch ?? {}), braveApiKey: `$${envName}` };
		});
		console.log(`Saved Brave Search ${scope} env reference to: ${path}`);
		return;
	}
	if (action === "set-command") {
		if (flags.get("--project")) throw new UsageError("Command-backed Brave keys cannot be written to project-local config. Use set-env there.");
		const command = args.slice(1).join(" ").trim();
		if (!command) throw new UsageError("set-command requires a command string.");
		const { path, scope } = selectWritePath(flags);
		mutateConfig(path, (config) => {
			config.webSearch = { ...(config.webSearch ?? {}), braveApiKey: `!${command}` };
		});
		console.log(`Saved Brave Search ${scope} command source to: ${path}`);
		return;
	}
	if (action === "clear") {
		const { path, scope } = selectWritePath(flags);
		mutateConfig(path, (config) => {
			if (config.webSearch) delete config.webSearch.braveApiKey;
		});
		console.log(`Cleared Brave Search credential source in ${scope} config: ${path}`);
		return;
	}
	throw new UsageError(`Unsupported web-search action: ${action ?? ""}`);
}

function handleBrowser(args, flags) {
	if (args[0] !== "profile") throw new UsageError(`Unsupported browser action: ${args[0] ?? ""}`);
	const action = args[1];
	if (action === "status") {
		printStatus();
		return;
	}
	if (action === "set") {
		const name = args[2]?.trim();
		if (!name) throw new UsageError("browser profile set requires a profile name.");
		const policy = flags.get("--policy") || "authenticated-only";
		if (!["explicit-only", "authenticated-only", "always"].includes(policy)) throw new UsageError("Invalid --policy value.");
		const { path, scope } = selectWritePath(flags);
		mutateConfig(path, (config) => {
			config.browser = { ...(config.browser ?? {}), defaultProfile: { name, policy } };
		});
		console.log(`Saved browser default profile in ${scope} config: ${path}`);
		return;
	}
	if (action === "clear") {
		const { path, scope } = selectWritePath(flags);
		mutateConfig(path, (config) => {
			if (config.browser) delete config.browser.defaultProfile;
		});
		console.log(`Cleared browser default profile in ${scope} config: ${path}`);
		return;
	}
	throw new UsageError(`Unsupported browser profile action: ${action ?? ""}`);
}

export async function main(argv = process.argv.slice(2)) {
	const { flags, positional } = parseArgs(argv);
	if (flags.get("--help") || positional.length === 0) {
		console.log(usage());
		return 0;
	}
	const command = positional[0];
	if (command === "paths") {
		printPaths();
		return 0;
	}
	if (command === "show") {
		printStatus();
		return 0;
	}
	if (command === "web-search") {
		await handleWebSearch(positional.slice(1), flags);
		return 0;
	}
	if (command === "browser") {
		handleBrowser(positional.slice(1), flags);
		return 0;
	}
	throw new UsageError(`Unknown command: ${command}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		if (error instanceof UsageError) {
			console.error(error.message);
			console.error(usage());
			process.exit(2);
		}
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
