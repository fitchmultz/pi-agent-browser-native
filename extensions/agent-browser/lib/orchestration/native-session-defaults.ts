import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { extractExplicitSessionName, getBooleanFlagValue, isUpstreamEnvFlagEnabled, scanUpstreamGlobalFlagOccurrences } from "../argv-grammar.js";
import { isRecord } from "../parsing.js";
import { parseArgvDescriptor } from "../argv-descriptor.js";
import { needsManagedSession } from "../command-policy.js";
import { getUpstreamEffectiveBatchSteps } from "./batch-stdin.js";
import { hasLaunchScopedFlagToken } from "../launch-scoped-flags.js";
import { getAgentBrowserProcessEnvironment, withAgentBrowserProcessEnvironment } from "../process-environment.js";
import { runAgentBrowserProcess, withChromeStartupArgs } from "../process.js";
import { parseAgentBrowserEnvelope } from "../results/envelope.js";
import { isPlainTextInspectionArgs } from "../runtime.js";
import { buildValidationFailureResult, type ResolvedAgentBrowserValidInput } from "./input-plan.js";
import type { AgentBrowserToolResult } from "./browser-run/index.js";
import { inspectManagedSessionDaemon } from "./browser-run/managed-session-daemon-policy.js";
import { buildMissingBinaryMessage } from "./browser-run/final-result.js";

interface NativeDefaults { session?: string; namespace?: string; profile?: unknown; executablePath?: unknown; [key: string]: unknown }

// These native defaults already send a local launch command on every call; keep its args stable too.
const LOCAL_VALUE_DEFAULTS = ["executablePath", "profile", "state", "proxy", "args", "userAgent", "caCert", "colorScheme", "downloadPath", "engine", "allowedDomains"];
const LOCAL_BOOLEAN_DEFAULTS = ["headed", "allowFileAccess", "webgpu", "noWebmcp"];
const LOCAL_ARRAY_DEFAULTS = ["extensions", "initScripts", "enable"];
const nativeEnvName = (key: string) => `AGENT_BROWSER_${key.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}`;
function hasLocalLaunchDefaults(config: NativeDefaults, env: NodeJS.ProcessEnv): boolean {
	return LOCAL_VALUE_DEFAULTS.some(key => env[nativeEnvName(key)] !== undefined || config[key] !== undefined)
		|| LOCAL_BOOLEAN_DEFAULTS.some(key => isUpstreamEnvFlagEnabled(env[nativeEnvName(key)]) || config[key] === true)
		|| LOCAL_ARRAY_DEFAULTS.some(key => (env[nativeEnvName(key)]?.length ?? 0) > 0 || Array.isArray(config[key]) && config[key].length > 0)
		|| (env.AGENT_BROWSER_CLEAR_CA_CERT !== undefined ? isUpstreamEnvFlagEnabled(env.AGENT_BROWSER_CLEAR_CA_CERT) : config.clearCaCert === true)
		|| (env.AGENT_BROWSER_HIDE_SCROLLBARS !== undefined ? !isUpstreamEnvFlagEnabled(env.AGENT_BROWSER_HIDE_SCROLLBARS) : config.hideScrollbars === false)
		|| ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].some(key => env[key] !== undefined);
}

function requestsConnection(tokens: string[], stdin?: string): boolean {
	return tokens[0] === "connect" || getUpstreamEffectiveBatchSteps(tokens, stdin).some(step => requestsConnection(step));
}

function rootBrowserSessionName(rootSessionId: string): string {
	return `pi-root-${createHash("sha256").update(rootSessionId).digest("hex").slice(0, 24)}`;
}

// Native `session` reports the resolved name, but not whether it was configured.
// Native validates its schema; retain configured launch defaults so root fallbacks never replace them.
async function readNativeIdentity(path: string, cwd: string, signal: AbortSignal | undefined, rootFallback: boolean, browserCommand: boolean): Promise<NativeDefaults> {
	let config: unknown;
	try { config = JSON.parse(await readFile(path, "utf8")); } catch { return {}; }
	if (!isRecord(config)) return {};
	const rootLaunchConfig = browserCommand && (hasLocalLaunchDefaults(config, {}) || ["cdp", "autoConnect", "provider"].some((key) => config[key] !== undefined))
		|| rootFallback && ["restore", "sessionName", "state", "allowedDomains", "profile", "executablePath"].some((key) => config[key] !== undefined);
	if (!rootLaunchConfig && typeof config.session !== "string" && typeof config.namespace !== "string") return {};
	const result = await runAgentBrowserProcess({ args: ["--config", path, "--json", "session"], cwd, signal, timeoutMs: 5_000 });
	try {
		if (result.aborted || result.timedOut || result.spawnError) throw new Error("Could not resolve native agent-browser session configuration; the browser command was not run.");
		if (result.exitCode !== 0) return {}; // Native ignores invalid discovered files; explicit files fail again in the actual command.
		const parsed = await parseAgentBrowserEnvelope({ stdout: result.stdout, stdoutPath: result.stdoutSpillPath });
		const data = parsed.envelope?.data;
		if (!isRecord(data) || typeof data.session !== "string") throw new Error("Native agent-browser session inspection returned no session name; the browser command was not run.");
		const { session: _session, namespace: _namespace, ...defaults } = config;
		return {
			...defaults,
			...(typeof config.session === "string" ? { session: data.session } : {}),
			...(typeof config.namespace === "string" ? { namespace: config.namespace } : {}),
		};
	} finally {
		if (result.stdoutSpillPath) await rm(result.stdoutSpillPath, { force: true });
	}
}

