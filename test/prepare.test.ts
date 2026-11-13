import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest from "node:test";
import { promisify } from "node:util";
import { npmCommand, npmExecOptions } from "../scripts/package-pack.mjs";
import { readArray, readRecord } from "./helpers/assertions.js";

// Native execFile returns ChildProcess and supplies custom promisify; the ambient callback expects void.
const execFile = promisify(execFileCallback);
const buildModules = [
	"typescript",
	"esbuild",
	"typebox",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
] as const;
const installDevArgs = [
	"install",
	"--include=dev",
	"--legacy-peer-deps",
	"--ignore-scripts",
	"--no-audit",
	"--no-fund",
];
const pruneDevArgs = [
	"prune",
	"--omit=dev",
	"--legacy-peer-deps",
	"--ignore-scripts",
	"--no-audit",
	"--no-fund",
];

async function createIsolatedNpmEnv(rootDir: string): Promise<NodeJS.ProcessEnv> {
	const cacheDir = join(rootDir, "npm-cache");
	const userConfig = join(rootDir, "user.npmrc");
	const globalConfig = join(rootDir, "global.npmrc");
	await mkdir(cacheDir, { recursive: true });
	await writeFile(userConfig, "");
	await writeFile(globalConfig, "");
	return {
		...process.env,
		npm_config_cache: cacheDir,
		npm_config_globalconfig: globalConfig,
		npm_config_userconfig: userConfig,
	};
}

async function packLocalPackage(
	packagesDir: string,
	tarballsDir: string,
	packageName: string,
	env: NodeJS.ProcessEnv,
): Promise<string> {
	const slug = packageName.replaceAll("@", "").replaceAll("/", "-");
	const pkgDir = join(packagesDir, slug);
	await mkdir(pkgDir, { recursive: true });
	await writeFile(
		join(pkgDir, "package.json"),
		JSON.stringify({
			name: packageName,
			version: "1.0.0",
			type: "module",
			exports: { ".": { import: "./index.js" } },
		}),
	);
	await writeFile(join(pkgDir, "index.js"), `export const pkg = ${JSON.stringify(packageName)};\n`);
	const { stdout } = await execFile(
		npmCommand,
		["pack", "--pack-destination", tarballsDir, "--dry-run=false"],
		{
			...npmExecOptions,
			cwd: pkgDir,
			env,
			timeout: 30_000,
		},
	);
	const filename = stdout.trim().split(/\r?\n/u).at(-1);
	assert.ok(filename !== undefined && filename.length > 0, `expected tarball for ${packageName}`);
	return `file:${join(tarballsDir, filename)}`;
}

async function createRealNpmPrepareFixture(
	rootDir: string,
	options: { readonly failBuild?: boolean } = {},
): Promise<{ readonly appDir: string; readonly env: NodeJS.ProcessEnv }> {
	const env = await createIsolatedNpmEnv(rootDir);
	const packagesDir = join(rootDir, "packages");
	const tarballsDir = join(rootDir, "tarballs");
	const appDir = join(rootDir, "app");
	await mkdir(tarballsDir, { recursive: true });
	await mkdir(join(appDir, "scripts"), { recursive: true });
	await copyFile(
		new URL("../scripts/prepare.mjs", import.meta.url),
		join(appDir, "scripts", "prepare.mjs"),
	);

	const runtimeSpec = await packLocalPackage(packagesDir, tarballsDir, "runtime-dep", env);
	const devEntries: [string, string][] = [];
	for (const name of buildModules) {
		// Sequential local packs keep temp directory writes deterministic.
		devEntries.push([name, await packLocalPackage(packagesDir, tarballsDir, name, env)]);
	}

	await writeFile(
		join(appDir, "package.json"),
		JSON.stringify({
			name: "prepare-fixture-app",
			version: "1.0.0",
			private: true,
			type: "module",
			scripts: {
				prepare: "node ./scripts/prepare.mjs",
			},
			dependencies: {
				"runtime-dep": runtimeSpec,
			},
			peerDependencies: {
				"@earendil-works/pi-coding-agent": "*",
				"@earendil-works/pi-tui": "*",
				typebox: "*",
			},
			peerDependenciesMeta: {
				"@earendil-works/pi-coding-agent": { optional: true },
				"@earendil-works/pi-tui": { optional: true },
				typebox: { optional: true },
			},
			devDependencies: Object.fromEntries(devEntries),
		}),
	);

	const buildOutcome =
		options.failBuild === true
			? `throw new Error("simulated build failure");`
			: `await mkdir("dist/extensions/agent-browser", { recursive: true });
await writeFile("dist/extensions/agent-browser/index.js", JSON.stringify({ loaded }) + "\\n");`;

	await writeFile(
		join(appDir, "scripts", "build.mjs"),
		`import { mkdir, writeFile } from "node:fs/promises";
const loaded = [];
for (const specifier of ${JSON.stringify(buildModules)}) {
	const mod = await import(specifier);
	loaded.push(mod.pkg);
}
${buildOutcome}
`,
	);

	return { appDir, env };
}

