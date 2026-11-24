import { sanitizeRenderedSingleLine } from "../../display-sanitize.js";
import { isRecord } from "../../parsing.js";
import { redactSensitiveText } from "../../runtime.js";
import {
	getArrayField,
	getStringField,
	redactModelFacingText,
	stringifyModelFacing,
} from "./common.js";

type Data = Readonly<Record<string, unknown>>;
const AUTH_SHOW_SAFE_FIELDS = [
	"name",
	"profile",
	"url",
	"username",
	"createdAt",
	"updatedAt",
] as const;
const SESSION_FIELDS = [
	"session",
	"namespace",
	"socketDir",
	"active",
	"pid",
	"version",
	"runtimeError",
];
const RUNTIME_FIELDS = [
	"session",
	"namespace",
	"socketDir",
	"backgroundPid",
	"browserLaunched",
	"browser",
	"recording",
	"capabilities",
	"pageCount",
	"engine",
	"launchHash",
	"compatibilityStatus",
	"restoreKey",
	"restoreStatus",
	"restoreSkippedOrigins",
	"restoreLoadedPath",
	"restoreValidationPending",
	"restoreSave",
	"saveStatus",
	"restoreSavedPath",
];

function getSafeStringField(data: Data, key: string): string | undefined {
	const value = getStringField(data, key);
	return value === undefined ? undefined : sanitizeRenderedSingleLine(value);
}

function tabSelector(tab: Data, label: string | undefined, index: number): string {
	const tabId = getSafeStringField(tab, "tabId");
	if (tabId !== undefined) {
		return tabId;
	}
	if (label !== undefined) {
		return label;
	}
	return typeof tab.index === "number" ? String(tab.index) : String(index);
}

function formatTabKeepTag(keep: string | undefined): string {
	return keep === "live" || keep === "frozen" ? ` keep=${redactModelFacingText(keep)}` : "";
}

function tabLine(tab: unknown, index: number): string {
	if (!isRecord(tab)) {
		return `${index}: <invalid tab>`;
	}
	const marker = tab.active === true ? "*" : "-";
	const title =
		typeof tab.title === "string" ? sanitizeRenderedSingleLine(tab.title) : "(untitled)";
	const url = typeof tab.url === "string" ? sanitizeRenderedSingleLine(tab.url) : "(no url)";
	const label = getSafeStringField(tab, "label");
	const selector = tabSelector(tab, label, index);
	const labelText =
		label !== undefined && label !== selector ? ` label=${redactModelFacingText(label)}` : "";
	const target = getSafeStringField(tab, "targetId");
	const targetText =
		target !== undefined && target !== selector ? ` target=${redactModelFacingText(target)}` : "";
	const keepText = formatTabKeepTag(getSafeStringField(tab, "keep"));
	return `${marker} [${selector}]${labelText}${targetText}${keepText} ${title} — ${url}`;
}

export function getTabSummary(data: Data): string | undefined {
	const tabs = getArrayField(data, "tabs");
	return tabs ? tabs.map(tabLine).join("\n") : undefined;
}

function sessionMetadata(item: Data): string {
	const url = getSafeStringField(item, "url");
	const title = getSafeStringField(item, "title");
	const label = getSafeStringField(item, "label");
	const tabCount =
		typeof item.tabCount === "number"
			? `${item.tabCount} tab${item.tabCount === 1 ? "" : "s"}`
			: undefined;
	return [
		`active=${item.active === true ? "true" : "false"}`,
		label === undefined ? undefined : `label=${redactModelFacingText(label)}`,
		title === undefined ? undefined : `title=${redactSensitiveText(title)}`,
		url === undefined ? undefined : `url=${redactSensitiveText(url)}`,
		tabCount,
	]
		.filter(Boolean)
		.join("; ");
}

function sessionLine(item: unknown, index: number): string {
	if (!isRecord(item)) {
		return `${index + 1}. ${stringifyModelFacing(item)}`;
	}
	const name = sanitizeRenderedSingleLine(
		redactModelFacingText(
			getStringField(item, "name") ??
				getStringField(item, "session") ??
				getStringField(item, "id") ??
				`(session ${index + 1})`,
		),
	);
	return `${index + 1}. name=${name}${item.active === true ? " *active*" : ""}; ${sessionMetadata(item)}`;
}

function nativeIdentityValue(value: unknown): string {
	if (value === undefined || value === null) {
		return "unknown";
	}
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return stringifyModelFacing(value);
}

