/** Keep the supported official/fork host selection and dependency-free CI bootstrap covered. */
import assert from "node:assert/strict";
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest from "node:test";

import { readString } from "./helpers/assertions.js";

const workflow = readFileSync(".github/workflows/pi-compatibility.yml", "utf8").replace(
	/\r\n/g,
	"\n",
);

function job(name: string): string {
	const body = readString(workflow.split(`\n  ${name}:\n`)[1]);
	assert.notEqual(body.length, 0, `Missing compatibility job: ${name}`);
	return readString(body.split(/\n  [a-z][a-z-]*:\n/)[0]);
}

nodeTest(
	"one resolved fork package feeds Linux and native dispatch uses the resolved hosts",
	() => {
		const artifact = "name: browser-fork-host-${{ needs.resolve.outputs.fork-ref }}";
		assert.match(job("fork-package"), /ref: \$\{\{ needs.resolve.outputs.fork-ref \}\}/);
		assert.match(job("fork-package"), /scripts\/pack-fork.mjs/);
		assert.match(job("fork-package"), /PI_FORK_REF: \$\{\{ needs.resolve.outputs.fork-ref \}\}/);
		assert.match(job("fork-package"), /test "\$\(git rev-parse HEAD\)" = "\$PI_FORK_REF"/);
		assert.ok(job("fork-package").includes(artifact));
		assert.ok(job("fork").includes(artifact));
		assert.match(job("fork"), /test "\$FORK_PACKAGE" = success/);
		const receiptCheck =
			'assert.equal(JSON.parse(readFileSync(process.argv[1], "utf8")).ref, process.env.FORK_REF)';
		assert.ok(job("fork").includes(receiptCheck));
		assert.match(job("native-qualification"), /waived-platforms: false/);
		assert.match(
			job("native-qualification"),
			/official-version: \$\{\{ needs.resolve.outputs.official-version \}\}/,
		);
		assert.match(
			job("native-qualification"),
			/fork-ref: \$\{\{ needs.resolve.outputs.fork-ref \}\}/,
		);
	},
);

// Actual CI starts this entrypoint before npm ci; installed-worktree checks cannot catch eager dependencies.
// Exercise the existing CLI boundary in a dependency-free directory, without an SDK stand-in or new seam.
nodeTest("CI host helper can bootstrap its CLI before dependencies are installed", (t) => {
	const root = mkdtempSync(join(tmpdir(), "ci-host-bootstrap-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	copyFileSync(new URL("../package.json", import.meta.url), join(root, "package.json"));
	for (const directory of ["scripts", "extensions"]) {
		cpSync(new URL(`../${directory}/`, import.meta.url), join(root, directory), {
			recursive: true,
		});
	}
	const entry = join(root, "scripts", "ci-host-compat.mjs");
	const result = spawnSync(process.execPath, [entry, "--help"], {
		cwd: root,
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.signal, null);
	assert.match(result.stdout, /full\|smoke\|install/);
});
