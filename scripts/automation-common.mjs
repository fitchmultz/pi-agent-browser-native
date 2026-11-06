/** Native-only boundary for the pinned shared CI helpers, available before npm ci. */
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isConfigObject } from "../extensions/agent-browser/lib/config-policy.js";
import { readModuleOperation } from "./runtime-module.mjs";

/** @typedef {Readonly<Omit<import("node:child_process").SpawnSyncOptions, "encoding">> & {readonly quiet?: boolean}} RunOptions */
/** @typedef {NodeJS.ProcessEnv & {PATH: string}} IsolatedEnvironment */

// Shared scripts/common.mjs:68-96 supplies string environment values and the host Node PATH.
/** @param {unknown} value
 * @returns {value is IsolatedEnvironment}
 */
function isEnvironment(value) {
	return (
		isConfigObject(value) &&
		typeof value.PATH === "string" &&
		Object.values(value).every((entry) => typeof entry === "string")
	);
}

/** @param {string} directory */
export async function loadCommonAutomation(directory) {
	/** @type {unknown} */
	const module = await import(pathToFileURL(join(resolve(directory), "scripts/common.mjs")).href);
	const operations = {
		isolatedEnvironment: readModuleOperation(module, "isolatedEnvironment"),
		run: readModuleOperation(module, "run"),
		readJson: readModuleOperation(module, "readJson"),
		sha256: readModuleOperation(module, "sha256"),
		writeJson: readModuleOperation(module, "writeJson"),
	};
	return {
		/** @param {string} root */
		isolatedEnvironment(root) {
			const environment = operations.isolatedEnvironment(root);
			assert.ok(
				isEnvironment(environment),
				"Shared automation must return a process environment with PATH.",
			);
			return environment;
		},
		/** @param {string} command
		 * @param {readonly string[]} args
		 * @param {RunOptions} [options]
		 */
		run(command, args, options = {}) {
			const output = operations.run(command, args, options);
			assert.ok(
				output === null || typeof output === "string",
				"Shared automation run must return captured UTF-8 text or null for inherited output.",
			);
			return output;
		},
		/** @param {string} command
		 * @param {readonly string[]} args
		 * @param {RunOptions} [options]
		 */
		capture(command, args, options = {}) {
			const output = operations.run(command, args, options);
			assert.ok(typeof output === "string", "Shared automation command must capture stdout.");
			return output;
		},
		/** @param {string} file */
		readJson(file) {
			return operations.readJson(file);
		},
		/** @param {string} file */
		sha256(file) {
			const hash = operations.sha256(file);
			assert.ok(typeof hash === "string", "Shared automation SHA-256 must be a string.");
			return hash;
		},
		/** @param {string} file
		 * @param {unknown} value
		 */
		writeJson(file, value) {
			assert.equal(
				operations.writeJson(file, value),
				undefined,
				"Shared automation JSON writes must complete synchronously.",
			);
		},
	};
}

/** @typedef {Awaited<ReturnType<typeof loadCommonAutomation>>} CommonAutomation */
