import { isSensitiveFieldName } from "./redaction-fields.js";

const SENSITIVE_QUERY_PARAM_PATTERN =
	/^(?:access(?:_|-)?token|api(?:_|-)?key|auth|authorization|authorization(?:_|-)?session(?:_|-)?id|bearer|client(?:_|-)?secret|code|cookie|id(?:_|-)?token|key|pass(?:word)?|refresh(?:_|-)?token|relay(?:_|-)?state|saml(?:_|-)?request|saml(?:_|-)?response|secret|sentry(?:_|-)?key|session(?:_|-)?id|sig(?:nature)?|token|write(?:_|-)?key)$/i;
const AUTH_STATE_QUERY_PARAM_PATTERN = /^(?:nonce|state)$/i;
const AUTH_URL_CONTEXT_PATTERN =
	/(?:^|[./_-])(?:auth|authorize|callback|login|oauth2?|oidc|saml|sso)(?:[./?#_-]|$)/i;

function shouldRedactQueryParam(name: string): boolean {
	return SENSITIVE_QUERY_PARAM_PATTERN.test(name) || isSensitiveFieldName(name);
}

function isSensitiveParameter(name: string, authContext: boolean): boolean {
	return shouldRedactQueryParam(name) || (authContext && AUTH_STATE_QUERY_PARAM_PATTERN.test(name));
}

function redactParameters(params: URLSearchParams, authContext: boolean): boolean {
	let mutated = false;
	for (const [name] of params) {
		if (isSensitiveParameter(name, authContext)) {
			params.set(name, "[REDACTED]");
			mutated = true;
		}
	}
	return mutated;
}

function getHashParameters(hash: string): URLSearchParams | undefined {
	const text = hash.startsWith("#") ? hash.slice(1) : hash;
	return text.includes("=") ? new URLSearchParams(text) : undefined;
}

export function redactUrlToken(token: string): string {
	let parsed: URL;
	try {
		parsed = new URL(token);
	} catch {
		return token;
	}
	const originalHref = parsed.href;
	if (parsed.username.length > 0) {
		parsed.username = "[REDACTED]";
	}
	if (parsed.password.length > 0) {
		parsed.password = "[REDACTED]";
	}
	const hashParams = getHashParameters(parsed.hash);
	const authContext =
		AUTH_URL_CONTEXT_PATTERN.test(`${parsed.hostname}${parsed.pathname}`) ||
		[...parsed.searchParams.keys(), ...(hashParams?.keys() ?? [])].some(shouldRedactQueryParam);
	redactParameters(parsed.searchParams, authContext);
	if (hashParams && redactParameters(hashParams, authContext)) {
		parsed.hash = `#${hashParams.toString()}`;
	}
	return parsed.href === originalHref ? token : parsed.href;
}

function decodeParameterName(raw: string): string {
	try {
		return decodeURIComponent(raw.replace(/\+/g, " "));
	} catch {
		return raw;
	}
}

function redactLooseUrlParameterText(text: string): string {
	return text.replace(/(?<![^\s"'`<>\])}])[^\s"'`<>\])}]*[?#&][^\s"'`<>\])}]*/g, (token) => {
		const queryNames = [...token.matchAll(/[?#&]([^=&#\s"'`<>\])}]+)=/g)].map((match) =>
			decodeParameterName(match[0].slice(1, -1)),
		);
		const authContext =
			AUTH_URL_CONTEXT_PATTERN.test(token) || queryNames.some(shouldRedactQueryParam);
		return token.replace(
			/([?#&])([^=&#\s"'`<>\])}]+)=([^&#\s"'`<>\])}]*)/g,
			(match: string, separator: string, rawName: string, rawValue: string) => {
				if (
					rawValue === "[REDACTED" ||
					rawValue === "[REDACTED]" ||
					/%5Bredacted%5D/i.test(rawValue)
				) {
					return match;
				}
				if (!isSensitiveParameter(decodeParameterName(rawName), authContext)) {
					return match;
				}
				return `${separator}${rawName}=[REDACTED]`;
			},
		);
	});
}

function redactLooseUrlUserinfo(text: string): string {
	return text.replace(
		/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s"'`/@]+)@([^\s"'`]+)/g,
		(match: string, prefix: string, userinfo: string, suffix: string) => {
			if (/%5Bredacted%5D/i.test(userinfo)) {
				return match;
			}
			if (userinfo.includes("[REDACTED]")) {
				return redactLooseUrlParameterText(match);
			}
			return redactLooseUrlParameterText(
				`${prefix}${userinfo.includes(":") ? "[REDACTED]:[REDACTED]" : "[REDACTED]"}@${suffix}`,
			);
		},
	);
}

export function redactLooseUrls(text: string): string {
	const urls = text.replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`<>\])]+/g, (match) =>
		redactUrlToken(match),
	);
	return redactLooseUrlParameterText(redactLooseUrlUserinfo(urls));
}
