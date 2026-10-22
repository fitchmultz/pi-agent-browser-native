#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const revision = "eb9339115edde6811ca94c3433adf69ea9852880";
const compilerRevision = "2bd066d87f5bafd315be9f40889d0a60b9e58e0b";
const version = "7.0.2003";
const frontendVersion = "1.87.0";
const goToolchain = "go1.27.1";
const patchPath = join(root, "patches", "oxlint-tsgolint.patch");

function hash(value) {
	return createHash("sha256").update(value).digest("hex");
}

function terminateBuildChild(child) {
	if (child.pid === undefined) {
		return;
	}
	if (process.platform === "win32") {
		const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
		});
		if (result.error !== undefined || result.status !== 0) {
			throw result.error ?? new Error(`taskkill failed for build child ${child.pid}`);
		}
		return;
	}
	try {
		// Each build command has its own process group, including its Git/Go descendants.
		process.kill(-child.pid, "SIGKILL");
	} catch (error) {
		if (error.code !== "ESRCH") {
			throw error;
		}
	}
}

function buildLifecycle() {
	const controller = new AbortController();
	const children = new Set();
	const cleanupFailures = new Set();
	const interrupt = () => {
		controller.abort();
		for (const child of children) {
			try {
				terminateBuildChild(child);
			} catch (error) {
				// Retain staging if the OS cannot confirm cancellation of the owned child tree.
				cleanupFailures.add(error);
				child.kill();
			}
		}
	};
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", interrupt);
	return {
		signal: controller.signal,
		children,
		cleanupFailures,
		dispose() {
			process.removeListener("SIGINT", interrupt);
			process.removeListener("SIGTERM", interrupt);
		},
	};
}

