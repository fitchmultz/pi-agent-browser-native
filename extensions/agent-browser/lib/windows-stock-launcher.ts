import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isMainThread } from "node:worker_threads";
import pathKey from "path-key";
import which from "which";
import { isRecord } from "./parsing.js";

function environmentValues(env: Readonly<NodeJS.ProcessEnv>, name: string): (string | undefined)[] {
	return Object.entries(env)
		.filter(([key, value]) => key.toUpperCase() === name && value !== undefined)
		.map(([, value]) => value);
}

function hasStockEnvironment(env: Readonly<NodeJS.ProcessEnv>): boolean {
	const paths = environmentValues(env, "PATH");
	const extensions = environmentValues(env, "PATHEXT");
	return (
		paths.length === 1 &&
		paths.at(0) !== undefined &&
		paths.at(0) !== "" &&
		extensions.length === 1 &&
		extensions.at(0) === process.env.PATHEXT &&
		environmentValues(env, "NODEFAULTCURRENTDIRECTORYINEXEPATH").length === 0
	);
}

function hasNativeCommandShell(): boolean {
	const { comspec, SystemRoot } = process.env;
	if (
		comspec === undefined ||
		comspec.length === 0 ||
		!isAbsolute(comspec) ||
		SystemRoot === undefined ||
		SystemRoot.length === 0
	) {
		return false;
	}
	try {
		const shell = statSync(comspec, { bigint: true });
		const native = statSync(join(SystemRoot, "System32", "cmd.exe"), { bigint: true });
		return shell.dev === native.dev && shell.ino === native.ino;
	} catch {
		return false;
	}
}

function selectLauncher(cwd: string, env: Readonly<NodeJS.ProcessEnv>): string | null | undefined {
	const previousCwd = process.cwd();
	try {
		// which 2 has no cwd option; synchronous resolution matches cross-spawn's child cwd.
		process.chdir(cwd);
		return which.sync("agent-browser", { path: env[pathKey({ env })], nothrow: true });
	} catch {
		return undefined;
	} finally {
		process.chdir(previousCwd);
	}
}

function isStockAgentBrowserManifest(manifest: unknown): boolean {
	if (!isRecord(manifest) || manifest.name !== "agent-browser" || !isRecord(manifest.bin)) {
		return false;
	}
	const entrypoint = manifest.bin["agent-browser"];
	return entrypoint === "bin/agent-browser.js" || entrypoint === "./bin/agent-browser.js";
}

function stockLauncherBinary(absoluteShim: string): string | undefined {
	try {
		if (statSync(absoluteShim).size > 512) {
			return undefined;
		}
		const text = readFileSync(absoluteShim, "utf8");
		const binaryName =
			/^@ECHO off\r?\n"%~dp0\\?node_modules\\agent-browser\\bin\\(agent-browser-win32-(?:x64|arm64)\.exe)" %\*(?:\r?\n)?(?![\s\S])/.exec(
				text,
			)?.[1];
		if (binaryName === undefined) {
			return undefined;
		}
		const packageRoot = join(dirname(absoluteShim), "node_modules", "agent-browser");
		const manifest: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
		if (!isStockAgentBrowserManifest(manifest)) {
			return undefined;
		}
		const binary = join(packageRoot, "bin", binaryName);
		return statSync(binary).isFile() ? binary : undefined;
	} catch {
		return undefined;
	}
}

/** Bypass only upstream's optimized npm CMD shim: cmd.exe loses literal CR/LF.
 * Keep which/path-key aligned with cross-spawn's public dependency versions.
 * Unknown/custom launchers stay on cross-spawn.
 */
export function resolveWindowsStockLauncher(
	cwd: string,
	env: Readonly<NodeJS.ProcessEnv>,
): string | undefined {
	if (
		process.platform !== "win32" ||
		!isMainThread ||
		!hasStockEnvironment(env) ||
		!hasNativeCommandShell()
	) {
		return undefined;
	}
	const selected = selectLauncher(cwd, env);
	// cross-spawn's extensionless lookup cannot select this CMD shim.
	if (selected === undefined || selected === null || !selected.toLowerCase().endsWith(".cmd")) {
		return undefined;
	}
	return stockLauncherBinary(resolve(cwd, selected));
}
