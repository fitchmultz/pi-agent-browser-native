/** Callable exports from runtime-selected modules; their results remain untrusted at this boundary. */
import assert from "node:assert/strict";
import { isConfigObject } from "../extensions/agent-browser/lib/config-policy.js";

/** @typedef {(...args: readonly unknown[]) => unknown} RuntimeOperation */

/** @param {unknown} value
 * @returns {value is RuntimeOperation}
 */
function isRuntimeOperation(value) {
	return typeof value === "function";
}

/** @param {unknown} module
 * @param {string} name
 */
export function readModuleOperation(module, name) {
	assert.ok(isConfigObject(module), "Expected a module namespace.");
	const operation = module[name];
	assert.ok(isRuntimeOperation(operation), `Module must export function ${name}.`);
	return operation;
}