function run(command, args, cwd, lifecycle) {
	lifecycle.signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = crossSpawn.spawn(command, args, {
			cwd,
			env: { ...process.env, GOTOOLCHAIN: goToolchain },
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		lifecycle.children.add(child);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			lifecycle.children.delete(child);
			if (lifecycle.signal.aborted) {
				reject(new Error(`Quality checker build interrupted during ${command}.`));
				return;
			}
			if (code === 0) {
				resolve(stdout.trim());
				return;
			}
			reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr}`));
		});
	});
}

function readCachedBinary(directory, fingerprint) {
	const binary = join(directory, process.platform === "win32" ? "tsgolint.exe" : "tsgolint");
	try {
		const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
		if (manifest.fingerprint === fingerprint && manifest.sha256 === hash(readFileSync(binary))) {
			return binary;
		}
	} catch {
		// An incomplete or corrupted task-owned cache is rebuilt from pinned source.
	}
	return;
}

async function build(directory, fingerprint, patch, lifecycle) {
	const source = join(directory, "source");
	const stagedPatch = join(directory, "checker.patch");
	writeFileSync(stagedPatch, patch);
	await run(
		"git",
		[
			"clone",
			"--quiet",
			"--no-checkout",
			"--filter=blob:none",
			"https://github.com/oxc-project/tsgolint.git",
			source,
		],
		root,
		lifecycle,
	);
	await run("git", ["checkout", "--quiet", revision], source, lifecycle);
	if ((await run("git", ["rev-parse", "HEAD"], source, lifecycle)) !== revision) {
		throw new Error("Quality checker source revision mismatch.");
	}
	// Git for Windows must materialize the pinned compiler's >260-character paths.
	// Command configuration also reaches the nested checkout; no user config is changed.
	await run(
		"git",
		["-c", "core.longpaths=true", "submodule", "update", "--init", "--depth", "1", "typescript-go"],
		source,
		lifecycle,
	);
	if (
		(await run("git", ["rev-parse", "HEAD"], join(source, "typescript-go"), lifecycle)) !==
		compilerRevision
	) {
		throw new Error("Quality checker compiler revision mismatch.");
	}
	await initializeCompiler(source, lifecycle);
	await run("git", ["apply", "--check", stagedPatch], source, lifecycle);
	await run("git", ["apply", stagedPatch], source, lifecycle);
	const binary = join(directory, process.platform === "win32" ? "tsgolint.exe" : "tsgolint");
	await run(
		"go",
		["build", "-trimpath", "-buildvcs=false", "-o", binary, "./cmd/tsgolint"],
		source,
		lifecycle,
	);
	writeFileSync(
		join(directory, "manifest.json"),
		`${JSON.stringify({ fingerprint, revision, compilerRevision, version, goToolchain, sha256: hash(readFileSync(binary)) }, null, 2)}\n`,
	);
	rmSync(source, { recursive: true, force: true });
}

async function initializeCompiler(source, lifecycle) {
	const compiler = join(source, "typescript-go");
	const patches = readdirSync(join(source, "patches"))
		.filter((name) => name.endsWith(".patch"))
		.sort()
		.map((name) => join(source, "patches", name));
	// These are the pinned backend's own compiler patches, applied in its maintained init order.
	await run(
		"git",
		[
			// git am refreshes the compiler index, including its long test-data paths.
			"-c",
			"core.longpaths=true",
			"-c",
			"user.name=Quality checker build",
			"-c",
			"user.email=quality-checker@localhost",
			"am",
			"--3way",
			"--no-gpg-sign",
			...patches,
		],
		compiler,
		lifecycle,
	);
	cpSync(join(compiler, "internal", "collections"), join(source, "internal", "collections"), {
		recursive: true,
		filter: (entry) => !entry.endsWith("_test.go"),
	});
}

export async function prepareQualityChecker() {
	for (const [name, expected] of [
		["oxlint", frontendVersion],
		["oxlint-tsgolint", version],
	]) {
		const installed = JSON.parse(
			readFileSync(join(root, "node_modules", name, "package.json"), "utf8"),
		);
		if (installed.version !== expected) {
			throw new Error(`Checker patch requires ${name} ${expected}; requalify it before upgrading.`);
		}
	}
	const patch = readFileSync(patchPath);
	const fingerprint = hash(
		[
			revision,
			compilerRevision,
			frontendVersion,
			version,
			goToolchain,
			process.platform,
			process.arch,
			hash(patch),
			hash(readFileSync(fileURLToPath(import.meta.url))),
		].join("\n"),
	);
	const cache = join(root, "node_modules", ".cache", "pi-agent-browser-quality");
	const destination = join(cache, fingerprint);
	const cached = readCachedBinary(destination, fingerprint);
	if (cached !== undefined) {
		return cached;
	}
	mkdirSync(cache, { recursive: true });
	const staging = mkdtempSync(join(cache, ".build-"));
	const lifecycle = buildLifecycle();
	try {
		// ponytail: build the pinned backend until upstream fixes pass our isolation/container probes.
		await build(staging, fingerprint, patch, lifecycle);
		lifecycle.signal.throwIfAborted();
		if (existsSync(destination)) {
			const published = readCachedBinary(destination, fingerprint);
			if (published !== undefined) {
				return published;
			}
			rmSync(destination, { recursive: true, force: true });
		}
		try {
			renameSync(staging, destination);
		} catch (error) {
			// Concurrent clean-process probes may publish the same verified artifact first.
			const published = readCachedBinary(destination, fingerprint);
			if (published !== undefined) {
				return published;
			}
			throw error;
		}
		const binary = readCachedBinary(destination, fingerprint);
		if (binary === undefined) {
			throw new Error("Built quality checker failed artifact verification.");
		}
		return binary;
	} finally {
		lifecycle.dispose();
		if (lifecycle.cleanupFailures.size === 0) {
			rmSync(staging, { recursive: true, force: true });
		} else {
			console.error(`Build cancellation failed; retained owned staging directory: ${staging}`);
		}
	}
}

async function main(args) {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(
			"Usage: node scripts/prepare-quality-checker.mjs\n\nBuild/cache the pinned corrected Oxlint backend. Requires Git and Go (Go 1.27.1 is selected automatically).\nExample: npm run lint\nExit codes: 0 ready/help; 1 build or integrity failure.",
		);
		return;
	}
	if (args.length !== 0) {
		throw new Error(`Unexpected arguments: ${args.join(" ")}`);
	}
	console.log(await prepareQualityChecker());
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
