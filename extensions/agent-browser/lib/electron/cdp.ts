import { isRecord } from "../parsing.js";

const ELECTRON_CDP_FETCH_TIMEOUT_MS = 1_000;

export interface ElectronCdpVersion {
	readonly browser?: string;
	readonly protocolVersion?: string;
	readonly userAgent?: string;
	readonly v8Version?: string;
	readonly webKitVersion?: string;
	readonly webSocketDebuggerUrl?: string;
}

export interface ElectronCdpTarget {
	readonly id?: string;
	readonly title?: string;
	readonly type?: string;
	readonly url?: string;
	readonly webSocketDebuggerUrl?: string;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function parseCdpVersion(value: unknown): ElectronCdpVersion | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const browser = asString(value.Browser) ?? asString(value.browser);
	if (browser === undefined) {
		return undefined;
	}
	return {
		browser,
		protocolVersion: asString(value["Protocol-Version"]) ?? asString(value.protocolVersion),
		userAgent: asString(value["User-Agent"]) ?? asString(value.userAgent),
		v8Version: asString(value["V8-Version"]) ?? asString(value.v8Version),
		webKitVersion: asString(value["WebKit-Version"]) ?? asString(value.webKitVersion),
		webSocketDebuggerUrl: asString(value.webSocketDebuggerUrl),
	};
}

export function parseCdpTargets(value: unknown): ElectronCdpTarget[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter(isRecord).map((target) => ({
		id: asString(target.id),
		title: asString(target.title),
		type: asString(target.type),
		url: asString(target.url),
		webSocketDebuggerUrl: asString(target.webSocketDebuggerUrl),
	}));
}

export async function fetchCdpJson(url: string, signal?: AbortSignal): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), ELECTRON_CDP_FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
		});
		if (!response.ok) {
			return undefined;
		}
		return (await response.json()) as unknown;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

export function boundElectronProbeString(
	value: string | undefined,
	maxLength = 240,
): string | undefined {
	const trimmed = value?.trim();
	if (trimmed === undefined || trimmed.length === 0) {
		return undefined;
	}
	return trimmed.length > maxLength
		? `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`
		: trimmed;
}