for (const [description, missingPath] of [
	["builds without installing when import-only dependencies exist", undefined],
	[
		"installs before building and prunes afterward when a dependency is missing",
		"node_modules/typescript",
	],
	[
		"installs before building and prunes afterward when the bundler is missing",
		"node_modules/esbuild",
	],
	[
		"installs before building and prunes afterward when an exported target is missing",
		"node_modules/@earendil-works/pi-coding-agent/index.js",
	],
] as const) {
	nodeTest(`prepare ${description}`, async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-prepare-"));
		t.after(() => rm(tempDir, { force: true, recursive: true }));
		await mkdir(join(tempDir, "scripts"));
		await copyFile(
			new URL("../scripts/prepare.mjs", import.meta.url),
			join(tempDir, "scripts", "prepare.mjs"),
		);
		await writeFile(
			join(tempDir, "package.json"),
			JSON.stringify({
				type: "module",
				devDependencies: Object.fromEntries(buildModules.map((name) => [name, "1.0.0"])),
			}),
		);
		for (const name of buildModules) {
			const moduleDir = join(tempDir, "node_modules", name);
			// Fixture transitions and their assertions run in order against this test's shared state.
			await mkdir(moduleDir, { recursive: true });
			// Fixture transitions and their assertions run in order against this test's shared state.
			await writeFile(
				join(moduleDir, "package.json"),
				JSON.stringify({
					name,
					version: "1.0.0",
					type: "module",
					exports: { ".": { import: "./index.js" } },
				}),
			);
			// Fixture transitions and their assertions run in order against this test's shared state.
			await writeFile(join(moduleDir, "index.js"), "export {};\n");
		}
		if (missingPath !== undefined) {
			await rm(join(tempDir, missingPath), { recursive: true });
		}

		const npmExecPath = join(tempDir, "npm.mjs");
		await writeFile(
			npmExecPath,
			`
import { appendFileSync } from "node:fs";
appendFileSync("calls.jsonl", JSON.stringify({ argv: process.argv.slice(2), omit: process.env.npm_config_omit ?? null, include: process.env.npm_config_include ?? null, production: process.env.npm_config_production ?? null, dryRun: process.env.npm_config_dry_run ?? null }) + "\\n");
`,
		);
		await writeFile(
			join(tempDir, "scripts", "build.mjs"),
			`
import { appendFileSync } from "node:fs";
appendFileSync("calls.jsonl", JSON.stringify({ argv: ["build"], omit: null, include: null, production: null, dryRun: null }) + "\\n");
`,
		);

		await execFile(process.execPath, [join(tempDir, "scripts", "prepare.mjs")], {
			cwd: tempDir,
			env: {
				...process.env,
				npm_execpath: npmExecPath,
				npm_config_dry_run: "true",
				npm_config_include: "dev",
				npm_config_omit: "dev",
				npm_config_production: "true",
			},
			timeout: 10_000,
		});
		const calls = (await readFile(join(tempDir, "calls.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => {
				const record = readRecord(JSON.parse(line));
				return {
					argv: readArray(record.argv),
					dryRun: record.dryRun,
					include: record.include,
					omit: record.omit,
					production: record.production,
				};
			});
		assert.deepEqual(
			calls,
			missingPath !== undefined
				? [
						{ argv: installDevArgs, dryRun: null, include: null, omit: null, production: null },
						{ argv: ["build"], dryRun: null, include: null, omit: null, production: null },
						{ argv: pruneDevArgs, dryRun: null, include: null, omit: null, production: null },
					]
				: [{ argv: ["build"], dryRun: null, include: null, omit: null, production: null }],
		);
	});
}

