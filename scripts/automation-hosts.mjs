/** Validate shared host receipts while leaving installation and graph selection with their owner. */
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { readModuleOperation } from "./runtime-module.mjs";

// Shared scripts/hosts.mjs hostIdentity returns these fields for both pinned automation revisions.
export const hostIdentitySchema = Type.Object({
	directory: Type.String(),
	packageDir: Type.String(),
	packageDirs: Type.Record(Type.String(), Type.String()),
	version: Type.String(),
	index: Type.String(),
	cli: Type.String(),
	indexSha256: Type.String(),
	cliSha256: Type.String(),
	cohort: Type.Record(Type.String(), Type.String()),
	companions: Type.Record(Type.String(), Type.String()),
	runtimeLockSha256: Type.String(),
	runtimeGraphSha256: Type.String(),
});
export const preparedHostSchema = Type.Intersect([
	hostIdentitySchema,
	Type.Object({ flavor: Type.String(), provenance: Type.Unknown() }),
]);
/** @typedef {import("typebox").Static<typeof hostIdentitySchema>} HostIdentity */
/** @typedef {import("typebox").Static<typeof preparedHostSchema>} PreparedHost */

/** @param {string} directory */
export async function loadHostAutomation(directory) {
	/** @type {unknown} */
	const module = await import(pathToFileURL(join(resolve(directory), "scripts/hosts.mjs")).href);
	const identity = readModuleOperation(module, "hostIdentity");
	const prepare = readModuleOperation(module, "prepareHost");
	const select = readModuleOperation(module, "selectDevelopmentHost");
	return {
		/** @param {string} root
		 * @param {Readonly<NodeJS.ProcessEnv>} [env]
		 */
		hostIdentity(root, env = process.env) {
			const host = identity(root, env);
			assert.ok(
				Check(hostIdentitySchema, host),
				"Shared automation returned an invalid host identity.",
			);
			return host;
		},
		/** @param {string} root
		 * @param {"official" | "fork"} flavor
		 * @param {string} target
		 * @param {Readonly<NodeJS.ProcessEnv>} env
		 */
		async prepareHost(root, flavor, target, env) {
			const host = await prepare(root, flavor, target, env);
			assert.ok(
				Check(preparedHostSchema, host),
				"Shared automation returned an invalid prepared host.",
			);
			return host;
		},
		/** @param {string} root
		 * @param {Readonly<PreparedHost>} host
		 * @param {Readonly<NodeJS.ProcessEnv>} env
		 */
		selectDevelopmentHost(root, host, env) {
			const selected = select(root, host, env);
			assert.ok(
				Check(hostIdentitySchema, selected),
				"Shared automation returned an invalid selected host.",
			);
			return selected;
		},
	};
}
