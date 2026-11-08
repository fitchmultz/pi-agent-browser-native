/** Read-only Pi settings and autoload source discovery for the package doctor. */
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import stripJsonComments from "strip-json-comments";

/** @typedef {{readonly status: "pass" | "warn" | "fail", readonly title: string, readonly lines: readonly string[], readonly warnings?: readonly string[]}} DoctorCheck */
/** @typedef {{kind: string, source: string, location: string}} PiSource */
/** @typedef {{cwd: string, agentDir: string, settingsPaths: readonly string[], readText: (path: string) => Promise<string | undefined>, pathExists: (path: string) => Promise<boolean>}} PiSourcesOptions */

const PACKAGE_NAME = "pi-agent-browser-native";
const REPO_URL_FRAGMENT = "github.com/fitchmultz/pi-agent-browser-native";
const EXTENSION_ENTRYPOINTS = [
	"extensions/agent-browser/index.ts",
	"dist/extensions/agent-browser/index.js",
];
const THIS_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} childPath
 * @param {string} parentPath */
function isInsidePath(childPath, parentPath) {
	const child = resolve(childPath);
	const parent = resolve(parentPath);
	return child === parent || child.startsWith(`${parent}${sep}`);
}

/** @param {string} path */
function expandUserPath(path) {
	if (path === "~") {
		return homedir();
	}
	if (path.startsWith("~/")) {
		return resolve(homedir(), path.slice(2));
	}
	return path;
}

/** @param {string} source */
function isPathLikeSource(source) {
	return (
		isAbsolute(source) ||
		source.startsWith("./") ||
		source.startsWith("../") ||
		source.startsWith("~")
	);
}

/** @param {unknown} source
 * @param {string} cwd
 * @param {string} sourceBaseDir */
function sourceLooksLikeThisPackage(source, cwd, sourceBaseDir = cwd) {
	const text = String(source).trim();
	if (text.length === 0) {
		return false;
	}
	if (
		/^npm:pi-agent-browser-native(?:@|$)/.test(text) ||
		text === PACKAGE_NAME ||
		text.includes(REPO_URL_FRAGMENT)
	) {
		return true;
	}
	if (!isPathLikeSource(text)) {
		return false;
	}
	const resolvedSource = resolve(sourceBaseDir, expandUserPath(text));
	return [cwd, THIS_PACKAGE_ROOT].some(
		(root) =>
			resolvedSource === root ||
			EXTENSION_ENTRYPOINTS.some((entrypoint) =>
				isInsidePath(resolve(root, entrypoint), resolvedSource),
			),
	);
}

/** @param {unknown} value
 * @returns {Iterable<[number, unknown]>} */
function arrayEntries(value) {
	const entries = Array.isArray(value) ? value : [];
	return entries.entries();
}

/** @param {unknown} entry
 * @returns {unknown} */
function entrySource(entry) {
	if (typeof entry === "string") {
		return entry;
	}
	if (entry !== null && typeof entry === "object") {
		const source = "source" in entry ? entry.source : undefined;
		const path = "path" in entry ? entry.path : undefined;
		const packageName = "package" in entry ? entry.package : undefined;
		return source ?? path ?? packageName;
	}
	return;
}

/** @param {unknown} settings
 * @param {string} settingsPath
 * @param {string} cwd
 * @returns {PiSource[]} */
function collectSettingsSources(settings, settingsPath, cwd) {
	if (settings === null || typeof settings !== "object") {
		return [];
	}
	/** @type {PiSource[]} */
	const sources = [];
	const sourceBaseDir = dirname(settingsPath);
	const fields = {
		packages: { kind: "package", value: "packages" in settings ? settings.packages : undefined },
		extensions: {
			kind: "extension",
			value: "extensions" in settings ? settings.extensions : undefined,
		},
	};
	for (const [field, { kind, value }] of Object.entries(fields)) {
		for (const [index, entry] of arrayEntries(value)) {
			const source = entrySource(entry);
			if (sourceLooksLikeThisPackage(source, cwd, sourceBaseDir)) {
				sources.push({
					kind,
					source: String(source),
					location: `${settingsPath} ${field}[${index}]`,
				});
			}
		}
	}
	return sources;
}

