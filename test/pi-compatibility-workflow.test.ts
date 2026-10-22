/** Lock best-effort Windows selection without weakening strict hosts or retained failure evidence. */
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readString } from "./helpers/assertions.js";

// Native Windows source consumers can check out these same YAML bytes as CRLF.
const workflow = readFileSync(".github/workflows/pi-compatibility.yml", "utf8").replace(
	/\r\n/g,
	"\n",
);

function job(name: string): string {
	const body = readString(workflow.split(`\n  ${name}:\n`)[1]);
	assert.notEqual(body.length, 0, `Missing compatibility job: ${name}`);
	return readString(body.split(/\n  [a-z][a-z-]*:\n/)[0]);
}

test("checker patches retain canonical LF bytes in native Windows source checkouts", () => {
	assert.ok(
		readFileSync(".gitattributes", "utf8").split(/\r?\n/).includes("patches/*.patch text eol=lf"),
	);
	assert.doesNotMatch(readFileSync("patches/oxlint-tsgolint.patch", "utf8"), /\r\n/);
});

test("Windows is job-level best-effort: one routine smoke and explicit-only full qualification", () => {
	assert.match(workflow, /pull_request:\n    branches: \[main\]/);
	assert.match(workflow, /  workflow_call:/);
	assert.match(workflow, /  workflow_dispatch:/);
	assert.doesNotMatch(job("official"), /continue-on-error:/);
	assert.doesNotMatch(job("fork"), /continue-on-error:/);
	assert.doesNotMatch(job("macos"), /continue-on-error:/);
	assert.doesNotMatch(job("native-qualification"), /continue-on-error:/);
	const smoke = job("windows-smoke");
	assert.match(smoke, /\n    continue-on-error: true\n/);
	assert.doesNotMatch(smoke, /\n        continue-on-error:/);
	assert.match(smoke, /needs: resolve/);
	assert.match(smoke, /!inputs.windows-qualification/);
	assert.match(smoke, /timeout-minutes: 15/);
	assert.match(smoke, /ci-host-compat.mjs official windows-smoke/);
	assert.doesNotMatch(smoke, /setup-go|scripts\/qualify.mjs|matrix:|check:compat/);
	assert.match(smoke, /set -euo pipefail/);
	assert.match(smoke, /if: always\(\)[\s\S]*name: windows-best-effort-smoke/);
	assert.match(workflow, /windows-qualification:[\s\S]*?type: boolean\n        default: false/);
	const callInputs = readString(
		readString(workflow.split("  workflow_call:")[1]).split("\npermissions:")[0],
	);
	assert.doesNotMatch(callInputs, /windows-qualification/);
	const windows = job("windows");
	assert.match(windows, /needs: \[resolve, fork-package\]/);
	assert.match(windows, /github.event_name == 'workflow_dispatch' && inputs.windows-qualification/);
	assert.match(windows, /\n    continue-on-error: true\n/);
	assert.doesNotMatch(windows, /\n        continue-on-error:/);
	assert.doesNotMatch(windows, /!inputs.native-qualification/);
	assert.match(windows, /runs-on: windows-latest/);
	assert.match(windows, /fail-fast: false/);
	assert.match(windows, /host: \[official, fork\]/);
	assert.match(windows, /test "\$RESOLVE" = success/);
	assert.match(windows, /test "\$FORK_PACKAGE" = success/);
});

test("Windows uses the resolved source and hosts, native environment check and complete shared qualifier", () => {
	const windows = job("windows");
	assert.match(windows, /ref: \$\{\{ github.sha \}\}/);
	assert.match(windows, /ref: \$\{\{ env.PI_AUTOMATION_REF \}\}/);
	assert.match(windows, /node-version: "24"\n          check-latest: true/);
	assert.match(windows, /git config --system core.longpaths true/);
	assert.ok(windows.indexOf("core.longpaths true") < windows.indexOf("scripts/qualify.mjs"));
	assert.match(windows, /PSModulePath=\$env:PSModulePath/);
	assert.match(windows, /OFFICIAL_VERSION: \$\{\{ needs.resolve.outputs.official-version \}\}/);
	assert.match(windows, /PI_COMPAT_FORK_REF: \$\{\{ needs.resolve.outputs.fork-ref \}\}/);
	assert.match(windows, /test "\$\(git -C extension rev-parse HEAD\)" = "\$GITHUB_SHA"/);
	assert.match(
		windows,
		/set -euo pipefail\n          node --test automation\/test\/windows-environment.native.mjs 2>&1 \| tee evidence\/windows-environment.tap/,
	);
	assert.match(windows, /target="\$OFFICIAL_VERSION"/);
	assert.match(
		windows,
		/if \[\[ "\$HOST" == fork \]\]; then target="\$RUNNER_TEMP\/fork-package"; fi/,
	);
	assert.match(
		windows,
		/set -euo pipefail[\s\S]*node automation\/scripts\/qualify.mjs --repo pi-agent-browser-native/,
	);
	assert.match(windows, /--source "\$GITHUB_WORKSPACE\/extension"/);
	assert.match(
		windows,
		/--host "\$HOST" --target "\$target" --output "\$GITHUB_WORKSPACE\/evidence"/,
	);
	assert.match(windows, /set -euo pipefail\n          target="\$OFFICIAL_VERSION"/);
	assert.match(windows, /2>&1 \| tee evidence\/qualification.log \| tail -n 1000/);
	assert.match(windows, /name: Expose failed Windows TAP assertions\n        if: failure\(\)/);
	assert.ok(windows.includes("awk '/^[[:space:]]*not ok /' evidence/qualification.log"));
	assert.ok(windows.includes('closing = substr($0, 1, RLENGTH) "  ..."'));
	assert.ok(windows.includes("if ($0 == closing) printing = 0"));
	assert.ok(windows.includes("if (lines <= 1600) print"));
	assert.ok(windows.includes("if (lines > 1600)"));
	assert.match(windows, /diagnostics truncated; see qualification.log artifact/);
	assert.match(windows, /if: always\(\)\n        with:\n          name: windows-qualification-/);
	assert.match(
		windows,
		/path: evidence\n          if-no-files-found: error\n          retention-days: 14/,
	);
	assert.ok(
		windows.indexOf("windows-environment.native.mjs") < windows.indexOf("scripts/qualify.mjs"),
	);
});

