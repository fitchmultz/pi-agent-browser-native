/**
 * Purpose: Verify snapshot-specific presentation and compacted ref accounting.
 * Responsibilities: Lock high-value-control surfacing separately from ordinary omitted-ref counts.
 * Scope: Unit-style presentation coverage for snapshot compaction; generic presentation behavior lives in agent-browser.presentation.test.ts.
 * Usage: Run with `npx tsx --test test/agent-browser.snapshot-presentation.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Ordinary omitted refs must not be counted as omitted high-value controls.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { buildToolPresentation } from "../extensions/agent-browser/lib/results.js";
import { cleanupSecureTempArtifacts } from "../extensions/agent-browser/lib/temp.js";
import { TEST_SESSION_ID, withPatchedEnv } from "./helpers/agent-browser-harness.js";

test("buildToolPresentation reuses compact snapshot rendering inside batch output", async () => {
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [
			`e${index + 1}`,
			{ name: index % 3 === 0 ? `Actionable control ${index + 1}` : "", role: index % 5 === 0 ? "button" : "generic" },
		]),
	);
	const snapshot = Array.from({ length: 120 }, (_, index) => {
		const ref = `e${index + 1}`;
		return `- generic \"Large batched snapshot row ${index + 1} that should compact inside batch output\" [ref=${ref}] clickable [onclick]`;
	}).join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "batch" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: [
				{
					command: ["snapshot", "-i"],
					result: {
						origin: "https://example.com/batched-huge",
						refs,
						snapshot,
					},
					success: true,
				},
			],
		},
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Step 1 — snapshot -i/);
	assert.match(text, /Compact snapshot view/);
	assert.match(text, /Key refs:/);
	assert.equal(typeof presentation.fullOutputPath, "string");
	assert.equal(presentation.batchSteps?.length, 1);
	assert.equal(typeof presentation.batchSteps?.[0]?.fullOutputPath, "string");
	assert.match(presentation.batchSteps?.[0]?.text ?? "", /Compact snapshot view/);

	const spillPath = presentation.batchSteps?.[0]?.fullOutputPath;
	assert.ok(spillPath);
	assert.match(text, new RegExp(spillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	if (spillPath) {
		await rm(spillPath, { force: true });
	}
});

test("buildToolPresentation compacts oversized snapshots and spills the raw snapshot to a private temp file", async () => {
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [
			`e${index + 1}`,
			{ name: index % 3 === 0 ? `Actionable control ${index + 1}` : "", role: index % 5 === 0 ? "button" : "generic" },
		]),
	);
	const snapshot = Array.from({ length: 120 }, (_, index) => {
		const ref = `e${index + 1}`;
		return `- generic \"Large snapshot row ${index + 1} with lots of repeated visible text that should not all stay inline\" [ref=${ref}] clickable [onclick]`;
	}).join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/huge",
				refs,
				snapshot,
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Compact snapshot view/);
	assert.match(text, /Key refs:/);
	assert.match(presentation.summary, /Snapshot: 90 refs on https:\/\/example.com\/huge \(compact\)/);
	assert.equal(typeof presentation.fullOutputPath, "string");
	assert.equal((presentation.data as { compacted: boolean }).compacted, true);

	const spillPath = presentation.fullOutputPath;
	assert.ok(spillPath);
	assert.match(text, new RegExp(spillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	const spillText = await readFile(spillPath, "utf8");
	const spillStats = await stat(spillPath);
	const spillDirStats = await stat(dirname(spillPath));
	assert.match(spillText, /Large snapshot row 120/);
	assert.match(spillText, /Actionable control 1/);
	assert.equal(spillStats.mode & 0o777, 0o600);
	assert.equal(spillDirStats.mode & 0o777, 0o700);
	await rm(spillPath, { force: true });
});

test("buildToolPresentation keeps compact snapshot spill files in the persisted session artifact directory when available", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-session-store-"));
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [
			`e${index + 1}`,
			{ name: index % 3 === 0 ? `Persisted control ${index + 1}` : "", role: index % 5 === 0 ? "button" : "generic" },
		]),
	);
	const snapshot = Array.from({ length: 120 }, (_, index) => `- generic \"Persisted snapshot row ${index + 1}\" [ref=e${index + 1}] clickable [onclick]`).join("\n");

	try {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "snapshot" },
			cwd: process.cwd(),
			envelope: {
				success: true,
				data: {
					origin: "https://example.com/persisted",
					refs,
					snapshot,
				},
			},
			persistentArtifactStore: { sessionDir, sessionId: TEST_SESSION_ID },
		});

		const spillPath = presentation.fullOutputPath;
		assert.equal(typeof spillPath, "string");
		assert.equal(spillPath?.startsWith(join(sessionDir, ".pi-agent-browser-artifacts", TEST_SESSION_ID)), true);
		await cleanupSecureTempArtifacts();
		assert.match(await readFile(String(spillPath), "utf8"), /Persisted snapshot row 120/);
		assert.equal((await stat(String(spillPath))).mode & 0o777, 0o600);
		assert.equal((await stat(dirname(String(spillPath)))).mode & 0o777, 0o700);
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(sessionDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation evicts the oldest persisted snapshot spill files when the per-session artifact budget is exceeded", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-session-budget-"));
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [
			`e${index + 1}`,
			{ name: index % 3 === 0 ? `Budgeted control ${index + 1}` : "", role: index % 5 === 0 ? "button" : "generic" },
		]),
	);
	const buildData = (label: string) => ({
		origin: `https://example.com/${label}`,
		refs,
		snapshot: Array.from({ length: 120 }, (_, index) => `- generic \"${label} snapshot row ${index + 1}\" [ref=e${index + 1}] clickable [onclick]`).join("\n"),
	});
	const firstData = buildData("first");
	const secondData = buildData("second");
	const budgetBytes = Math.max(
		Buffer.byteLength(JSON.stringify(firstData, null, 2)),
		Buffer.byteLength(JSON.stringify(secondData, null, 2)),
	) + 512;

	try {
		await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES: String(budgetBytes) }, async () => {
			const firstPresentation = await buildToolPresentation({
				commandInfo: { command: "snapshot" },
				cwd: process.cwd(),
				envelope: { success: true, data: firstData },
				persistentArtifactStore: { sessionDir, sessionId: TEST_SESSION_ID },
			});
			const secondPresentation = await buildToolPresentation({
				artifactManifest: firstPresentation.artifactManifest,
				commandInfo: { command: "snapshot" },
				cwd: process.cwd(),
				envelope: { success: true, data: secondData },
				persistentArtifactStore: { sessionDir, sessionId: TEST_SESSION_ID },
			});

			assert.equal(typeof firstPresentation.fullOutputPath, "string");
			assert.equal(typeof secondPresentation.fullOutputPath, "string");
			assert.equal(await readFile(String(firstPresentation.fullOutputPath), "utf8").then(() => true, () => false), false);
			assert.match(await readFile(String(secondPresentation.fullOutputPath), "utf8"), /second snapshot row 120/);
			assert.equal(secondPresentation.artifactManifest?.liveCount, 1);
			assert.equal(secondPresentation.artifactManifest?.evictedCount, 1);
			assert.equal(
				secondPresentation.artifactManifest?.entries.some(
					(entry) => entry.path === firstPresentation.fullOutputPath && entry.retentionState === "evicted",
				),
				true,
			);
			assert.equal(
				secondPresentation.artifactManifest?.entries.some(
					(entry) => entry.path === secondPresentation.fullOutputPath && entry.retentionState === "live",
				),
				true,
			);
			assert.match(secondPresentation.artifactRetentionSummary ?? "", /1 live, 1 evicted/);
			assert.match((secondPresentation.content[0] as { text: string }).text, /Session artifacts: 1 live, 1 evicted/);
		});
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(sessionDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation keeps earlier batch snapshot spill paths live when a later persisted spill exceeds the budget", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-session-batch-budget-"));
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [
			`e${index + 1}`,
			{ name: index % 3 === 0 ? `Batch control ${index + 1}` : "", role: index % 5 === 0 ? "button" : "generic" },
		]),
	);
	const buildSnapshotData = (label: string) => ({
		origin: `https://example.com/${label}`,
		refs,
		snapshot: Array.from({ length: 120 }, (_, index) => `- generic \"${label} batch snapshot row ${index + 1}\" [ref=e${index + 1}] clickable [onclick]`).join("\n"),
	});
	const firstData = buildSnapshotData("first");
	const secondData = buildSnapshotData("second");
	const budgetBytes = Buffer.byteLength(JSON.stringify(firstData, null, 2)) + 512;

	try {
		await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES: String(budgetBytes) }, async () => {
			const presentation = await buildToolPresentation({
				commandInfo: { command: "batch" },
				cwd: process.cwd(),
				envelope: {
					success: true,
					data: [
						{ command: ["snapshot", "-i"], result: firstData, success: true },
						{ command: ["snapshot", "-i"], result: secondData, success: true },
					],
				},
				persistentArtifactStore: { sessionDir, sessionId: TEST_SESSION_ID },
			});
			const firstPath = presentation.batchSteps?.[0]?.fullOutputPath;
			const secondPath = presentation.batchSteps?.[1]?.fullOutputPath;
			assert.equal(typeof firstPath, "string");
			assert.equal(secondPath, undefined);
			assert.match(await readFile(String(firstPath), "utf8"), /first batch snapshot row 120/);
			assert.match(presentation.batchSteps?.[1]?.text ?? "", /persisted spill budget exceeded/i);
		});
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(sessionDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation prefers main content sections over top-of-page chrome in compact snapshots", async () => {
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => {
			const id = `e${index + 1}`;
			if (id === "e1") return [id, { name: "Skip to main content", role: "link" }];
			if (id === "e2") return [id, { name: "AD", role: "link" }];
			if (id === "e3") return [id, { name: "JavaScript", role: "heading" }];
			if (id === "e4") return [id, { name: "Beginner's tutorials", role: "region" }];
			if (id === "e5") return [id, { name: "Intermediate", role: "region" }];
			if (id === "e6") return [id, { name: "Reference", role: "region" }];
			return [id, { name: `Content item ${index + 1}`, role: index % 6 === 0 ? "link" : "generic" }];
		}),
	);
	const snapshot = [
		'- link "Skip to main content" [ref=e1]',
		'- link "AD" [ref=e2]',
		'- heading "JavaScript" [level=1, ref=e3]',
		...Array.from({ length: 18 }, (_, index) => `- link "Overview topic ${index + 1}" [ref=e${index + 10}]`),
		'- region "Beginner\'s tutorials" [ref=e4]',
		'  - link "Your first website: Adding interactivity" [ref=e40]',
		'  - link "Dynamic scripting with JavaScript" [ref=e41]',
		'- region "Intermediate" [ref=e5]',
		'  - link "Asynchronous JavaScript" [ref=e42]',
		'  - link "Client-side web APIs" [ref=e43]',
		'- region "Reference" [ref=e6]',
		...Array.from({ length: 70 }, (_, index) => `  - link "Reference entry ${index + 1}" [ref=e${index + 50}]`),
	].join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/docs/javascript",
				refs,
				snapshot,
			},
		},
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Primary content:/);
	assert.match(text, /heading "JavaScript"/);
	assert.match(text, /Additional sections:/);
	assert.match(text, /region "Beginner's tutorials"/);
	assert.doesNotMatch(text, /Skip to main content/);
	assert.doesNotMatch(text, /^- AD$/m);
	assert.equal((presentation.data as { previewMode?: string }).previewMode, "structured");

	if (presentation.fullOutputPath) {
		await rm(presentation.fullOutputPath, { force: true });
	}
});

test("buildToolPresentation surfaces omitted high-value controls in compact snapshots", async () => {
	const refs = Object.fromEntries(
		Array.from({ length: 100 }, (_, index) => {
			const id = `e${index + 1}`;
			if (id === "e2") return [id, { name: "Search", role: "button" }];
			if (id === "e3") return [id, { name: "Search docs", role: "searchbox" }];
			if (["e4", "e5", "e6", "e7", "e8", "e9"].includes(id)) {
				return [id, { name: `Package tab ${id.slice(1)}`, role: "tab" }];
			}
			return [id, { name: `Article link ${index + 1}`, role: "link" }];
		}),
	);
	const snapshot = [
		'- heading "Docs Home" [level=1, ref=e1]',
		...Array.from({ length: 80 }, (_, index) => `  - link "Article link ${index + 10}" [ref=e${index + 10}]`),
		'- navigation "Top navigation"',
		'  - button "Search" [ref=e2]',
		'  - searchbox "Search docs" [ref=e3]',
		'- tablist "Package managers"',
		'  - tab "Package tab 4" [ref=e4]',
		'  - tab "Package tab 5" [ref=e5]',
		'  - tab "Package tab 6" [ref=e6]',
		'  - tab "Package tab 7" [ref=e7]',
		'  - tab "Package tab 8" [ref=e8]',
		'  - tab "Package tab 9" [ref=e9]',
	].join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/docs",
				refs,
				snapshot,
			},
		},
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Other refs:/);
	assert.match(text, /e3 searchbox "Search docs"/);
	assert.match(text, /e2 button "Search"/);
	assert.match(text, /Omitted high-value controls:/);
	assert.match(text, /e6 tab "Package tab 6"/);
	assert.match(text, /e9 tab "Package tab 9"/);
	assert.deepEqual((presentation.data as { highValueControlRefIds?: string[] }).highValueControlRefIds, ["e6", "e7", "e8", "e9"]);

	if (presentation.fullOutputPath) {
		await rm(presentation.fullOutputPath, { force: true });
	}
});

test("buildToolPresentation surfaces dense repository result links as high-value refs", async () => {
	const refs = Object.fromEntries(
		Array.from({ length: 95 }, (_, index) => {
			const id = `e${index + 1}`;
			if (id === "e70") return [id, { name: "vercel-labs/agent-browser", role: "link" }];
			return [id, { name: `Result heading ${index + 1}`, role: "heading" }];
		}),
	);
	const snapshot = [
		'- main "Repository search results" [ref=e1]',
		...Array.from({ length: 68 }, (_, index) => `  - heading "Result heading ${index + 2}" [ref=e${index + 2}]`),
		'  - heading "vercel-labs/agent-browser" [ref=e69]',
		'    - link "vercel-labs/agent-browser" [ref=e70]',
		...Array.from({ length: 25 }, (_, index) => `  - heading "Result heading ${index + 71}" [ref=e${index + 71}]`),
	].join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: { success: true, data: { origin: "https://github.com/search?q=agent-browser&type=repositories", refs, snapshot } },
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Omitted high-value controls:/);
	assert.match(text, /e70 link "vercel-labs\/agent-browser"/);
	assert.ok((presentation.data as { highValueControlRefIds?: string[] }).highValueControlRefIds?.includes("e70"));

	if (presentation.fullOutputPath) {
		await rm(presentation.fullOutputPath, { force: true });
	}
});

test("buildToolPresentation keeps dense desktop host high-value controls discoverable in compact snapshots", async () => {
	const refs = Object.fromEntries(
		Array.from({ length: 170 }, (_, index) => {
			const id = `e${index + 1}`;
			if (id === "e1") return [id, { name: "Desktop host", role: "main" }];
			if (id === "e130") return [id, { name: "Search workspace", role: "searchbox" }];
			if (id === "e131") return [id, { name: "Composer", role: "textbox" }];
			if (id === "e132") return [id, { name: "Model picker", role: "combobox" }];
			if (id === "e140") return [id, { name: "Canvas", role: "tab" }];
			if (id === "e141") return [id, { name: "Agents", role: "tab" }];
			if (id === "e142") return [id, { name: "Canvas surface", role: "button" }];
			if (id === "e160") return [id, { name: "Send", role: "button" }];
			if (id === "e161") return [id, { name: "Run task", role: "button" }];
			if (id === "e162") return [id, { name: "Save", role: "button" }];
			if (index + 1 >= 90 && index + 1 <= 119) return [id, { name: `Toolbar action ${index + 1}`, role: "button" }];
			return [id, { name: `Dense host row ${index + 1}`, role: "generic" }];
		}),
	);
	const snapshot = [
		'- main "Desktop host" [ref=e1]',
		...Array.from({ length: 88 }, (_, index) => `  - generic "Dense host row ${index + 2}" [ref=e${index + 2}]`),
		...Array.from({ length: 30 }, (_, index) => `  - button "Toolbar action ${index + 90}" [ref=e${index + 90}]`),
		'  - searchbox "Search workspace" [ref=e130]',
		'  - textbox "Composer" [ref=e131] editable',
		'  - combobox "Model picker" [ref=e132]',
		'  - tablist "Host surfaces"',
		'    - tab "Canvas" [ref=e140]',
		'    - tab "Agents" [ref=e141]',
		'    - button "Canvas surface" [ref=e142]',
		'  - button "Send" [ref=e160]',
		'  - button "Run task" [ref=e161]',
		'  - button "Save" [ref=e162]',
	].join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "app://desktop-host",
				refs,
				snapshot,
			},
		},
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Compact snapshot view/);
	assert.match(text, /e130 searchbox "Search workspace"/);
	assert.match(text, /e131 textbox "Composer"/);
	assert.match(text, /e132 combobox "Model picker"/);
	assert.match(text, /Omitted high-value controls:/);
	assert.match(text, /e140 tab "Canvas"/);
	assert.match(text, /e141 tab "Agents"/);
	assert.match(text, /e142 button "Canvas surface"/);
	assert.match(text, /e160 button "Send"/);
	assert.match(text, /e161 button "Run task"/);
	assert.match(text, /e162 button "Save"/);

	const highValueControlRefIds = (presentation.data as { highValueControlRefIds?: string[] }).highValueControlRefIds ?? [];
	assert.ok(highValueControlRefIds.length <= 10);
	for (const expectedRef of ["e140", "e141", "e142", "e160", "e161", "e162"]) {
		assert.ok(highValueControlRefIds.includes(expectedRef), `${expectedRef} should remain surfaced in high-value refs`);
	}

	if (presentation.fullOutputPath) {
		await rm(presentation.fullOutputPath, { force: true });
	}
});

test("buildToolPresentation round-robins omitted high-value control categories in compact snapshots", async () => {
	const refs = Object.fromEntries(
		Array.from({ length: 140 }, (_, index) => {
			const id = `e${index + 1}`;
			if (id === "e1") return [id, { name: "Settings", role: "main" }];
			if (index + 1 >= 120 && index + 1 <= 129) return [id, { name: `Field ${index + 1}`, role: "textbox" }];
			if (id === "e130") return [id, { name: "Enable sync", role: "checkbox" }];
			if (id === "e131") return [id, { name: "Beta channel", role: "radio" }];
			if (id === "e132") return [id, { name: "Workspace option", role: "option" }];
			if (id === "e133") return [id, { name: "Archive project", role: "menuitem" }];
			return [id, { name: `Result ${index + 1}`, role: "link" }];
		}),
	);
	const snapshot = [
		'- main "Settings" [ref=e1]',
		...Array.from({ length: 118 }, (_, index) => `  - link "Result ${index + 2}" [ref=e${index + 2}]`),
		...Array.from({ length: 10 }, (_, index) => `  - textbox "Field ${index + 120}" [ref=e${index + 120}]`),
		'  - checkbox "Enable sync" [ref=e130]',
		'  - radio "Beta channel" [ref=e131]',
		'  - option "Workspace option" [ref=e132]',
		'  - menuitem "Archive project" [ref=e133]',
	].join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "app://settings",
				refs,
				snapshot,
			},
		},
	});

	const highValueControlRefIds = (presentation.data as { highValueControlRefIds?: string[] }).highValueControlRefIds ?? [];
	assert.ok(highValueControlRefIds.length <= 10);
	for (const expectedRef of ["e130", "e131", "e132", "e133"]) {
		assert.ok(highValueControlRefIds.includes(expectedRef), `${expectedRef} should not be starved by editable controls`);
	}

	if (presentation.fullOutputPath) {
		await rm(presentation.fullOutputPath, { force: true });
	}
});

test("buildToolPresentation keeps lower high-value categories visible on saturated desktop screens", async () => {
	const refs = Object.fromEntries(
		Array.from({ length: 180 }, (_, index) => {
			const id = `e${index + 1}`;
			if (id === "e1") return [id, { name: "Desktop", role: "main" }];
			if (["e160", "e161", "e162", "e163"].includes(id)) return [id, { name: `Editor ${id.slice(1)}`, role: "textbox" }];
			if (id === "e164") return [id, { name: "Canvas", role: "tab" }];
			if (id === "e165") return [id, { name: "Agents", role: "tab" }];
			if (id === "e166") return [id, { name: "Canvas surface", role: "button" }];
			if (id === "e167") return [id, { name: "Send", role: "button" }];
			if (id === "e168") return [id, { name: "Run", role: "button" }];
			if (id === "e169") return [id, { name: "Save", role: "button" }];
			if (id === "e170") return [id, { name: "Enable sync", role: "checkbox" }];
			if (id === "e171") return [id, { name: "Beta channel", role: "radio" }];
			if (id === "e172") return [id, { name: "Workspace option", role: "option" }];
			if (id === "e173") return [id, { name: "Archive project", role: "menuitem" }];
			return [id, { name: `Dense row ${index + 1}`, role: "generic" }];
		}),
	);
	const snapshot = [
		'- main "Desktop" [ref=e1]',
		...Array.from({ length: 158 }, (_, index) => `  - generic "Dense row ${index + 2}" [ref=e${index + 2}]`),
		...Array.from({ length: 4 }, (_, index) => `  - textbox "Editor ${index + 160}" [ref=e${index + 160}]`),
		'  - tab "Canvas" [ref=e164]',
		'  - tab "Agents" [ref=e165]',
		'  - button "Canvas surface" [ref=e166]',
		'  - button "Send" [ref=e167]',
		'  - button "Run" [ref=e168]',
		'  - button "Save" [ref=e169]',
		'  - checkbox "Enable sync" [ref=e170]',
		'  - radio "Beta channel" [ref=e171]',
		'  - option "Workspace option" [ref=e172]',
		'  - menuitem "Archive project" [ref=e173]',
	].join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: { success: true, data: { origin: "app://desktop", refs, snapshot } },
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /e160 textbox "Editor 160"/);
	assert.match(text, /e164 tab "Canvas"/);
	assert.match(text, /e167 button "Send"/);
	const highValueControlRefIds = (presentation.data as { highValueControlRefIds?: string[] }).highValueControlRefIds ?? [];
	assert.ok(highValueControlRefIds.length <= 10);
	for (const expectedRef of ["e170", "e171", "e172", "e173"]) {
		assert.ok(highValueControlRefIds.includes(expectedRef), `${expectedRef} should stay visible in saturated compact high-value refs`);
	}

	if (presentation.fullOutputPath) {
		await rm(presentation.fullOutputPath, { force: true });
	}
});

test("buildToolPresentation does not promote false editable markers in compact snapshots", async () => {
	const refs = Object.fromEntries(
		Array.from({ length: 112 }, (_, index) => {
			const id = `e${index + 1}`;
			if (id === "e1") return [id, { name: "Host", role: "main" }];
			if (id === "e100") return [id, { contenteditable: false, name: "Read-only composer", role: "generic" }];
			if (id === "e101") return [id, { editable: false, name: "Disabled editor", role: "unknown" }];
			if (id === "e102") return [id, { name: "Composer", role: "generic" }];
			if (id === "e103") return [id, { name: "Editable settings", role: "generic" }];
			if (id === "e104") return [id, { name: "contenteditable demo", role: "unknown" }];
			if (id === "e105") return [id, { editable: false, name: "Read-only search", role: "searchbox" }];
			if (id === "e106") return [id, { contenteditable: false, name: "Read-only textbox", role: "textbox" }];
			if (id === "e107") return [id, { contentEditable: false, name: "Read-only combo", role: "combobox" }];
			return [id, { name: `Result ${index + 1}`, role: "link" }];
		}),
	);
	const snapshot = [
		'- main "Host" [ref=e1]',
		...Array.from({ length: 98 }, (_, index) => `  - link "Result ${index + 2}" [ref=e${index + 2}]`),
		'  - generic "Read-only composer" [ref=e100] contenteditable=false',
		'  - generic "Disabled editor" [ref=e101] editable=false',
		'  - generic "Composer" [ref=e102] contenteditable=true',
		'  - generic "Editable settings" [ref=e103]',
		'  - unknown "contenteditable demo" [ref=e104]',
		'  - searchbox "Read-only search" [ref=e105] editable=false',
		'  - textbox "Read-only textbox" [ref=e106] contenteditable=false',
		'  - combobox "Read-only combo" [ref=e107] contenteditable=false',
		...Array.from({ length: 5 }, (_, index) => `  - link "Result ${index + 108}" [ref=e${index + 108}]`),
	].join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "app://desktop-host",
				refs,
				snapshot,
			},
		},
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Compact snapshot view/);
	assert.match(text, /e102 textbox "Composer"/);
	assert.doesNotMatch(text, /e100 textbox "Read-only composer"/);
	assert.doesNotMatch(text, /e101 textbox "Disabled editor"/);
	assert.doesNotMatch(text, /e103 textbox "Editable settings"/);
	assert.doesNotMatch(text, /e104 textbox "contenteditable demo"/);
	const data = presentation.data as { highValueControlRefIds?: string[]; roleCounts?: Record<string, number> };
	assert.equal(data.roleCounts?.textbox, 2);
	assert.equal(data.highValueControlRefIds?.includes("e100"), false);
	assert.equal(data.highValueControlRefIds?.includes("e101"), false);
	assert.equal(data.highValueControlRefIds?.includes("e103"), false);
	assert.equal(data.highValueControlRefIds?.includes("e104"), false);
	assert.equal(data.highValueControlRefIds?.includes("e105"), false);
	assert.equal(data.highValueControlRefIds?.includes("e106"), false);
	assert.equal(data.highValueControlRefIds?.includes("e107"), false);

	if (presentation.fullOutputPath) {
		await rm(presentation.fullOutputPath, { force: true });
	}
});


test("buildToolPresentation falls back to an outline when the raw snapshot format is unfamiliar", async () => {
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [`e${index + 1}`, { name: `Action ${index + 1}`, role: "button" }]),
	);
	const snapshot = Array.from({ length: 120 }, (_, index) => `node e${index + 1}: Action ${index + 1} -> click target`).join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/unfamiliar",
				refs,
				snapshot,
			},
		},
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Compact outline:/);
	assert.doesNotMatch(text, /Primary content:/);
	assert.match(text, /node e1: Action 1 -> click target/);
	assert.match(text, /Key refs:/);
	assert.match(text, /Action 1/);
	assert.equal((presentation.data as { previewMode?: string }).previewMode, "outline");

	if (presentation.fullOutputPath) {
		await rm(presentation.fullOutputPath, { force: true });
	}
});

test("buildToolPresentation degrades gracefully when snapshot spill creation exceeds the temp budget", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const refs = Object.fromEntries(Array.from({ length: 90 }, (_, index) => [`e${index + 1}`, { name: `Action ${index + 1}`, role: "button" }]));
	const snapshot = Array.from({ length: 120 }, (_, index) => `- button "Budget row ${index + 1}" [ref=e${index + 1}]`).join("\n");

	try {
		await withPatchedEnv({ PI_AGENT_BROWSER_TEMP_ROOT_MAX_BYTES: "1024" }, async () => {
			const presentation = await buildToolPresentation({
				commandInfo: { command: "snapshot" },
				cwd: process.cwd(),
				envelope: {
					success: true,
					data: {
						origin: "https://example.com/budgeted",
						refs,
						snapshot,
					},
				},
			});

			assert.equal(presentation.fullOutputPath, undefined);
			assert.match((presentation.content[0] as { text: string }).text, /Full raw snapshot unavailable:/);
			assert.match((presentation.content[0] as { text: string }).text, /temp spill budget exceeded/i);
		});
	} finally {
		await cleanupSecureTempArtifacts();
	}
});


test("compact snapshots count ordinary omitted refs separately from high-value controls", async () => {
	const refs: Record<string, { name: string; role: string }> = {
		e1: { name: "Dashboard", role: "main" },
	};
	for (let index = 2; index <= 81; index += 1) {
		refs[`e${index}`] = { name: `Document link ${index}`, role: "link" };
	}
	for (let index = 82; index <= 101; index += 1) {
		refs[`e${index}`] = { name: `Run action ${index}`, role: "button" };
	}

	const snapshot = [
		'- main "Dashboard" [ref=e1]',
		...Array.from({ length: 80 }, (_, index) => `  - link "Document link ${index + 2}" [ref=e${index + 2}]`),
		...Array.from({ length: 20 }, (_, index) => `  - button "Run action ${index + 82}" [ref=e${index + 82}]`),
	].join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: {
			data: {
				origin: "https://example.test/dashboard",
				refs,
				snapshot,
			},
			success: true,
		},
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Omitted high-value controls:/);
	assert.match(text, /73 additional refs omitted/);
	assert.match(text, /6 additional high-value controls omitted/);
	assert.equal((presentation.data as { highValueControlRefIds?: string[] }).highValueControlRefIds?.length, 10);

	if (presentation.fullOutputPath) {
		await rm(presentation.fullOutputPath, { force: true });
	}
});