/** @param {Pick<PiSourcesOptions, "cwd" | "readText"> & {path: string}} options */
async function inspectSettingsPath({ path, cwd, readText }) {
	try {
		const text = await readText(path);
		if (text === undefined) {
			return { sources: [], warnings: [] };
		}
		/** @type {unknown} */
		const settings = JSON.parse(stripJsonComments(text));
		return { sources: collectSettingsSources(settings, path, cwd), warnings: [] };
	} catch (error) {
		return {
			sources: [],
			warnings: [
				`Could not inspect Pi settings ${path}: ${error instanceof Error ? error.message : String(error)}`,
			],
		};
	}
}

/** @param {Pick<PiSourcesOptions, "cwd" | "pathExists">} options */
async function collectRepoLocalSources({ cwd, pathExists }) {
	const candidates = [
		resolve(cwd, ".pi/extensions/agent-browser.ts"),
		resolve(cwd, ".pi/extensions/agent-browser/index.ts"),
	];
	const sources = [];
	for (const candidate of candidates) {
		// Inspect one autoload location at a time to preserve the injected read-only I/O order.
		if (await pathExists(candidate)) {
			sources.push({
				kind: "repo-local",
				source: candidate,
				location: `${candidate} repo-local autoload`,
			});
		}
	}
	return sources;
}

/**
 * @param {PiSourcesOptions} options
 * @returns {Promise<DoctorCheck & {readonly warnings: readonly string[]}>}
 */
export async function checkPiSources({ cwd, agentDir, settingsPaths, readText, pathExists }) {
	const defaultSettingsPaths = [
		resolve(agentDir, "settings.json"),
		resolve(cwd, ".pi/settings.json"),
	];
	const allSettingsPaths = [
		...new Set([...defaultSettingsPaths, ...settingsPaths].map((path) => resolve(path))),
	];
	const sources = [];
	const warnings = [];
	for (const path of allSettingsPaths) {
		// Settings are inspected in configured precedence order; injected I/O preserves that order.
		if (await pathExists(path)) {
			// Finish reading this settings file before reporting and inspecting the next source.
			const result = await inspectSettingsPath({ path, cwd, readText });
			sources.push(...result.sources);
			warnings.push(...result.warnings);
		}
	}
	sources.push(...(await collectRepoLocalSources({ cwd, pathExists })));
	if (sources.length > 1) {
		return {
			status: "fail",
			title: "Duplicate pi-agent-browser-native sources detected.",
			lines: [
				"Pi may register multiple `agent_browser` tools when a checkout source and a package source are both active.",
				"Detected sources:",
				...sources.map((source) => `- ${source.source} from ${source.location}`),
				"Keep exactly one active source:",
				"- for normal use: keep `pi install npm:pi-agent-browser-native` and remove/disable checkout paths from Pi settings",
				"- for temporary package or checkout trials: use `pi --approve --no-extensions -e builtin:tool-search -e <source>` when you intentionally trust the current project, or omit `--approve` to let Pi prompt in interactive mode",
				"- for configured-source lifecycle validation: keep exactly one checkout or package source, then launch plain `pi`",
			],
			warnings,
		};
	}
	const [source] = sources;
	if (source !== undefined) {
		return {
			status: "pass",
			title: "No duplicate pi-agent-browser-native sources detected.",
			lines: [`Detected source: ${source.source} from ${source.location}`],
			warnings,
		};
	}
	return {
		status: "warn",
		title: "No configured pi-agent-browser-native source was found in inspected Pi settings.",
		lines: [
			"This is OK for isolated runs such as `pi --no-extensions -e builtin:tool-search -e npm:pi-agent-browser-native`, but normal package use should install exactly one source with `pi install npm:pi-agent-browser-native`.",
		],
		warnings,
	};
}
