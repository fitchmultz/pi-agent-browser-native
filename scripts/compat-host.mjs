// Validate the graph prepared by the compatibility runner; never install a host here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Check } from "typebox/value";

const packageFile = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
assert.ok(packageFile !== undefined, "The selected Pi package has no manifest");
export const hostRoot = realpathSync(dirname(packageFile));
export const hostIndex = join(hostRoot, "dist/index.js");
/** @type {unknown} */
const manifest = JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8"));
assert.ok(
	Check(Type.Object({ version: Type.String(), bin: Type.Object({ pi: Type.String() }) }), manifest),
	"The selected Pi manifest must declare its version and pi executable",
);
export const hostCli = realpathSync(join(hostRoot, manifest.bin.pi));
for (const [name, actual] of Object.entries({
	PI_COMPAT_EXPECTED_PACKAGE_DIR: hostRoot,
	PI_HOST_INDEX: hostIndex,
	PI_HOST_CLI: hostCli,
})) {
	const expected = process.env[name];
	if (expected !== undefined && expected.length > 0) {
		assert.equal(
			realpathSync(expected),
			realpathSync(actual),
			`${name} must select the installed graph`,
		);
	}
}
if (
	process.env.PI_COMPAT_EXPECTED_VERSION !== undefined &&
	process.env.PI_COMPAT_EXPECTED_VERSION.length > 0
) {
	assert.equal(manifest.version, process.env.PI_COMPAT_EXPECTED_VERSION);
}
assert.equal(
	realpathSync(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
	realpathSync(hostIndex),
);
/** @param {string} path */
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
console.log(
	JSON.stringify({
		host: process.env.PI_COMPAT_HOST ?? "local",
		version: manifest.version,
		node: process.version,
		hostRoot,
		hostIndex,
		hostCli,
		indexSha256: hash(hostIndex),
		cliSha256: hash(hostCli),
	}),
);