function formatRuntimeIdentity(data: Data): string {
	const runtime = data.runtime;
	const browser = isRecord(runtime) && isRecord(runtime.browser) ? runtime.browser : undefined;
	const identity = [
		`Daemon: ${data.active === true ? "active" : "inactive"}; PID: ${nativeIdentityValue(data.pid)}`,
		`Browser: ${nativeIdentityValue(browser?.status)}; alive: ${nativeIdentityValue(browser?.alive)}; Chrome PID: ${nativeIdentityValue(browser?.pid)}`,
		`Exact profile: ${nativeIdentityValue(browser?.userDataDir)}`,
		`Native browser ownership: ${nativeIdentityValue(browser?.ownership)}; Pi cleanup ownership: ${nativeIdentityValue(data.piCleanupOwnership)}`,
	].join("\n");
	return `${redactModelFacingText(identity)}\n\n${stringifyModelFacing({
		...Object.fromEntries(SESSION_FIELDS.map((key) => [key, data[key]])),
		// Native runtime also includes restore check URLs, text and code; show status/identity only.
		runtime: isRecord(runtime)
			? Object.fromEntries(RUNTIME_FIELDS.map((key) => [key, runtime[key]]))
			: runtime,
	})}`;
}

export function formatSessionText(data: Data): string | undefined {
	const sessions = getArrayField(data, "sessions");
	if (sessions) {
		return sessions.length === 0 ? "No active sessions." : sessions.map(sessionLine).join("\n");
	}
	if (typeof data.active === "boolean") {
		return formatRuntimeIdentity(data);
	}
	const session = getStringField(data, "session");
	return session === undefined
		? undefined
		: `Current session: ${sanitizeRenderedSingleLine(redactModelFacingText(session))}`;
}

export function formatProfilesText(profiles: readonly unknown[], label: string): string {
	if (profiles.length === 0) {
		return `No ${label}.`;
	}
	return profiles
		.map((item, index) => {
			if (!isRecord(item)) {
				return `${index + 1}. ${stringifyModelFacing(item)}`;
			}
			const name = sanitizeRenderedSingleLine(
				redactModelFacingText(
					getStringField(item, "name") ??
						getStringField(item, "profile") ??
						`(unnamed ${index + 1})`,
				),
			);
			const directory = getStringField(item, "directory") ?? getStringField(item, "path");
			return directory === undefined
				? `${index + 1}. ${name}`
				: `${index + 1}. ${name} (${sanitizeRenderedSingleLine(redactModelFacingText(directory))})`;
		})
		.join("\n");
}

export function formatAuthShowText(data: Data): string | undefined {
	const lines = AUTH_SHOW_SAFE_FIELDS.flatMap((key) => {
		const value = data[key];
		return typeof value === "string" && value.trim().length > 0
			? [`${key}: ${sanitizeRenderedSingleLine(redactModelFacingText(value.trim()))}`]
			: [];
	});
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function stateLine(item: unknown, index: number): string {
	if (!isRecord(item)) {
		return `${index + 1}. ${stringifyModelFacing(item)}`;
	}
	const name = sanitizeRenderedSingleLine(
		getStringField(item, "name") ??
			getStringField(item, "file") ??
			getStringField(item, "path") ??
			`(state ${index + 1})`,
	);
	const url = getSafeStringField(item, "url");
	return url === undefined
		? `${index + 1}. ${redactModelFacingText(name)}`
		: `${index + 1}. ${redactModelFacingText(name)} — ${redactSensitiveText(url)}`;
}

function stateShowText(data: Data): string {
	const filename = sanitizeRenderedSingleLine(
		getStringField(data, "filename") ?? getStringField(data, "name") ?? "saved state",
	);
	const summary = getSafeStringField(data, "summary");
	const lines = [`Saved state: ${redactModelFacingText(filename)}`];
	if (summary !== undefined) {
		lines.push(`Summary: ${redactModelFacingText(summary)}`);
	}
	if (typeof data.encrypted === "boolean") {
		lines.push(`Encrypted: ${data.encrypted ? "yes" : "no"}`);
	}
	if (typeof data.size === "number") {
		lines.push(`Size: ${data.size} bytes`);
	}
	return lines.join("\n");
}

function stateLoadText(data: Data): string {
	const loaded = `State loaded: ${sanitizeRenderedSingleLine(redactModelFacingText(getStringField(data, "path") ?? getStringField(data, "name") ?? "ok"))}`;
	const skipped = (getArrayField(data, "skippedOrigins") ?? []).filter(
		(origin): origin is string => typeof origin === "string",
	);
	// Native writes storage only while the page stays on the saved origin and lists the rest.
	return skipped.length === 0
		? loaded
		: `${loaded}\nSkipped storage for origins (page did not stay on that origin): ${sanitizeRenderedSingleLine(redactModelFacingText(skipped.join(", ")))}`;
}

export function formatStateText(data: Data, subcommand?: string): string | undefined {
	if (subcommand === "show") {
		return stateShowText(data);
	}
	const states = getArrayField(data, "states") ?? getArrayField(data, "files");
	if (states) {
		return states.length === 0 ? "No saved states." : states.map(stateLine).join("\n");
	}
	if (data.loaded === true) {
		return stateLoadText(data);
	}
	return data.cleared === true || data.clear === true ? "State cleared." : undefined;
}