nodeTest(
	"prepare bootstraps missing build dependencies during npm install --omit=dev and prunes them afterward",
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-prepare-omit-dev-"));
		t.after(() => rm(tempDir, { force: true, recursive: true }));
		const { appDir, env } = await createRealNpmPrepareFixture(tempDir);

		await execFile(
			npmCommand,
			["install", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"],
			{
				...npmExecOptions,
				cwd: appDir,
				env,
				timeout: 60_000,
			},
		);

		const built = readRecord(
			JSON.parse(await readFile(join(appDir, "dist/extensions/agent-browser/index.js"), "utf8")),
		);
		assert.deepEqual(readArray(built.loaded), [...buildModules]);
		assert.equal(existsSync(join(appDir, "node_modules", "runtime-dep", "index.js")), true);
		const { stdout } = await execFile(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				'const mod = await import("runtime-dep"); process.stdout.write(mod.pkg);',
			],
			{ cwd: appDir, timeout: 10_000 },
		);
		assert.equal(stdout, "runtime-dep");
		assert.deepEqual(
			buildModules.map((name) => [name, existsSync(join(appDir, "node_modules", name))]),
			buildModules.map((name) => [name, false]),
		);
	},
);

nodeTest(
	"prepare preserves pre-existing devDependencies in a local development checkout",
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-prepare-dev-checkout-"));
		t.after(() => rm(tempDir, { force: true, recursive: true }));
		const { appDir, env } = await createRealNpmPrepareFixture(tempDir);

		await execFile(npmCommand, ["install", "--legacy-peer-deps", "--no-audit", "--no-fund"], {
			...npmExecOptions,
			cwd: appDir,
			env,
			timeout: 60_000,
		});

		const built = readRecord(
			JSON.parse(await readFile(join(appDir, "dist/extensions/agent-browser/index.js"), "utf8")),
		);
		assert.deepEqual(readArray(built.loaded), [...buildModules]);
		assert.equal(existsSync(join(appDir, "node_modules", "runtime-dep", "index.js")), true);
		assert.deepEqual(
			buildModules.map((name) => [
				name,
				existsSync(join(appDir, "node_modules", name, "index.js")),
			]),
			buildModules.map((name) => [name, true]),
		);
	},
);

nodeTest(
	"prepare prunes temporary devDependencies even when scripts/build.mjs fails",
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-prepare-build-failure-"));
		t.after(() => rm(tempDir, { force: true, recursive: true }));
		const { appDir, env } = await createRealNpmPrepareFixture(tempDir, { failBuild: true });

		await assert.rejects(
			execFile(
				npmCommand,
				["install", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"],
				{
					...npmExecOptions,
					cwd: appDir,
					env,
					timeout: 60_000,
				},
			),
			/simulated build failure/u,
		);

		assert.equal(existsSync(join(appDir, "node_modules", "runtime-dep", "index.js")), true);
		assert.deepEqual(
			buildModules.map((name) => [name, existsSync(join(appDir, "node_modules", name))]),
			buildModules.map((name) => [name, false]),
		);
	},
);
