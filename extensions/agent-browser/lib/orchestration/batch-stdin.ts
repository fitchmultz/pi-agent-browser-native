export type BatchCommandStep = [string, ...string[]];

export function parseBatchCommandArgument(command: string): { error?: string; step?: BatchCommandStep } {
	const tokens: string[] = [];
	let token = "";
	let tokenStarted = false;
	let quote: "'" | '"' | undefined;
	let escaped = false;
	const finishToken = () => {
		if (!tokenStarted) return;
		tokens.push(token);
		token = "";
		tokenStarted = false;
	};
	for (const character of command) {
		if (escaped) {
			token += character;
			tokenStarted = true;
			escaped = false;
			continue;
		}
		if (quote === "'") {
			if (character === "'") quote = undefined;
			else token += character;
			tokenStarted = true;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			tokenStarted = true;
			continue;
		}
		if (quote === '"') {
			if (character === '"') quote = undefined;
			else token += character;
			tokenStarted = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			tokenStarted = true;
			continue;
		}
		if (/\s/u.test(character)) finishToken();
		else {
			token += character;
			tokenStarted = true;
		}
	}
	if (escaped || quote !== undefined) return { error: "batch command has an unterminated escape or quote" };
	finishToken();
	return tokens.length > 0 ? { step: tokens as BatchCommandStep } : { error: "batch command is empty" };
}

function validateUserBatchStep(step: unknown, index: number): { error: string; ok: false } | { ok: true; step: BatchCommandStep } {
	if (!Array.isArray(step)) {
		return {
			error: `agent_browser batch stdin step ${index} must be a non-empty array of string command tokens.`,
			ok: false,
		};
	}
	if (step.length === 0) {
		return {
			error: `agent_browser batch stdin step ${index} must not be empty.`,
			ok: false,
		};
	}
	const invalidTokenIndex = step.findIndex((token) => typeof token !== "string");
	if (invalidTokenIndex !== -1) {
		return {
			error: `agent_browser batch stdin step ${index} token ${invalidTokenIndex} must be a string.`,
			ok: false,
		};
	}
	return { ok: true, step: step as BatchCommandStep };
}

export function parseBatchStdinJsonArray(stdin: string | undefined): { error?: string; steps?: unknown[] } {
	if (stdin === undefined) {
		return { steps: [] };
	}
	try {
		const parsed = JSON.parse(stdin) as unknown;
		if (!Array.isArray(parsed)) {
			return { error: "agent_browser batch stdin must be a JSON array of command steps." };
		}
		return { steps: parsed };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: `agent_browser batch stdin could not be parsed as JSON: ${message}` };
	}
}

export function parseUserBatchStdin(stdin: string | undefined): { error?: string; steps?: BatchCommandStep[] } {
	const parsed = parseBatchStdinJsonArray(stdin);
	if (parsed.error || parsed.steps === undefined) {
		return parsed.error ? { error: parsed.error } : { steps: [] };
	}
	const steps: BatchCommandStep[] = [];
	for (const [index, rawStep] of parsed.steps.entries()) {
		const validated = validateUserBatchStep(rawStep, index);
		if (!validated.ok) {
			return { error: validated.error };
		}
		steps.push(validated.step);
	}
	return { steps };
}

export function parseValidBatchStepEntries(stdin: string | undefined): Array<{ index: number; step: BatchCommandStep }> {
	const parsed = parseBatchStdinJsonArray(stdin);
	if (parsed.error || parsed.steps === undefined) return [];
	return parsed.steps.flatMap((step, index) => {
		const validated = validateUserBatchStep(step, index);
		return validated.ok ? [{ index, step: validated.step }] : [];
	});
}
