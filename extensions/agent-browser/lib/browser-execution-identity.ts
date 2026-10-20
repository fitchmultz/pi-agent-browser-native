import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalizeAgentBrowserNamespace,
	foldAgentBrowserFilesystemIdentity,
} from "./argv-grammar.js";
import {
	getAgentBrowserSocketDirValidationError,
	resolveAgentBrowserSocketDir,
} from "./process-socket-storage.js";
import { getCurrentProcessUid } from "./process-identity.js";
import { getErrorCode } from "./process-errors.js";
import { debugPolicyFailure } from "./browser-execution-policy-debug.js";

export interface BrowserExecutionIdentity {
	readonly socketContext: string;
	readonly sessionName?: string;
}
export interface ExecutionClaimIdentity {
	readonly socketContext: string;
	readonly sessionNames: readonly string[] | null;
}
export function getCoordinationDirectory(platform: NodeJS.Platform = process.platform): string {
	if (platform !== "win32") {
		const uid = getCurrentProcessUid();
		const suffix = uid === undefined ? "" : `-${uid}`;
		return platform === "android"
			? join(tmpdir(), `pi-agent-browser-policy${suffix}`)
			: `/tmp/pi-agent-browser-policy${suffix}`;
	}
	const user = process.env.USERNAME ?? process.env.USER ?? "unknown";
	const suffix = createHash("sha256").update(user).digest("hex").slice(0, 12);
	return join(tmpdir(), `pi-agent-browser-policy-${suffix}`);
}
function directoryOwnerTrusted(entry: Stats, platform: NodeJS.Platform): boolean {
	if (platform === "win32") {
		return true;
	}
	const uid = getCurrentProcessUid();
	return uid !== undefined && entry.uid === uid && (entry.mode & 0o077) === 0;
}
export async function ensureCoordinationDirectory(
	path: string,
	platform: NodeJS.Platform,
): Promise<boolean> {
	let stage = "prepare.directory-mkdir";
	try {
		try {
			await mkdir(path, { mode: 0o700 });
		} catch (error) {
			if (getErrorCode(error) !== "EEXIST") {
				debugPolicyFailure(stage, "native-error", error);
				return false;
			}
		}
		stage = "prepare.directory-stat";
		const entry = await lstat(path);
		const trusted =
			!entry.isSymbolicLink() && entry.isDirectory() && directoryOwnerTrusted(entry, platform);
		if (!trusted) {
			debugPolicyFailure(stage, "unsafe-metadata");
		}
		return trusted;
	} catch (error) {
		debugPolicyFailure(stage, "native-error", error);
		return false;
	}
}
/** Resolve only after native routing; omit sessionName for a namespace-wide operation. */
export async function resolveBrowserExecutionIdentity(options: {
	readonly env?: NodeJS.ProcessEnv;
	readonly namespace?: string;
	readonly ownedManagedSession?: boolean;
	readonly sessionName?: string;
}): Promise<BrowserExecutionIdentity> {
	const socketDir = resolveAgentBrowserSocketDir(options);
	const namespace = canonicalizeAgentBrowserNamespace(options.namespace);
	let socketContext: string;
	if (process.platform === "win32") {
		// Windows native TCP daemons are shared across storage roots; don't split their coordination.
		socketContext = `win32-native:${namespace ?? ""}`;
	} else {
		if (socketDir === undefined) {
			throw new Error("Browser execution coordination requires the native socket directory.");
		}
		const error = await getAgentBrowserSocketDirValidationError(socketDir);
		if (error !== undefined && error.length > 0) {
			throw new Error(`Browser execution coordination cannot use socket storage: ${error}.`);
		}
		const root = await realpath(socketDir);
		socketContext =
			namespace !== undefined && namespace.length > 0
				? join(root, "namespaces", namespace, "run")
				: root;
	}
	return {
		socketContext: foldAgentBrowserFilesystemIdentity(socketContext, process.platform),
		...(options.sessionName !== undefined
			? { sessionName: foldAgentBrowserFilesystemIdentity(options.sessionName, process.platform) }
			: {}),
	};
}
export function getBrowserExecutionLockPath(
	identity: Readonly<Pick<BrowserExecutionIdentity, "socketContext">>,
): string {
	return join(
		getCoordinationDirectory(),
		`.pi-agent-browser-policy-${createHash("sha256").update(identity.socketContext).digest("hex")}.lock-v4`,
	);
}