test("one resolved fork package feeds Linux and Windows while native dispatch omits duplicate waived lanes", () => {
	const artifact = "name: browser-fork-host-${{ needs.resolve.outputs.fork-ref }}";
	assert.match(job("fork-package"), /ref: \$\{\{ needs.resolve.outputs.fork-ref \}\}/);
	assert.match(job("fork-package"), /scripts\/pack-fork.mjs/);
	assert.match(job("fork-package"), /PI_FORK_REF: \$\{\{ needs.resolve.outputs.fork-ref \}\}/);
	assert.match(job("fork-package"), /test "\$\(git rev-parse HEAD\)" = "\$PI_FORK_REF"/);
	assert.ok(job("fork-package").includes(artifact));
	assert.ok(job("fork").includes(artifact));
	assert.ok(job("windows").includes(artifact));
	assert.match(job("fork"), /test "\$FORK_PACKAGE" = success/);
	const receiptCheck =
		'assert.equal(JSON.parse(readFileSync(process.argv[1], "utf8")).ref, process.env.FORK_REF)';
	assert.ok(job("fork").includes(receiptCheck));
	assert.ok(job("windows").includes(receiptCheck));
	assert.match(job("native-qualification"), /waived-platforms: false/);
	assert.match(
		job("native-qualification"),
		/official-version: \$\{\{ needs.resolve.outputs.official-version \}\}/,
	);
	assert.match(job("native-qualification"), /fork-ref: \$\{\{ needs.resolve.outputs.fork-ref \}\}/);
});

function policyExtraction(source: string): string {
	const marker =
		"Native policy diagnostics (first 400 matches; complete log retained in artifact):";
	const afterMarker = readString(source.split(marker)[1]);
	return readString(afterMarker.split("' evidence/qualification.log")[0]);
}

function assertBoundedPolicyExtraction(source: string): void {
	const extraction = policyExtraction(source);
	assert.ok(extraction.includes('sub(/\\r$/, "")'));
	assert.ok(extraction.includes("line = $0"));
	assert.ok(extraction.includes('sub(/^[[:space:]]*# /, "", line)'));
	assert.ok(extraction.includes("if (line ~ /^PI-AGENT-BROWSER-POLICY [0-9]+: /)"));
	assert.match(extraction, /total\+\+\s+if \(total <= 400\) print line/);
	assert.match(extraction, /END \{\s+shown = total < 400 \? total : 400/);
	assert.ok(
		extraction.includes(
			'printf "Policy diagnostics: total=%d shown=%d omitted=%d\\n", total, shown, total - shown',
		),
	);
	// The bounded printer must still consume the complete file and count every match.
	assert.doesNotMatch(extraction, /\b(?:exit|nextfile|getline)\b|\|\s*(?:head|tail)\b/);
}

test("failed Windows qualification exposes bounded exact policy stderr diagnostics without an outer env workaround", () => {
	const windows = job("windows");
	assertBoundedPolicyExtraction(windows);
	assert.doesNotMatch(windows, /NODE_DEBUG|NODE_OPTIONS/);
	assert.match(workflow, /PI_AUTOMATION_REF: 3d1b323fd602274c55e5f44692f24c8605e52b60/);
	assert.ok(
		windows.indexOf("Failed TAP diagnostics") < windows.indexOf("Native policy diagnostics"),
	);
	assert.ok(
		windows.indexOf("Native policy diagnostics") < windows.indexOf("actions/upload-artifact"),
	);
});

test("policy extraction controls reject broad matching, missing bounds, incomplete counts and an early drain stop", () => {
	const windows = job("windows");
	assert.throws(() =>
		assertBoundedPolicyExtraction(
			windows.replace("/^PI-AGENT-BROWSER-POLICY [0-9]+: /", "/POLICY/"),
		),
	);
	assert.throws(() =>
		assertBoundedPolicyExtraction(windows.replace("if (total <= 400) print line", "print line")),
	);
	assert.throws(() => assertBoundedPolicyExtraction(windows.replace("total++", "total = 400")));
	assert.throws(() =>
		assertBoundedPolicyExtraction(
			windows.replace("total, shown, total - shown", "shown, shown, 0"),
		),
	);
	assert.throws(() =>
		assertBoundedPolicyExtraction(
			windows.replace(
				"if (total <= 400) print line",
				"if (total <= 400) print line; if (total > 400) exit",
			),
		),
	);
});

// Actual CI starts this entrypoint before npm ci; installed-worktree checks cannot catch eager dependencies.
// Exercise the existing CLI boundary in a dependency-free directory, without an SDK stand-in or new seam.
test("CI host helper can bootstrap its CLI before dependencies are installed", (t) => {
	const root = mkdtempSync(join(tmpdir(), "ci-host-bootstrap-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const entry = join(root, "ci-host-compat.mjs");
	copyFileSync(new URL("../scripts/ci-host-compat.mjs", import.meta.url), entry);
	const result = spawnSync(process.execPath, [entry, "--help"], {
		cwd: root,
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.signal, null);
	assert.match(result.stdout, /full\|smoke\|windows-smoke\|install/);
});
