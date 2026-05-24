/**
 * Purpose: Lock the deterministic dogfood verifier's lightweight CLI parser without launching a browser.
 * Responsibilities: Assert opt-in artifact/json flags are accepted and missing values fail before the live smoke starts.
 * Scope: Unit coverage for scripts/verify-agent-browser-dogfood.ts argument parsing only; the real browser flow is exercised by `npm run verify -- dogfood`.
 * Usage: Runs under `npm test` via tsx's test runner.
 * Invariants/Assumptions: Importing the dogfood script must not execute its live browser smoke.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseDogfoodArgs } from "../scripts/verify-agent-browser-dogfood.ts";

test("parseDogfoodArgs accepts artifact, retention, json, and help flags", () => {
	assert.deepEqual(parseDogfoodArgs(["--artifact-dir", "/tmp/pi-dogfood", "--keep-artifacts", "--json"]), {
		artifactDir: "/tmp/pi-dogfood",
		help: false,
		json: true,
		keepArtifacts: true,
	});
	assert.deepEqual(parseDogfoodArgs(["--help"]), { help: true });
});

test("parseDogfoodArgs rejects unknown options and missing artifact directory values", () => {
	assert.throws(() => parseDogfoodArgs(["--artifact-dir"]), /--artifact-dir requires a path/);
	assert.throws(() => parseDogfoodArgs(["--artifact-dir", "--json"]), /--artifact-dir requires a path/);
	assert.throws(() => parseDogfoodArgs(["--bogus"]), /Unknown dogfood argument: --bogus/);
});
