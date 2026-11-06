/** Select native probe entrypoints without replacing their declarations or transitive resolution. */
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {{entry: string} | {from: string}} ProbeModuleTarget */
/** @template T @param {ReadonlyMap<string, ProbeModuleTarget>} targets @param {() => Promise<T>} load @returns {Promise<T>} */
async function withEntryPoints(targets, load) {
	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			const target = context.parentURL === import.meta.url ? targets.get(specifier) : undefined;
			if (target === undefined) {
				return nextResolve(specifier, context);
			}
			return "entry" in target
				? nextResolve(pathToFileURL(target.entry).href, context)
				: nextResolve(specifier, { ...context, parentURL: pathToFileURL(target.from).href });
		},
	});
	try {
		return await load();
	} finally {
		hooks.deregister();
	}
}

/** @param {string} sdkPath */
export async function loadNativeSdk(sdkPath) {
	return withEntryPoints(
		new Map([["@earendil-works/pi-coding-agent", { entry: sdkPath }]]),
		() => import("@earendil-works/pi-coding-agent"),
	);
}

/** @param {{sdkRoot: string, browserEntry: string, streamPath?: string | undefined}} options */
export async function loadRecordingModules({ sdkRoot, browserEntry, streamPath }) {
	const sdkPath = join(sdkRoot, "dist/index.js");
	/** @type {ProbeModuleTarget} */
	const aiTarget =
		streamPath === undefined || streamPath === "" ? { from: sdkPath } : { entry: streamPath };
	const library = join(dirname(browserEntry), "lib");
	/** @type {ReadonlyMap<string, ProbeModuleTarget>} */
	const targets = new Map([
		["@earendil-works/pi-coding-agent", { entry: sdkPath }],
		["@earendil-works/pi-ai", aiTarget],
		["../../dist/extensions/agent-browser/index.js", { entry: browserEntry }],

		[
			"../../dist/extensions/agent-browser/lib/recording-reservations.js",
			{ entry: join(library, "recording-reservations.js") },
		],
		[
			"../../dist/extensions/agent-browser/lib/prompt-policy.js",
			{ entry: join(library, "prompt-policy.js") },
		],
	]);
	return withEntryPoints(targets, async () => {
		const [sdk, ai, browser, reservations, prompts] = await Promise.all([
			import("@earendil-works/pi-coding-agent"),
			import("@earendil-works/pi-ai"),
			import("../../dist/extensions/agent-browser/index.js"),
			import("../../dist/extensions/agent-browser/lib/recording-reservations.js"),
			import("../../dist/extensions/agent-browser/lib/prompt-policy.js"),
		]);
		return {
			sdk,
			createAssistantMessageEventStream: ai.createAssistantMessageEventStream,
			browserExtension: browser.default,
			restoreRecordingReservationStateFromBranch:
				reservations.restoreRecordingReservationStateFromBranch,
			getLatestUserMessage: prompts.getLatestUserMessage,
			getMessageText: prompts.getMessageText,
		};
	});
}
