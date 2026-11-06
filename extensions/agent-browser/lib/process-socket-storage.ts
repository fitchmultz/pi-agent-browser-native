import { lstat, mkdir, readdir, readlink, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { env as processEnv, platform as processPlatform } from "node:process";
import { parseArgvDescriptor } from "./argv-descriptor.js";
import { extractExplicitSessionName, resolveAgentBrowserNamespace } from "./argv-grammar.js";
import { getAgentBrowserProcessEnvironment } from "./process-environment.js";
import { getCurrentProcessUid } from "./process-identity.js";
import { getErrorCode } from "./process-errors.js";

const AGENT_BROWSER_SOCKET_DIR_ENV = "AGENT_BROWSER_SOCKET_DIR";
const PI_AGENT_BROWSER_SOCKET_DIR_ENV = "PI_AGENT_BROWSER_SOCKET_DIR";
const TERMUX_PACKAGE_NAME_PATTERN = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/;
interface DirectoryMetadata {
	readonly gid: number;
	readonly uid: number;
	readonly mode: number;
	readonly isDirectory: () => boolean;
	readonly isSymbolicLink: () => boolean;
}

function isTermuxAppRoot(platform: NodeJS.Platform, packageName: string | undefined): boolean {
	return (
		platform === "android" &&
		packageName !== undefined &&
		packageName.length > 0 &&
		TERMUX_PACKAGE_NAME_PATTERN.test(packageName)
	);
}

export function getAgentBrowserSocketDir(
	platform: NodeJS.Platform = processPlatform,
	uid: number | undefined = getCurrentProcessUid(),
	termuxPackageName: string | undefined = processEnv.TERMUX_APP__PACKAGE_NAME,
): string | undefined {
	if (platform === "win32") {
		return undefined;
	}
	const termuxAppRoot = isTermuxAppRoot(platform, termuxPackageName);
	let prefix = "/tmp/piab";
	if (platform === "darwin") {
		prefix = "/private/tmp/piab";
	} else if (termuxAppRoot) {
		prefix = `/data/data/${termuxPackageName ?? ""}/piab`;
	}
	return `${prefix}${!termuxAppRoot && typeof uid === "number" ? `-${uid}` : ""}`;
}

export function resolveAgentBrowserSocketDir(
	options: {
		readonly env?: NodeJS.ProcessEnv | undefined;
		readonly ownedManagedSession?: boolean | undefined;
		readonly parentEnv?: NodeJS.ProcessEnv | undefined;
	} = {},
): string | undefined {
	const parentEnv = options.parentEnv ?? getAgentBrowserProcessEnvironment();
	return (
		options.env?.[AGENT_BROWSER_SOCKET_DIR_ENV] ??
		parentEnv[PI_AGENT_BROWSER_SOCKET_DIR_ENV] ??
		(options.ownedManagedSession !== true ? parentEnv[AGENT_BROWSER_SOCKET_DIR_ENV] : undefined) ??
		getAgentBrowserSocketDir()
	);
}

export function isTrustedAndroidAppDataRoot(
	path: string,
	metadata: Readonly<Omit<DirectoryMetadata, "gid">>,
	uid: number,
	platform: NodeJS.Platform = processPlatform,
): boolean {
	if (
		platform !== "android" ||
		metadata.uid !== uid ||
		metadata.isSymbolicLink() ||
		!metadata.isDirectory() ||
		(metadata.mode & 0o777) !== 0o700
	) {
		return false;
	}
	const parent = dirname(path);
	return parent === "/data/data" || /^\/data\/user\/\d+$/.test(parent);
}

function isPrivateAndroidAncestor(
	metadata: DirectoryMetadata,
	uid: number,
	platform: NodeJS.Platform,
): boolean {
	return platform === "android" && uid !== 0 && metadata.uid === uid && metadata.gid === uid;
}

export function isTrustedSocketDirAncestor(
	metadata: DirectoryMetadata,
	uid: number,
	platform: NodeJS.Platform = processPlatform,
): boolean {
	if (metadata.isSymbolicLink()) {
		return metadata.uid === 0;
	}
	if (!metadata.isDirectory()) {
		return false;
	}
	const mode = metadata.mode & 0o7777;
	if (isPrivateAndroidAncestor(metadata, uid, platform)) {
		return (mode & 0o002) === 0;
	}
	if (metadata.uid === uid && uid !== 0) {
		return (mode & 0o022) === 0;
	}
	return metadata.uid === 0 && ((mode & 0o022) === 0 || (mode & 0o1000) !== 0);
}

class SocketStorageInspection {
	private readonly visited = new Set<string>();
	private entryCount = 0;
	constructor(private readonly uid: number) {}

	async ancestry(socketDir: string): Promise<boolean> {
		let current = dirname(socketDir);
		while (true) {
			current = current.replace(/\/+$/, "");
			if (current.length === 0) {
				current = "/";
			}
			if (this.visited.has(current)) {
				return true;
			}
			this.visited.add(current);
			// Each ancestor and symlink destination must be inspected before advancing the walk.
			const metadata = await lstat(current);
			if (this.isSystemRoot(current, metadata)) {
				return true;
			}
			if (!isTrustedSocketDirAncestor(metadata, this.uid)) {
				return false;
			}
			if (metadata.isSymbolicLink()) {
				// Resolving one link requires validating its target before continuing this ancestry.
				if (!(await this.symlink(current))) {
					return false;
				}
			}
			const parent = dirname(current);
			if (parent === current) {
				return true;
			}
			current = parent;
		}
	}

	private isSystemRoot(path: string, metadata: DirectoryMetadata): boolean {
		// The environment supplies /; its owner may be unmapped in a user namespace.
		return (
			(path === "/" && metadata.isDirectory() && (metadata.mode & 0o022) === 0) ||
			isTrustedAndroidAppDataRoot(path, metadata, this.uid)
		);
	}
	private async symlink(current: string): Promise<boolean> {
		if (!isTrustedSocketDirAncestor(await stat(current), this.uid)) {
			return false;
		}
		const target = await readlink(current);
		const targetPath = isAbsolute(target) ? target : `${dirname(current)}/${target}`;
		// Keep '..' after symlinks intact; '/.' includes the target itself in the parent walk.
		return await this.ancestry(`${targetPath}/.`);
	}

	async entries(socketDir: string): Promise<boolean> {
		for (const name of await readdir(socketDir)) {
			this.entryCount += 1;
			if (this.entryCount > 16_384) {
				return false;
			}
			// A single shared bound and fail-closed traversal prevent unbounded recursive inspection.
			if (!(await this.entry(join(socketDir, name)))) {
				return false;
			}
		}
		return true;
	}

	private async entry(path: string): Promise<boolean> {
		try {
			const metadata = await lstat(path);
			if (metadata.uid !== this.uid || metadata.isSymbolicLink()) {
				return false;
			}
			if (metadata.isDirectory()) {
				return await this.entries(path);
			}
			return metadata.isFile() || metadata.isSocket();
		} catch (error) {
			return getErrorCode(error) === "ENOENT";
		}
	}
}

async function validateWindowsDirectory(socketDir: string): Promise<string | undefined> {
	try {
		try {
			await mkdir(socketDir);
		} catch (error) {
			if (getErrorCode(error) !== "EEXIST") {
				throw error;
			}
		}
		const metadata = await lstat(socketDir);
		if (metadata.isSymbolicLink()) {
			return "the directory is a symlink";
		}
		return metadata.isDirectory() ? undefined : "the path is not a directory";
	} catch (error) {
		return `the directory could not be inspected (${getErrorCode(error) ?? "unknown error"})`;
	}
}

export async function getAgentBrowserSocketDirValidationError(
	socketDir: string,
	uid: number | undefined = getCurrentProcessUid(),
	platform: NodeJS.Platform = processPlatform,
): Promise<string | undefined> {
	if (!isAbsolute(socketDir)) {
		return "the path is not absolute";
	}
	// Windows uses native ACLs and named pipes, but still requires a real directory.
	if (platform === "win32") {
		return await validateWindowsDirectory(socketDir);
	}
	if (typeof uid !== "number") {
		return "POSIX ownership metadata is unavailable";
	}
	try {
		if (!(await new SocketStorageInspection(uid).ancestry(socketDir))) {
			return "an ancestor is writable, foreign-owned, a non-directory, or an untrusted symlink";
		}
		const creationError = await createPosixSocketDirectory(socketDir);
		return creationError ?? (await validatePosixDirectory(socketDir, uid));
	} catch (error) {
		return `the directory could not be inspected (${getErrorCode(error) ?? "unknown error"})`;
	}
}

async function createPosixSocketDirectory(socketDir: string): Promise<string | undefined> {
	try {
		await mkdir(socketDir, { mode: 0o700 });
	} catch (error) {
		if (getErrorCode(error) !== "EEXIST") {
			return `the directory could not be created (${getErrorCode(error) ?? "unknown error"})`;
		}
	}
	return undefined;
}
async function validatePosixDirectory(socketDir: string, uid: number): Promise<string | undefined> {
	const metadata = await lstat(socketDir);
	if (!metadata.isDirectory()) {
		return "the path is not a directory";
	}
	if (metadata.isSymbolicLink()) {
		return "the directory is a symlink";
	}
	if (metadata.uid !== uid) {
		return `the directory is owned by uid ${metadata.uid}, not uid ${uid}`;
	}
	if ((metadata.mode & 0o777) !== 0o700) {
		return `the directory mode is ${(metadata.mode & 0o777).toString(8)}, not 700`;
	}
	if (!(await new SocketStorageInspection(uid).ancestry(socketDir))) {
		return "an ancestor became untrusted during validation";
	}
	if (!(await new SocketStorageInspection(uid).entries(socketDir))) {
		return "the directory contains a foreign-owned, symlink, special, or excessively deep entry";
	}
	return undefined;
}

function nativeSocketRoot(options: {
	readonly args: readonly string[];
	readonly env?: NodeJS.ProcessEnv;
	readonly socketDir: string;
}): string {
	const namespace = resolveAgentBrowserNamespace(
		options.args,
		options.env?.AGENT_BROWSER_NAMESPACE,
	);
	return namespace !== undefined && namespace.length > 0
		? join(options.socketDir, "namespaces", namespace, "run")
		: options.socketDir;
}

export function getAgentBrowserSocketPathValidationError(options: {
	readonly args: readonly string[];
	readonly env?: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly socketDir: string;
}): string | undefined {
	if ((options.platform ?? processPlatform) === "win32") {
		return undefined;
	}
	const { command } = parseArgvDescriptor(options.args).commandInfo;
	// Preflight browser-launch/navigation only; follow-up/cleanup may inspect an earlier daemon.
	if (
		command === undefined ||
		command.length === 0 ||
		!["batch", "connect", "goto", "navigate", "open", "visit"].includes(command)
	) {
		return undefined;
	}
	const sessionName = extractExplicitSessionName(options.args);
	if (sessionName === undefined || sessionName.length === 0) {
		return undefined;
	}
	const socketRoot = nativeSocketRoot(options);
	const pathBytes = Buffer.byteLength(join(socketRoot, `${sessionName}.sock`));
	if (pathBytes <= 103) {
		return undefined;
	}
	return `Agent-browser Unix socket path would be ${pathBytes} bytes (max 103) for session ${JSON.stringify(sessionName)} under ${JSON.stringify(options.socketDir)}. Set PI_AGENT_BROWSER_SOCKET_DIR to a shorter absolute private directory such as /tmp/piab-<uid> with mode 0700; retrying sessionMode "fresh" cannot shorten this configured root.`;
}
