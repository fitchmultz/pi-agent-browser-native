import assert from "node:assert/strict";
import { readRecord } from "./helpers/assertions.js";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import nodeTest from "node:test";
import { validateUpstreamVersion } from "../extensions/agent-browser/lib/orchestration/extension-version-check.js";
import { runAgentBrowserProcess } from "../extensions/agent-browser/lib/process.js";
import { getSessionTempRoot } from "../extensions/agent-browser/lib/temp-root.js";

import {
	MINIMUM_AGENT_BROWSER_VERSION,
	TARGET_AGENT_BROWSER_VERSION,
	getAgentBrowserVersionValidationError,
	parseAgentBrowserVersionOutput,
} from "../extensions/agent-browser/lib/upstream-version.js";
import {
	createExtensionHarness,
	executeRegisteredTool,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

nodeTest("upstream version output accepts stable versions at or above the supported floor", () => {
	assert.equal(
		parseAgentBrowserVersionOutput(`agent-browser ${TARGET_AGENT_BROWSER_VERSION}\n`),
		TARGET_AGENT_BROWSER_VERSION,
	);
	const supportedVersions = [
		MINIMUM_AGENT_BROWSER_VERSION,
		TARGET_AGENT_BROWSER_VERSION,
		"0.43.1",
		"1.0.0",
	];
	assert.deepEqual(
		supportedVersions.map((version) =>
			getAgentBrowserVersionValidationError(`agent-browser ${version}\n`),
		),
		[undefined, undefined, undefined, undefined],
	);
	assert.match(
		getAgentBrowserVersionValidationError("agent-browser 0.42.99\n") ?? "",
		/at least agent-browser 0\.43\.0/,
	);
	assert.match(
		getAgentBrowserVersionValidationError("agent-browser 0.43.1-beta.1\n") ?? "",
		/unsupported/,
	);
	assert.match(
		getAgentBrowserVersionValidationError("agent-browser 0.043.1\n") ?? "",
		/unsupported/,
	);
	assert.match(getAgentBrowserVersionValidationError("v0.43.1\n") ?? "", /unrecognized value/);
});

nodeTest(
	"version validation removes actual stdout spills on valid, invalid, and unavailable probes",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "piab-version-spill-"));
		try {
			await writeFakeAgentBrowserBinary(
				tempDir,
				`
process.stdout.write(" ".repeat(600_000) + "agent-browser " + process.env.PIAB_PROBE_VERSION + "\\n", () => {
  process.exit(Number(process.env.PIAB_PROBE_EXIT));
});
`,
			);
			await withPatchedEnv(
				{
					PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}`,
					PI_AGENT_BROWSER_TEST_CUSTOM_VERSION: "1",
					PIAB_PROBE_VERSION: TARGET_AGENT_BROWSER_VERSION,
					PIAB_PROBE_EXIT: "0",
				},
				async () => {
					const control = await runAgentBrowserProcess({
						args: ["--version"],
						cwd: tempDir,
						timeoutMs: 5000,
					});
					assert.ok(control.stdoutSpillPath !== undefined);
					assert.match(await readFile(control.stdoutSpillPath, "utf8"), /agent-browser/);
					await rm(control.stdoutSpillPath);
					const root = await getSessionTempRoot();
					const before = (await readdir(root)).sort();
					const observations = [];
					for (const [version, exitCode] of [
						[TARGET_AGENT_BROWSER_VERSION, "0"],
						["0.33.20", "0"],
						[TARGET_AGENT_BROWSER_VERSION, "127"],
					] as const) {
						const observation = await withPatchedEnv(
							{ PIAB_PROBE_VERSION: version, PIAB_PROBE_EXIT: exitCode },
							async () => {
								const result = await validateUpstreamVersion(new Set(), tempDir);
								return { invalid: result?.isError === true, files: (await readdir(root)).sort() };
							},
						);
						observations.push(observation);
					}
					assert.deepEqual(observations, [
						{ invalid: false, files: before },
						{ invalid: true, files: before },
						{ invalid: false, files: before },
					]);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"browser-backed calls fail before launch on upstream version mismatch while inspection stays available",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "piab-upstream-version-"));
		const logPath = join(tempDir, "invocations.log");
		try {
			await writeFakeAgentBrowserBinary(
				tempDir,
				`
if (__piabFakeArgs.includes("--version")) {
  process.stdout.write("agent-browser 0.33.20\\n");
  process.exit(0);
}
require("node:fs").appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(__piabFakeArgs) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { url: "https://example.com" } }));
`,
			);
			await withPatchedEnv(
				{
					PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}`,
					PI_AGENT_BROWSER_TEST_CUSTOM_VERSION: "1",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					const blocked = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["open", "https://example.com"],
					});
					assert.equal(blocked.isError, true);
					assert.equal(readRecord(blocked.details).failureCategory, "validation-error");
					assert.equal(readRecord(blocked.details).observedVersion, "0.33.20");
					assert.equal(
						readRecord(blocked.details).minimumSupportedVersion,
						MINIMUM_AGENT_BROWSER_VERSION,
					);
					assert.equal(readRecord(blocked.details).expectedVersion, TARGET_AGENT_BROWSER_VERSION);
					assert.ok(
						(blocked.content.at(0)?.text ?? "").includes(
							`Install agent-browser ${TARGET_AGENT_BROWSER_VERSION}`,
						),
					);
					await assert.rejects(readFile(logPath, "utf8"), { code: "ENOENT" });

					const inspection = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--version"],
					});
					assert.equal(inspection.isError, false);
					assert.match(inspection.content.at(0)?.text ?? "", /0\.33\.20/);

					const doctor = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["doctor"],
					});
					assert.equal(doctor.isError, false, JSON.stringify(doctor));
					assert.match(await readFile(logPath, "utf8"), /doctor/);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);
