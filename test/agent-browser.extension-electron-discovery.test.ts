/**
 * Purpose: Verify Electron app discovery contracts.
 * Responsibilities: Assert macOS bundles/query filtering, sensitivity annotations, Linux desktop evidence, and result caps.
 * Scope: Integration-style Node test-runner coverage around the extension harness before result presentation and tab lifecycle suites.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-electron-discovery.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test from "node:test";

import {
	discoverElectronApps,
	inspectElectronAppPath,
	inspectElectronExecutablePath,
} from "../extensions/agent-browser/lib/electron/discovery.js";

import {
	electronAppNames,
	writeFakeLinuxElectronBinary,
	writeFakeMacElectronApp,
} from "./helpers/extension-validation-fixtures.js";

test("electron discovery finds macOS Electron app bundles with query filtering", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-macos-"));
	try {
		const applicationsDir = join(tempDir, "Applications");
		await mkdir(applicationsDir, { recursive: true });
		const alpha = await writeFakeMacElectronApp({
			applicationsDir,
			bundleId: "com.example.Alpha",
			executableName: "AlphaBin",
			name: "Alpha App",
		});
		await writeFakeMacElectronApp({
			applicationsDir,
			bundleId: "com.example.Beta",
			executableName: "BetaBin",
			name: "Beta App",
		});
		const nonElectronPath = join(applicationsDir, "Plain App.app");
		await mkdir(join(nonElectronPath, "Contents", "Resources"), { recursive: true });
		await writeFile(join(nonElectronPath, "Contents", "Resources", "app.asar"), "asar", "utf8");

		const all = await discoverElectronApps({
			locations: { darwinApplicationDirectories: [applicationsDir] },
			platform: "darwin",
		});
		assert.deepEqual(electronAppNames(all.apps), ["Alpha App", "Beta App"]);
		assert.equal(all.omittedCount, 0);
		assert.equal(all.apps.find((app) => app.name === "Alpha App")?.bundleId, "com.example.Alpha");
		assert.equal(all.apps.find((app) => app.name === "Alpha App")?.appPath, alpha.appPath);
		assert.equal(
			all.apps.find((app) => app.name === "Alpha App")?.executablePath,
			alpha.executablePath,
		);
		assert.equal(
			all.apps.every((app) => app.platform === "darwin"),
			true,
		);

		const byName = await discoverElectronApps({
			locations: { darwinApplicationDirectories: [applicationsDir] },
			platform: "darwin",
			query: "beta",
		});
		assert.deepEqual(electronAppNames(byName.apps), ["Beta App"]);
		const byBundleId = await discoverElectronApps({
			locations: { darwinApplicationDirectories: [applicationsDir] },
			platform: "darwin",
			query: "com.example.alpha",
		});
		assert.deepEqual(electronAppNames(byBundleId.apps), ["Alpha App"]);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("electron discovery annotates likely sensitive apps without blocking discovery", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-sensitive-"));
	try {
		const applicationsDir = join(tempDir, "Applications");
		await mkdir(applicationsDir, { recursive: true });
		await writeFakeMacElectronApp({
			applicationsDir,
			bundleId: "md.obsidian",
			executableName: "Obsidian",
			name: "Obsidian",
		});
		await writeFakeMacElectronApp({
			applicationsDir,
			bundleId: "com.tinyspeck.slackmacgap",
			executableName: "Slack",
			name: "Slack",
		});
		await writeFakeMacElectronApp({
			applicationsDir,
			bundleId: "com.microsoft.VSCode",
			executableName: "Code",
			name: "Visual Studio Code",
		});
		await writeFakeMacElectronApp({
			applicationsDir,
			bundleId: "com.example.Plain",
			executableName: "Plain",
			name: "Plain Electron",
		});

		const result = await discoverElectronApps({
			locations: { darwinApplicationDirectories: [applicationsDir] },
			platform: "darwin",
		});

		assert.equal(result.apps.length, 4);
		const byName = new Map(result.apps.map((app) => [app.name, app]));
		assert.deepEqual(byName.get("Obsidian")?.sensitivity, {
			categories: ["notes"],
			level: "likely-sensitive",
			reason:
				"App name, bundle id, desktop id, or path matched common private-data app patterns; discovery still does not enforce policy.",
		});
		assert.deepEqual(byName.get("Slack")?.sensitivity?.categories, ["chat"]);
		assert.deepEqual(byName.get("Visual Studio Code")?.sensitivity?.categories, [
			"developer-workspace",
		]);
		assert.equal(byName.get("Plain Electron")?.sensitivity, undefined);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("electron discovery and explicit paths accept the stock macOS runtime payload", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-stock-macos-"));
	try {
		const app = await writeFakeMacElectronApp({
			applicationsDir: tempDir,
			bundleId: "com.github.Electron",
			name: "Electron",
		});
		const resources = join(app.appPath, "Contents", "Resources");
		await rename(join(resources, "app.asar"), join(resources, "default_app.asar"));
		const discovered = await discoverElectronApps({
			locations: { darwinApplicationDirectories: [tempDir] },
			platform: "darwin",
		});
		assert.deepEqual(electronAppNames(discovered.apps), ["Electron"]);
		assert.equal(
			(await inspectElectronAppPath(app.appPath, "darwin"))?.executablePath,
			app.executablePath,
		);
		assert.equal(
			(await inspectElectronExecutablePath(app.executablePath, "darwin"))?.appPath,
			await realpath(app.appPath),
		);
		const framework = join(app.appPath, "Contents", "Frameworks", "Electron Framework.framework");
		await rm(framework, { recursive: true });
		assert.equal(await inspectElectronAppPath(app.appPath, "darwin"), undefined);
		await mkdir(framework);
		await rm(join(resources, "default_app.asar"));
		assert.equal(await inspectElectronAppPath(app.appPath, "darwin"), undefined);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

for (const platform of ["linux", "win32"] as const) {
	test(`electron explicit paths accept the stock ${platform} runtime but not bare Chromium paks`, async () => {
		const tempDir = await mkdtemp(join(tmpdir(), `pi-agent-browser-electron-stock-${platform}-`));
		try {
			const executable = await writeFakeLinuxElectronBinary(tempDir, "electron");
			const resources = join(dirname(executable), "resources");
			await rename(join(resources, "app.asar"), join(resources, "default_app.asar"));
			const expectedExecutable = await realpath(executable);
			assert.equal(
				(await inspectElectronExecutablePath(executable, platform))?.executablePath,
				expectedExecutable,
			);
			assert.equal(
				(await inspectElectronAppPath(executable, platform))?.executablePath,
				expectedExecutable,
			);
			await rm(join(resources, "default_app.asar"));
			assert.equal(await inspectElectronExecutablePath(executable, platform), undefined);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	});
}

// Use Linux separators for simulated desktop entries, then escape both the
// Exec token and desktop string layers. Keep actual filesystem assertions native.
function quoteDesktopExecPath(path: string): string {
	return JSON.stringify(path.split(sep).join("/")).replaceAll("\\", "\\\\");
}

test("electron discovery scans Linux desktop files and applies Electron evidence gates", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-linux-"));
	try {
		const desktopDir = join(tempDir, "applications");
		// Backslashes exercise both desktop-string and Exec-token escaping even on POSIX.
		const appRoot = join(tempDir, "opt with space\\literal");
		await mkdir(desktopDir, { recursive: true });
		const electronExecutable = await writeFakeLinuxElectronBinary(appRoot, "demo-electron");
		const resources = join(dirname(electronExecutable), "resources");
		await rename(join(resources, "app.asar"), join(resources, "default_app.asar"));
		const realElectronExecutable = await realpath(electronExecutable);
		const plainExecutable = join(appRoot, "plain", "plain");
		await mkdir(dirname(plainExecutable), { recursive: true });
		await writeFile(plainExecutable, "#!/bin/sh\n", "utf8");
		await chmod(plainExecutable, 0o755);

		await writeFile(
			join(desktopDir, "demo.desktop"),
			`[Desktop Entry]
Type=Application
Name=Demo Electron
Comment=Demo comment
Exec=${quoteDesktopExecPath(electronExecutable)} %U --ignored-field-code %F
Icon=demo-icon
`,
			"utf8",
		);
		await writeFile(
			join(desktopDir, "plain.desktop"),
			`[Desktop Entry]
Type=Application
Name=Plain Binary
Exec=${quoteDesktopExecPath(plainExecutable)} %U
`,
			"utf8",
		);
		await writeFile(
			join(desktopDir, "hidden.desktop"),
			`[Desktop Entry]
Type=Application
Name=Hidden Electron
Hidden=true
Exec=${quoteDesktopExecPath(electronExecutable)}
`,
			"utf8",
		);
		await writeFile(
			join(desktopDir, "nodisplay.desktop"),
			`[Desktop Entry]
Type=Application
Name=No Display Electron
NoDisplay=true
Exec=${quoteDesktopExecPath(electronExecutable)}
`,
			"utf8",
		);
		await writeFile(
			join(desktopDir, "link.desktop"),
			`[Desktop Entry]
Type=Link
Name=Link Electron
Exec=${quoteDesktopExecPath(electronExecutable)}
`,
			"utf8",
		);

		const result = await discoverElectronApps({
			locations: { linuxDesktopDirectories: [desktopDir], pathEnv: "" },
			platform: "linux",
		});
		assert.deepEqual(electronAppNames(result.apps), ["Demo Electron"]);
		const app = result.apps[0];
		assert.equal(app.platform, "linux");
		assert.equal(app.executablePath, realElectronExecutable);
		assert.equal(app.comment, "Demo comment");
		assert.equal(app.icon, "demo-icon");
		assert.equal(app.desktopId, "demo");
		assert.equal(app.packageSource, "desktop");

		const binDir = join(tempDir, "bin");
		await mkdir(binDir, { recursive: true });
		const symlinkPath = join(binDir, "demo-link");
		await symlink(electronExecutable, symlinkPath);
		await writeFile(
			join(desktopDir, "symlink.desktop"),
			`[Desktop Entry]
Type=Application
Name=Symlink Electron
Exec=${quoteDesktopExecPath(symlinkPath)}
`,
			"utf8",
		);
		const symlinkResult = await discoverElectronApps({
			locations: { linuxDesktopDirectories: [desktopDir], pathEnv: "" },
			platform: "linux",
			query: "symlink",
		});
		assert.deepEqual(electronAppNames(symlinkResult.apps), ["Symlink Electron"]);
		assert.equal(symlinkResult.apps[0]?.executablePath, realElectronExecutable);

		const flatpakUserAppDirectory = join(tempDir, "flatpak", "app");
		const flatpakExecutable = await writeFakeLinuxElectronBinary(
			join(flatpakUserAppDirectory, "com.example.Flat", "current", "active", "files"),
			"flat-electron",
		);
		const realFlatpakExecutable = await realpath(flatpakExecutable);
		await writeFile(
			join(desktopDir, "com.example.Flat.desktop"),
			`[Desktop Entry]
Type=Application
Name=Flatpak Electron
Exec=/usr/bin/flatpak run com.example.Flat
`,
			"utf8",
		);
		const flatpakResult = await discoverElectronApps({
			locations: { flatpakUserAppDirectory, linuxDesktopDirectories: [desktopDir], pathEnv: "" },
			platform: "linux",
			query: "flatpak",
		});
		assert.deepEqual(electronAppNames(flatpakResult.apps), ["Flatpak Electron"]);
		assert.equal(flatpakResult.apps[0]?.executablePath, realFlatpakExecutable);
		assert.equal(flatpakResult.apps[0]?.packageSource, "flatpak");
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("electron discovery caps results, clamps maxResults, and reports omittedCount", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-cap-"));
	try {
		const applicationsDir = join(tempDir, "Applications");
		await mkdir(applicationsDir, { recursive: true });
		for (let index = 0; index < 202; index += 1) {
			const suffix = String(index).padStart(3, "0");
			// Create bundles serially to bound the fixture's simultaneous filesystem work.
			// oxlint-disable-next-line no-await-in-loop
			await writeFakeMacElectronApp({
				applicationsDir,
				bundleId: `com.example.Cap${suffix}`,
				executableName: `Cap${suffix}`,
				name: `Cap App ${suffix}`,
			});
		}

		const clamped = await discoverElectronApps({
			locations: { darwinApplicationDirectories: [applicationsDir] },
			maxResults: 1_200,
			platform: "darwin",
		});
		assert.equal(clamped.maxResults, 200);
		assert.equal(clamped.apps.length, 200);
		assert.equal(clamped.omittedCount, 2);

		const smallCap = await discoverElectronApps({
			locations: { darwinApplicationDirectories: [applicationsDir] },
			maxResults: 3,
			platform: "darwin",
		});
		assert.equal(smallCap.apps.length, 3);
		assert.equal(smallCap.omittedCount, 199);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
