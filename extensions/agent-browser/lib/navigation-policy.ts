/**
 * Purpose: Keep wrapper-side navigation policy parsing and evaluation small and explicit.
 * Responsibilities: Parse allowed-domain argv values and detect final-page host escapes.
 * Scope: Wrapper diagnostics only; upstream remains responsible for browser-time enforcement.
 */

export interface AllowedDomainsPolicy {
	allowedDomains: string[];
	display: string;
}

export interface AllowedDomainsViolation {
	allowedDomains: string[];
	allowedDisplay: string;
	observedHost: string;
	observedUrl: string;
	summary: string;
}

function normalizeDomainEntry(value: string): string | undefined {
	let candidate = value.trim().toLowerCase();
	if (!candidate) return undefined;
	try {
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
			candidate = new URL(candidate).hostname;
		}
	} catch {
		return undefined;
	}
	candidate = candidate.replace(/^\*\./, "").replace(/\.$/, "");
	if (candidate.includes("/")) candidate = candidate.split("/")[0] ?? "";
	if (candidate.includes(":")) candidate = candidate.split(":")[0] ?? "";
	return candidate.length > 0 ? candidate : undefined;
}

function splitAllowedDomainsValue(value: string): string[] {
	return value.split(/[,\s]+/).map((entry) => entry.trim()).filter(Boolean);
}

export function parseAllowedDomainsPolicyFromArgs(args: readonly string[]): AllowedDomainsPolicy | undefined {
	const domains: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--allowed-domains") {
			const value = args[index + 1];
			if (value && !value.startsWith("-")) {
				domains.push(...splitAllowedDomainsValue(value));
				index += 1;
			}
			continue;
		}
		if (arg?.startsWith("--allowed-domains=")) {
			domains.push(...splitAllowedDomainsValue(arg.slice("--allowed-domains=".length)));
		}
	}
	const allowedDomains = [...new Set(domains.flatMap((domain) => {
		const normalized = normalizeDomainEntry(domain);
		return normalized ? [normalized] : [];
	}))];
	if (allowedDomains.length === 0) return undefined;
	return { allowedDomains, display: allowedDomains.join(", ") };
}

function normalizeObservedHost(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
		return parsed.hostname.toLowerCase().replace(/\.$/, "");
	} catch {
		return undefined;
	}
}

export function isHostAllowedByDomains(host: string, allowedDomains: readonly string[]): boolean {
	const normalizedHost = host.toLowerCase().replace(/\.$/, "");
	return allowedDomains.some((domain) => normalizedHost === domain || normalizedHost.endsWith(`.${domain}`));
}

export function getAllowedDomainsViolation(options: {
	policy?: AllowedDomainsPolicy;
	url?: string;
}): AllowedDomainsViolation | undefined {
	if (!options.policy || !options.url) return undefined;
	const observedHost = normalizeObservedHost(options.url);
	if (!observedHost) return undefined;
	if (isHostAllowedByDomains(observedHost, options.policy.allowedDomains)) return undefined;
	const summary = `Navigation policy blocked: --allowed-domains ${options.policy.display} does not allow ${observedHost} (${options.url}).`;
	return {
		allowedDomains: options.policy.allowedDomains,
		allowedDisplay: options.policy.display,
		observedHost,
		observedUrl: options.url,
		summary,
	};
}
