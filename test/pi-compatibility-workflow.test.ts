/** Lock the blocking native-Windows qualification and its retained failure evidence. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("Windows qualification blocks PR, release-call and manual compatibility runs for both hosts", () => {
	assert.match(workflow, /pull_request:\n    branches: \[main\]/);
	assert.match(workflow, /  workflow_call:/);
	assert.match(workflow, /  workflow_dispatch:/);
	assert.doesNotMatch(workflow, /continue-on-error:/);
	const windows = job("windows");
	assert.match(windows, /needs: \[resolve, fork-package\]/);
	assert.match(windows, /if: \$\{\{ !cancelled\(\) \}\}/);
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
