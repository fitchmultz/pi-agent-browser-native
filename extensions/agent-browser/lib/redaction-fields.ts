const SENSITIVE_FIELD_NAME_PATTERN =
	/^(?:[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|secret(?:[_-]?(?:key|access[_-]?key))?|token|password|passwd|credentials?|database[_-]?url|db[_-]?url|connection[_-]?string|mongo(?:db)?[_-]?uri|redis[_-]?url)|[A-Za-z0-9]*(?:apiKey|ApiKey|apikey|privateKey|PrivateKey|databaseUrl|DatabaseUrl|dbUrl|DbUrl|connectionString|ConnectionString|mongoUri|MongoUri|mongodbUri|MongodbUri|mongoDbUri|MongoDbUri|redisUrl|RedisUrl|Token|Secret|Password|Credential|Credentials)|auth(?:orization)?|bearer|client(?:_|-)?secret|cookie|id(?:_|-)?token|pass(?:word)?|proxy(?:_|-)?authorization|refresh(?:_|-)?token|sentry(?:_|-)?key|session(?:_|-)?id|set(?:_|-)?cookie|sig(?:nature)?|write(?:_|-)?key|x(?:_|-)?api(?:_|-)?key)$/i;
const ENV_SECRET_ASSIGNMENT_PATTERN =
	/\b((?:export\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/g;

export function isSensitiveFieldName(key: string): boolean {
	SENSITIVE_FIELD_NAME_PATTERN.lastIndex = 0;
	return SENSITIVE_FIELD_NAME_PATTERN.test(key);
}

function isEnvSecretAssignmentKey(key: string): boolean {
	if (!isSensitiveFieldName(key)) {
		return false;
	}
	if (key === "password" || key.includes("_") || key.includes("-") || key === key.toUpperCase()) {
		return true;
	}
	return /(?:apiKey|ApiKey|privateKey|PrivateKey|databaseUrl|DatabaseUrl|dbUrl|DbUrl|connectionString|ConnectionString|mongoUri|MongoUri|mongodbUri|MongodbUri|mongoDbUri|MongoDbUri|redisUrl|RedisUrl|Token|Secret|Password|Credential|Credentials)$/.test(
		key,
	);
}

function isLineBoundary(text: string, index: number): boolean {
	return index < 0 || index >= text.length || text[index] === "\n" || text[index] === "\r";
}

function redactPasswordAssignment(
	text: string,
	match: string,
	prefix: string,
	offset: number,
): string {
	// The loose matcher cannot safely distinguish inline punctuation from password characters.
	const end = offset + match.length;
	if (
		!isLineBoundary(text, offset - 1) ||
		!isLineBoundary(text, end) ||
		/^(?:\[REDACTED\]|%5Bredacted%5D)/i.test(match.slice(prefix.length))
	) {
		return match;
	}
	const value = match.slice(prefix.length);
	const boundary =
		value[0] === '"' || value[0] === "'" ? -1 : value.search(/[&#](?=[A-Za-z_][A-Za-z0-9_-]*\s*=)/);
	return `${prefix}[REDACTED]${boundary < 0 ? "" : value.slice(boundary)}`;
}

export function redactEnvSecretAssignments(text: string): string {
	return text.replace(
		ENV_SECRET_ASSIGNMENT_PATTERN,
		// String.replace supplies match, prefix/key captures, then the source offset.
		(match: string, prefix: string, key: string, offset: number) => {
			if (!isEnvSecretAssignmentKey(key)) {
				return match;
			}
			return key === "password"
				? redactPasswordAssignment(text, match, prefix, offset)
				: `${prefix}[REDACTED]`;
		},
	);
}

function credentialTrailingPunctuation(credential: string): string {
	return credential.match(/[,.:;!?]+$/)?.[0] ?? "";
}

function formatRedactedCredential(label: string, credential: string): string {
	return `${label} [REDACTED]${credentialTrailingPunctuation(credential)}`;
}

export function redactBearerCredentials(text: string): string {
	return text
		.replace(
			/((?:\b([A-Za-z][A-Za-z0-9_-]*)\s*[:=]\s*|(?:^|\s)(?:-H\s*|--header(?:\s+|=)))["']?Bearer)\s+([^\s"',)[\]]+)/gi,
			// Punctuation outside the credential stays in the original text.
			(match: string, label: string, field: string | undefined, credential: string) => {
				if (field !== undefined && field.length > 0 && !isSensitiveFieldName(field)) {
					return match;
				}
				return formatRedactedCredential(label, credential);
			},
		)
		.replace(
			/\b(Bearer)\s+([^\s\\"',)[\]]+)/gi,
			(match: string, label: string, credential: string) => {
				// Require a bearer-token shape without a credential field/header, not prose, HTML or a URL.
				const token = credential.slice(
					0,
					credential.length - credentialTrailingPunctuation(credential).length,
				);
				if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token) || !/[0-9._~+/=-]/.test(token)) {
					return match;
				}
				return formatRedactedCredential(label, credential);
			},
		);
}

export function redactStandaloneBasicCredential(text: string): string {
	return text.replace(
		/\b(Basic)\s+([A-Za-z0-9+/=]{12,})/gi,
		(match: string, label: string, credential: string) => {
			if (!/[0-9+/=]/.test(credential)) {
				return match;
			}
			return `${label} [REDACTED]`;
		},
	);
}