export async function withNativeSessionDefaults(input: ResolvedAgentBrowserValidInput, cwd: string, signal: AbortSignal | undefined, run: (input: ResolvedAgentBrowserValidInput, withLaunchDefaults?: (browserRun: (daemonInactive?: boolean) => Promise<AgentBrowserToolResult>, signal?: AbortSignal) => Promise<AgentBrowserToolResult>) => Promise<AgentBrowserToolResult>, root?: { id: string; profile?: string; executablePath?: string }): Promise<AgentBrowserToolResult> {
	if (input.kind === "electron" && input.compiledElectron.action === "launch") return withAgentBrowserProcessEnvironment({ AGENT_BROWSER_SESSION: undefined }, () => run(input));
	if (input.kind === "electron" || isPlainTextInspectionArgs(input.toolArgs)) return run(input);
	const env = getAgentBrowserProcessEnvironment();
	const configArg = scanUpstreamGlobalFlagOccurrences(input.toolArgs, "--config")[0];
	const configPath = configArg?.value ?? env.AGENT_BROWSER_CONFIG;
	const paths = configPath !== undefined
		? [resolve(cwd, configPath)]
		: [join(homedir(), ".agent-browser", "config.json"), join(cwd, "agent-browser.json")];
	const rootName = root && rootBrowserSessionName(root.id);
	const explicitSession = extractExplicitSessionName(input.toolArgs);
	const rootFallback = root !== undefined && env.AGENT_BROWSER_SESSION === undefined && (explicitSession === undefined || explicitSession === rootName)
		&& needsManagedSession(parseArgvDescriptor(input.toolArgs), input.toolStdin);
	let identity: NativeDefaults = {};
	const browserCommand = needsManagedSession(parseArgvDescriptor(input.toolArgs), input.toolStdin);
	for (const path of paths) identity = { ...identity, ...await readNativeIdentity(path, cwd, signal, rootFallback, browserCommand) };
	// Native ORs environment/config booleans; only CLI false overrides configured auto-connect.
	const autoConnect = getBooleanFlagValue(input.toolArgs, "--auto-connect")
		?? (isUpstreamEnvFlagEnabled(env.AGENT_BROWSER_AUTO_CONNECT) || identity.autoConnect === true);
	const attachment = hasLaunchScopedFlagToken(input.toolArgs, "--cdp")
		|| env.AGENT_BROWSER_CDP !== undefined || identity.cdp !== undefined || autoConnect
		|| parseArgvDescriptor(input.toolArgs).upstreamCommandTokens[0] === "connect";
	const configuredSession = env.AGENT_BROWSER_SESSION ?? identity.session;
	const launchArgs = scanUpstreamGlobalFlagOccurrences(input.toolArgs, "--args").at(-1)?.value ?? env.AGENT_BROWSER_ARGS ?? identity.args;
	const engine = scanUpstreamGlobalFlagOccurrences(input.toolArgs, "--engine").at(-1)?.value ?? env.AGENT_BROWSER_ENGINE ?? identity.engine;
	const provider = scanUpstreamGlobalFlagOccurrences(input.toolArgs, "--provider").at(-1)?.value ?? scanUpstreamGlobalFlagOccurrences(input.toolArgs, "-p").at(-1)?.value ?? env.AGENT_BROWSER_PROVIDER ?? identity.provider;
	const tokens = parseArgvDescriptor(input.toolArgs).upstreamCommandTokens;
	const batchAttaches = requestsConnection(tokens, input.toolStdin);
	const localChrome = browserCommand && !attachment && !batchAttaches && provider === undefined
		&& (engine === undefined || engine === "chrome");
	const chromeStartupArgs = localChrome ? ["--no-startup-window", ...(typeof launchArgs === "string" ? [launchArgs] : [])].join(",") : undefined;
	const persistentChromeArgs = hasLocalLaunchDefaults(identity, env) ? chromeStartupArgs : undefined;
	const configuredChromeLaunch = persistentChromeArgs !== undefined || [...LOCAL_VALUE_DEFAULTS, ...LOCAL_BOOLEAN_DEFAULTS, ...LOCAL_ARRAY_DEFAULTS, "hideScrollbars", "clearCaCert"].some(key => {
		const flag = ({ extensions: "--extension", initScripts: "--init-script", clearCaCert: "--no-ca-cert" } as Record<string, string>)[key] ?? `--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
		return scanUpstreamGlobalFlagOccurrences(input.toolArgs, flag).length > 0;
	});
	const rootDefault = rootName && configuredSession === undefined && rootFallback && !attachment
		? rootName : undefined;
	const session = configuredSession ?? rootDefault;
	const restoreEligible = !["--restore", "--session-name", "--state", "--allowed-domains", "--provider", "-p", "--device"].some((flag) => hasLaunchScopedFlagToken(input.toolArgs, flag))
		&& !["restore", "sessionName", "state", "allowedDomains", "provider"].some((key) => identity[key] !== undefined)
		&& !["AGENT_BROWSER_RESTORE", "AGENT_BROWSER_SESSION_NAME", "AGENT_BROWSER_STATE", "AGENT_BROWSER_ALLOWED_DOMAINS", "AGENT_BROWSER_PROVIDER"].some((key) => env[key] !== undefined);
	const namespace = env.AGENT_BROWSER_NAMESPACE ?? identity.namespace;
	let args = input.toolArgs;
	if (session !== undefined && extractExplicitSessionName(args) === undefined) args = ["--session", session, ...args];
	const idleTimeout = scanUpstreamGlobalFlagOccurrences(args, "--idle-timeout").at(-1)?.value;
	return withAgentBrowserProcessEnvironment({
		...(idleTimeout !== undefined ? { AGENT_BROWSER_IDLE_TIMEOUT_MS: idleTimeout } : {}),
		...(configPath !== undefined ? { AGENT_BROWSER_CONFIG: resolve(cwd, configPath) } : {}),
		...(session !== undefined ? { AGENT_BROWSER_SESSION: session } : {}),
		...(namespace !== undefined ? { AGENT_BROWSER_NAMESPACE: namespace } : {}),
	}, () => run({ ...input, toolArgs: args, chromeStartupArgs, persistentChromeArgs, configuredChromeLaunch }, !rootDefault ? undefined : async (browserRun, launchSignal = signal) => {
		const daemon = await inspectManagedSessionDaemon({ cwd, signal: launchSignal, sessionName: rootDefault,
			namespace: scanUpstreamGlobalFlagOccurrences(args, "--namespace").at(-1)?.value ?? namespace, timeoutMs: 5_000 });
		if (daemon.status === "missing-binary") return {
			content: [{ type: "text", text: buildMissingBinaryMessage() }],
			details: { agentBrowserStarted: false, args: input.redactedArgs, sessionName: rootDefault, resultCategory: "failure", failureCategory: "missing-binary" },
			isError: true,
		};
		if (input.kind === "qa" && input.compiledQaPreset.checks.attached && daemon.status !== "active") {
			return buildValidationFailureResult({ ...input, attemptedKind: "qa", kind: "invalid", status: "invalid", validationError: "qa.attached requires an active attached session. Open the root browser first, or select an existing native session." });
		}
		// An active daemon already owns its launch settings. Re-sending defaults can replace an explicitly profiled browser.
		const bootstrap = daemon.status === "inactive";
		let restore: string | undefined;
		if (restoreEligible && daemon.status === "active") restore = daemon.restoreKey ?? undefined;
		if (restoreEligible && bootstrap) restore = rootDefault;
		const profile = scanUpstreamGlobalFlagOccurrences(args, "--profile").at(-1)?.value
			?? (bootstrap && restoreEligible && identity.profile === undefined && env.AGENT_BROWSER_PROFILE === undefined ? root?.profile : undefined);
		const executablePath = scanUpstreamGlobalFlagOccurrences(args, "--executable-path").at(-1)?.value
			?? (bootstrap && identity.executablePath === undefined && env.AGENT_BROWSER_EXECUTABLE_PATH === undefined ? root?.executablePath : undefined);
		return withAgentBrowserProcessEnvironment({
			...(restore !== undefined ? { AGENT_BROWSER_RESTORE: restore } : {}),
			...(profile !== undefined ? { AGENT_BROWSER_PROFILE: profile } : {}),
			...(executablePath !== undefined ? { AGENT_BROWSER_EXECUTABLE_PATH: executablePath } : {}),
		}, () => withChromeStartupArgs(bootstrap || configuredChromeLaunch ? chromeStartupArgs : undefined, () => browserRun(bootstrap)));
	}));
}
