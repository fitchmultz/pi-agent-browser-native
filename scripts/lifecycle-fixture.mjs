/** Isolated package/settings preparation and compiled-source sentinel injection for lifecycle verification. */
import { execFile as execFileCallback } from "node:child_process";
import { access, chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SENTINEL_CUSTOM_TYPE = "piab-lifecycle-sentinel";
const SENTINEL_COMMAND_PREFIX = "piab-lifecycle-sentinel";
const SENTINEL_MARKER_START = "// PIAB_LIFECYCLE_SENTINEL_START";
const SENTINEL_MARKER_END = "// PIAB_LIFECYCLE_SENTINEL_END";

export async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export function buildSettingsPayload({ packageDir, sessionDir }) {
	return {
		quietStartup: false,
		sessionDir,
		packages: [packageDir],
		extensions: [],
		skills: [],
		prompts: [],
		themes: [],
		enableInstallTelemetry: false,
	};
}

export async function writeSettings({ agentDir, packageDir, sessionDir }) {
	await mkdir(agentDir, { recursive: true });
	const settings = buildSettingsPayload({ packageDir, sessionDir });
	await writeFile(
		join(agentDir, "settings.json"),
		`${JSON.stringify(settings, null, "\t")}\n`,
		"utf8",
	);
	return settings;
}

export async function copyPackageSource({ packageDir, repoRoot }) {
	await execFile(process.execPath, ["./scripts/build.mjs"], {
		cwd: repoRoot,
		maxBuffer: 10 * 1024 * 1024,
	});
	await mkdir(packageDir, { recursive: true });
	await cp(resolve(repoRoot, "extensions"), resolve(packageDir, "extensions"), { recursive: true });
	await cp(resolve(repoRoot, "dist"), resolve(packageDir, "dist"), { recursive: true });
	await cp(resolve(repoRoot, "package.json"), resolve(packageDir, "package.json"));
	const repoNodeModules = resolve(repoRoot, "node_modules");
	const tempNodeModules = resolve(packageDir, "node_modules");
	if (await pathExists(repoNodeModules)) {
		await cp(repoNodeModules, tempNodeModules, { recursive: true, verbatimSymlinks: true });
	}
}

export function lifecycleSentinelCommand(token) {
	return `${SENTINEL_COMMAND_PREFIX}-${token}`;
}

export function injectLifecycleSentinelSource(source, token) {
	const withoutOldSentinel = source.replace(
		new RegExp(
			`\\n\\t${SENTINEL_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?\\n\\t${SENTINEL_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`,
		),
		"",
	);
	const marker =
		/function agentBrowserExtension\(pi,\s*\{\s*beforeExecute\s*,?\s*\}\s*=\s*\{\s*\}\s*\)\s*\{/;
	const snippet = `
	${SENTINEL_MARKER_START}
	pi.registerCommand(${JSON.stringify(lifecycleSentinelCommand(token))}, {
		description: "Append the pi-agent-browser lifecycle sentinel token.",
		handler: async () => {
			pi.appendEntry("${SENTINEL_CUSTOM_TYPE}", { token: ${JSON.stringify(token)} });
		},
	});
	${SENTINEL_MARKER_END}
`;
	if (!marker.test(withoutOldSentinel)) {
		throw new Error("Could not locate extension factory marker for lifecycle sentinel injection.");
	}
	return withoutOldSentinel.replace(marker, (matched) => `${matched}${snippet}`);
}

export async function writeLifecycleSentinel({ packageDir, token }) {
	const indexPath = resolve(packageDir, "dist/extensions/agent-browser/index.js");
	const source = await readFile(indexPath, "utf8");
	await writeFile(indexPath, injectLifecycleSentinelSource(source, token), "utf8");
}

export async function createFakeAgentBrowserBinary(binDir, script) {
	await mkdir(binDir, { recursive: true });
	const scriptPath = join(binDir, "agent-browser");
	await writeFile(scriptPath, script, "utf8");
	await chmod(scriptPath, 0o755);
	await writeFile(
		join(binDir, "agent-browser.cmd"),
		`@echo off\n${JSON.stringify(process.execPath)} "%~dp0agent-browser" %*\n`,
		"utf8",
	);
}
