#!/usr/bin/env node
/**
 * Purpose: Manage pi-agent-browser-native package config under Pi-scoped config paths.
 * Responsibilities: Thin CLI argument parsing and config-file mutation around the shared config policy; preserve safe permissions and avoid echoing secrets.
 * Scope: Maintainer/user setup CLI only; canonical config validation, merge, provider descriptors, and status projection live in extensions/agent-browser/lib/config-policy.js.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

async function loadConfigPolicyModule() {
	const sourcePolicyUrl = new URL("../extensions/agent-browser/lib/config-policy.js", import.meta.url);
	if (existsSync(sourcePolicyUrl)) return import(sourcePolicyUrl.href);
	return import("../dist/extensions/agent-browser/lib/config-policy.js");
}

const {
	AGENT_BROWSER_CONFIG_ENV,
	BRAVE_API_KEY_ENV,
	DEFAULT_WEB_SEARCH_PROVIDER,
	EXA_API_KEY_ENV,
	WEB_SEARCH_PROVIDERS,
	formatBrowserExecutableStatus,
	formatBrowserProfileStatus,
	getAgentBrowserConfigPaths,
	getCredentialSourceSummary,
	getWebSearchProviderConfigKey,
	getWebSearchProviderEnvVar,
	getWebSearchProviderLabel,
	isProjectSafeCredentialValueForProvider,
	isWebSearchProvider,
	loadAgentBrowserConfigStateSync,
	summarizeConfigFiles,
} = await loadConfigPolicyModule();

const DEFAULT_CONFIG = { version: 1 };

class UsageError extends Error {
	constructor(message) {
		super(message);
		this.name = "UsageError";
	}
}

function usage() {
	return `pi-agent-browser-native config helper

Usage through npm exec:
  npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config paths
  npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config show
  npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search status
  npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search set-key --stdin --provider <exa|brave> [--global]
  npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search set-env <ENV_VAR> [--provider brave|exa] [--global|--project]
  npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search set-command <command> --provider <exa|brave> [--global]
  npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search clear --provider <exa|brave|all> [--global|--project]
  npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search prefer <exa|brave|auto> [--global|--project]
  npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search enable [--global|--project]
  npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config web-search disable [--global|--project]
  npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config browser profile status
  npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config browser profile set <name|path> [--policy explicit-only|authenticated-only|always] [--global|--project]
  npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config browser profile clear [--global|--project]
  npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config browser executable status
  npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config browser executable set <path> [--global]
  npm exec --yes --package pi-agent-browser-native@latest -- pi-agent-browser-config browser executable clear [--global|--project]

Notes:
  Global config:  ~/.pi/config/pi-agent-browser-native/config.json
  Project config: .pi/config/pi-agent-browser-native/config.json
  Override:       ${AGENT_BROWSER_CONFIG_ENV}=/path/to/config.json
  Project-local plaintext, custom env aliases, interpolation-literal, malformed, and command-backed web-search keys are refused; use matching ${EXA_API_KEY_ENV} or ${BRAVE_API_KEY_ENV} set-env references there.
  Use --provider for set-key, set-command, and clear; set-env infers exa/brave from ${EXA_API_KEY_ENV} or ${BRAVE_API_KEY_ENV}.
`;
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
		if (arg === "--policy" || arg === "--provider") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) throw new UsageError(`${arg} requires a value.`);
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
	const paths = getAgentBrowserConfigPaths();
	if (flags.get("--project")) return { path: paths.project, scope: "project" };
	return { path: paths.global, scope: "global" };
}

function validateWebSearchProviderArg(provider, { allowAll = false } = {}) {
	if (isWebSearchProvider(provider) || (allowAll && provider === "all")) return provider;
	throw new UsageError(`--provider must be one of ${allowAll ? `${WEB_SEARCH_PROVIDERS.join(", ")}, all` : WEB_SEARCH_PROVIDERS.join(", ")}.`);
}

function inferWebSearchProviderFromEnvName(envName) {
	for (const provider of WEB_SEARCH_PROVIDERS) {
		if (envName === getWebSearchProviderEnvVar(provider)) return provider;
	}
	return undefined;
}

function getWebSearchProvider(flags, options = {}) {
	const configured = flags.get("--provider");
	if (configured) return validateWebSearchProviderArg(configured, options);
	const inferred = options.envName ? inferWebSearchProviderFromEnvName(options.envName) : undefined;
	if (inferred) return inferred;
	throw new UsageError(options.allowAll ? "--provider is required and must be exa, brave, or all." : "--provider is required and must be exa or brave.");
}

function setWebSearchCredential(config, provider, value) {
	config.webSearch = { ...(config.webSearch ?? {}), [getWebSearchProviderConfigKey(provider)]: value };
}

function clearWebSearchCredential(config, provider) {
	if (config.webSearch) delete config.webSearch[getWebSearchProviderConfigKey(provider)];
}

function printPaths() {
	const paths = getAgentBrowserConfigPaths();
	console.log(`Global: ${paths.global}`);
	console.log(`Project: ${paths.project}`);
	console.log(`Override: ${paths.override ?? `${AGENT_BROWSER_CONFIG_ENV} not set`}`);
}

function printStatus() {
	const state = loadAgentBrowserConfigStateSync({ cwd: process.cwd(), env: process.env });
	printPaths();
	console.log("");
	console.log("Config files:");
	for (const file of summarizeConfigFiles(state)) {
		console.log(`  ${file.scope}: ${file.path} ${file.exists ? "[exists]" : "[missing]"}`);
	}
	console.log("");
	console.log("Effective config:");
	console.log(`  webSearch.enabled: ${state.webSearchEnabled ? "true" : "false"}`);
	console.log(`  webSearch.preferredProvider: ${state.config.webSearch?.preferredProvider ?? `auto (default ${DEFAULT_WEB_SEARCH_PROVIDER})`}`);
	for (const provider of WEB_SEARCH_PROVIDERS) {
		const field = getWebSearchProviderConfigKey(provider);
		console.log(`  webSearch.${field}: ${getCredentialSourceSummary(state.webSearchCredentialSources[provider], provider)}`);
	}
	console.log(`  browser.defaultProfile: ${formatBrowserProfileStatus(state)}`);
	console.log(`  browser.executablePath: ${formatBrowserExecutableStatus(state)}`);
	if (state.layers.length === 0) console.log("  layers: none");
	if (state.warnings.length > 0) {
		console.log("");
		console.log("Warnings:");
		for (const warning of state.warnings) console.log(`  - ${warning}`);
	}
	if (state.errors.length > 0) {
		console.log("");
		console.log("Validation errors:");
		for (const error of state.errors) console.log(`  - ${error}`);
	}
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
		const provider = getWebSearchProvider(flags);
		if (flags.get("--project")) throw new UsageError(`Plaintext ${getWebSearchProviderLabel(provider)} keys cannot be written to project-local config. Use set-env or set-command.`);
		const key = await readSecretFromStdin(Boolean(flags.get("--stdin")));
		const { path } = selectWritePath(flags);
		mutateConfig(path, (config) => {
			setWebSearchCredential(config, provider, key);
		});
		console.log(`Saved ${getWebSearchProviderLabel(provider)} key to global config: ${path}`);
		return;
	}
	if (action === "set-env") {
		const envName = args[1];
		if (!envName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) throw new UsageError("set-env requires a valid environment variable name.");
		const provider = getWebSearchProvider(flags, { envName });
		const envReference = `$${envName}`;
		if (flags.get("--project") && !isProjectSafeCredentialValueForProvider(envReference, provider)) {
			throw new UsageError(`Project-local ${getWebSearchProviderLabel(provider)} env references must use ${getWebSearchProviderEnvVar(provider)} exactly; custom env aliases belong in global config or ${AGENT_BROWSER_CONFIG_ENV}.`);
		}
		const { path, scope } = selectWritePath(flags);
		mutateConfig(path, (config) => {
			setWebSearchCredential(config, provider, envReference);
		});
		console.log(`Saved ${getWebSearchProviderLabel(provider)} ${scope} env reference to: ${path}`);
		return;
	}
	if (action === "set-command") {
		const provider = getWebSearchProvider(flags);
		if (flags.get("--project")) throw new UsageError(`Command-backed ${getWebSearchProviderLabel(provider)} keys cannot be written to project-local config. Use set-env there.`);
		const command = args.slice(1).join(" ").trim();
		if (!command) throw new UsageError("set-command requires a command string.");
		const { path, scope } = selectWritePath(flags);
		mutateConfig(path, (config) => {
			setWebSearchCredential(config, provider, `!${command}`);
		});
		console.log(`Saved ${getWebSearchProviderLabel(provider)} ${scope} command source to: ${path}`);
		return;
	}
	if (action === "clear") {
		const provider = getWebSearchProvider(flags, { allowAll: true });
		const { path, scope } = selectWritePath(flags);
		mutateConfig(path, (config) => {
			if (provider === "all") {
				for (const entry of WEB_SEARCH_PROVIDERS) clearWebSearchCredential(config, entry);
			} else {
				clearWebSearchCredential(config, provider);
			}
		});
		console.log(`Cleared ${provider === "all" ? "all web-search" : getWebSearchProviderLabel(provider)} credential source in ${scope} config: ${path}`);
		return;
	}
	if (action === "prefer") {
		const provider = args[1];
		if (!provider || (!isWebSearchProvider(provider) && provider !== "auto")) throw new UsageError("prefer requires exa, brave, or auto.");
		const { path, scope } = selectWritePath(flags);
		mutateConfig(path, (config) => {
			config.webSearch = { ...(config.webSearch ?? {}) };
			if (provider === "auto") delete config.webSearch.preferredProvider;
			else config.webSearch.preferredProvider = provider;
		});
		console.log(`${provider === "auto" ? "Cleared" : "Saved"} web-search preferred provider in ${scope} config: ${path}`);
		return;
	}
	if (action === "enable" || action === "disable") {
		const { path, scope } = selectWritePath(flags);
		mutateConfig(path, (config) => {
			config.webSearch = { ...(config.webSearch ?? {}), enabled: action === "enable" };
		});
		console.log(`${action === "enable" ? "Enabled" : "Disabled"} agent_browser_web_search in ${scope} config: ${path}`);
		return;
	}
	throw new UsageError(`Unsupported web-search action: ${action ?? ""}`);
}

function handleBrowser(args, flags) {
	const target = args[0];
	const action = args[1];
	if (target === "profile") {
		if (action === "status") {
			printStatus();
			return;
		}
		if (action === "set") {
			const name = args.slice(2).join(" ").trim();
			if (!name) throw new UsageError("browser profile set requires a profile name or profile directory path.");
			const policy = flags.get("--policy") || "authenticated-only";
			if (!["explicit-only", "authenticated-only", "always"].includes(policy)) throw new UsageError("Invalid --policy value.");
			if (flags.get("--project") && policy !== "explicit-only") {
				throw new UsageError("Project-local browser profile config may only use --policy explicit-only; authenticated or always profile guidance must be configured globally or through PI_AGENT_BROWSER_CONFIG.");
			}
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
	if (target === "executable") {
		if (action === "status") {
			printStatus();
			return;
		}
		if (action === "set") {
			const executablePath = args.slice(2).join(" ").trim();
			if (!executablePath) throw new UsageError("browser executable set requires a browser executable path.");
			if (flags.get("--project")) {
				throw new UsageError("Project-local browser executable config cannot steer host launch guidance; configure it globally or through PI_AGENT_BROWSER_CONFIG.");
			}
			const { path, scope } = selectWritePath(flags);
			mutateConfig(path, (config) => {
				config.browser = { ...(config.browser ?? {}), executablePath };
			});
			console.log(`Saved browser executable path in ${scope} config: ${path}`);
			return;
		}
		if (action === "clear") {
			const { path, scope } = selectWritePath(flags);
			mutateConfig(path, (config) => {
				if (config.browser) delete config.browser.executablePath;
			});
			console.log(`Cleared browser executable path in ${scope} config: ${path}`);
			return;
		}
		throw new UsageError(`Unsupported browser executable action: ${action ?? ""}`);
	}
	throw new UsageError(`Unsupported browser action: ${target ?? ""}`);
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
