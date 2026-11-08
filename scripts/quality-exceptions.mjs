import assert from "node:assert/strict";

const lib = "extensions/agent-browser/lib/";
const toolSites = [
	["registerActionTool", "AGENT_BROWSER_ACTION_PARAMS"],
	["registerQaTool", "AGENT_BROWSER_QA_PARAMS"],
	["registerElectronTool", "AGENT_BROWSER_ELECTRON_PARAMS"],
	["registerSourceTools", "AGENT_BROWSER_SOURCE_PARAMS"],
	["registerSourceTools", "AGENT_BROWSER_NETWORK_SOURCE_PARAMS"],
];

/** @typedef {import("oxc-parser").Program} Program */
/** @typedef {import("oxc-parser").Expression} Expression */
/** @typedef {{start: number, end?: number | undefined, rule: string, id: string, operation: string}} Site */

/** @param {Program} program */
function declarations(program) {
	return program.body.map((node) =>
		node.type === "ExportNamedDeclaration" ? node.declaration : node,
	);
}

/** @param {Program} program
 * @param {string} name */
function functionBody(program, name) {
	const declaration = declarations(program).find(
		(node) => node?.type === "FunctionDeclaration" && node.id?.name === name,
	);
	assert.ok(
		declaration?.type === "FunctionDeclaration" && declaration.body,
		`Missing exception owner ${name}`,
	);
	return declaration.body.body;
}

/** @param {Expression} node
 * @returns {string} */
function memberName(node) {
	if (node.type === "Identifier") {
		return node.name;
	}
	if (node.type === "ThisExpression") {
		return "this";
	}
	if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
		return `${memberName(node.object)}.${node.property.name}`;
	}
	return "";
}

/** @param {readonly import("oxc-parser").Statement[]} statements
 * @param {string} callee */
function calls(statements, callee) {
	return statements.flatMap((node) =>
		node.type === "ExpressionStatement" &&
		node.expression.type === "CallExpression" &&
		memberName(node.expression.callee) === callee
			? [node.expression]
			: [],
	);
}

/** @param {import("oxc-parser").ObjectExpression} object
 * @param {string} name */
function property(object, name) {
	return object.properties.find(
		(node) => node.type === "Property" && node.key.type === "Identifier" && node.key.name === name,
	);
}

/** @param {import("oxc-parser").ObjectExpression} object
 * @param {string} name
 * @param {string} operation
 * @returns {Site} */
function callbackSite(object, name, operation) {
	const node = property(object, name);
	assert.ok(
		node?.type === "Property" &&
			(node.value.type === "FunctionExpression" || node.value.type === "ArrowFunctionExpression"),
		`Missing callback ${operation}`,
	);
	assert.equal(
		node.value.params.length,
		5,
		`${operation}: only the five-position SDK contract is authorized`,
	);
	return {
		start: node.start,
		end:
			node.value.body?.type === "BlockStatement"
				? node.value.body.start + 1
				: node.value.body?.start,
		rule: "max-params",
		id: "QX-002",
		operation,
	};
}

/** @param {Program} program */
function surfaceSites(program) {
	const sites = toolSites.map(([owner, schema]) => {
		assert.ok(owner !== undefined && schema !== undefined);
		const registrations = calls(functionBody(program, owner), "pi.registerTool");
		const objects = registrations.flatMap((call) =>
			call.arguments[0]?.type === "ObjectExpression" ? [call.arguments[0]] : [],
		);
		const object = objects.find((candidate) => {
			const params = property(candidate, "parameters");
			return (
				params?.type === "Property" &&
				params.value.type === "Identifier" &&
				params.value.name === schema
			);
		});
		assert.ok(object, `Missing registration ${owner}/${schema}`);
		return callbackSite(object, "execute", `${owner}/${schema}/execute`);
	});
	const owner = "registerAgentBrowserToolSurface";
	for (const statement of functionBody(program, owner)) {
		if (statement.type !== "VariableDeclaration") {
			continue;
		}
		for (const declaration of statement.declarations) {
			if (declaration.id.type !== "Identifier" || declaration.id.name !== "execute") {
				continue;
			}
			assert.ok(declaration.init?.type === "ArrowFunctionExpression");
			assert.equal(declaration.init.params.length, 5);
			sites.push({
				start: statement.start,
				end: declaration.init.body.start,
				rule: "max-params",
				id: "QX-002",
				operation: `${owner}/execute`,
			});
		}
	}
	return sites;
}

/** @param {Program} program */
function boundarySites(program) {
	const call = calls(
		functionBody(program, "registerBrowserTools"),
		"registerAgentBrowserToolSurface",
	)[0];
	const object = call?.arguments[1];
	assert.ok(object?.type === "ObjectExpression");
	return [callbackSite(object, "execute", "registerBrowserTools/execute")];
}

/** @param {Program} program */
function searchSites(program) {
	const declaration = declarations(program).find(
		(node) => node?.type === "TSTypeAliasDeclaration" && node.id.name === "WebSearchTool",
	);
	assert.ok(
		declaration?.type === "TSTypeAliasDeclaration" &&
			declaration.typeAnnotation.type === "TSTypeLiteral",
	);
	const member = declaration.typeAnnotation.members.find(
		(node) =>
			node.type === "TSPropertySignature" &&
			node.key.type === "Identifier" &&
			node.key.name === "execute",
	);
	assert.ok(
		member?.type === "TSPropertySignature" &&
			member.typeAnnotation?.typeAnnotation.type === "TSFunctionType",
	);
	assert.equal(member.typeAnnotation.typeAnnotation.params.length, 5);
	const returned = functionBody(program, "createAgentBrowserWebSearchTool").find(
		(node) => node.type === "ReturnStatement",
	);
	assert.ok(returned?.type === "ReturnStatement" && returned.argument?.type === "ObjectExpression");
	return [
		{
			start: member.start,
			end: member.end,
			rule: "max-params",
			id: "QX-002",
			operation: "WebSearchTool/execute",
		},
		callbackSite(returned.argument, "execute", "createAgentBrowserWebSearchTool/execute"),
	];
}

/** @param {Program} program */
function promptRegistrationBody(program) {
	const declaration = declarations(program).find(
		(node) => node?.type === "ClassDeclaration" && node.id?.name === "BrowserPrompt",
	);
	assert.ok(declaration?.type === "ClassDeclaration");
	const method = declaration.body.body.find(
		(node) =>
			node.type === "MethodDefinition" &&
			node.key.type === "Identifier" &&
			node.key.name === "register",
	);
	assert.ok(method?.type === "MethodDefinition" && method.value.body);
	return method.value.body.body;
}

/** @param {Program} program
 * @returns {Site[]} */
function promptSites(program) {
	const call = calls(promptRegistrationBody(program), "this.pi.on").find(
		(node) =>
			node.arguments[0]?.type === "Literal" && node.arguments[0].value === "before_agent_start",
	);
	const callback = call?.arguments[1];
	assert.ok(
		callback?.type === "ArrowFunctionExpression" && callback.body.type === "BlockStatement",
	);
	const statement = callback.body.body[0];
	assert.ok(
		statement?.type === "ExpressionStatement" &&
			statement.expression.type === "AssignmentExpression",
	);
	const assignment = statement.expression;
	assert.ok(
		assignment.left.type === "MemberExpression" &&
			memberName(assignment.left) === "event.systemPromptOptions.sections.agent_browser" &&
			assignment.operator === "=",
	);
	return [
		{
			start: statement.start,
			end: statement.end,
			rule: "no-param-reassign",
			id: "QX-003",
			operation: "BrowserPrompt/register/before_agent_start/sections.agent_browser",
		},
	];
}

/** @param {Program} program
 * @returns {Site[]} */
function credentialSites(program) {
	const attempt = functionBody(program, "resolveCommandCredential").find(
		(node) => node.type === "TryStatement",
	);
	assert.ok(attempt?.type === "TryStatement" && attempt.handler);
	const statement = attempt.handler.body.body.at(-1);
	assert.ok(
		statement?.type === "ThrowStatement" &&
			statement.argument.type === "NewExpression" &&
			memberName(statement.argument.callee) === "Error" &&
			statement.argument.arguments.length === 1 &&
			statement.argument.arguments[0]?.type === "Literal" &&
			typeof statement.argument.arguments[0].value === "string",
		"Only the content-free credential failure is authorized",
	);
	return [
		{
			start: statement.start,
			end: statement.end,
			rule: "eslint/preserve-caught-error",
			id: "QX-004",
			operation: "resolveCommandCredential/catch/sanitized-error",
		},
	];
}

/** @param {Program} program
 * @param {string} owner
 * @param {readonly string[]} preparations
 * @returns {Site[]} */
function cancellationSites(program, owner, preparations) {
	const statements = functionBody(program, owner);
	return preparations.map((preparation) => {
		const index = statements.findIndex(
			(node) =>
				node.type === "VariableDeclaration" &&
				node.declarations.some(
					(declaration) =>
						declaration.id.type === "Identifier" && declaration.id.name === preparation,
				),
		);
		assert.notEqual(index, -1, `Missing preparation ${owner}/${preparation}`);
		const guard = statements[index + 1];
		assert.ok(
			guard?.type === "IfStatement" &&
				guard.test.type === "LogicalExpression" &&
				guard.test.operator === "&&" &&
				memberName(guard.test.left) === "signal" &&
				memberName(guard.test.right) === "signal.aborted" &&
				guard.consequent.type === "BlockStatement" &&
				guard.consequent.body.length === 1 &&
				guard.consequent.body[0]?.type === "ReturnStatement",
			`Missing cancellation guard ${owner}/${preparation}`,
		);
		return {
			start: guard.start,
			end: guard.consequent.start + 1,
			rule: "typescript/no-unnecessary-condition",
			id: "QX-005",
			operation: `${owner}/after-${preparation}/signal.aborted`,
		};
	});
}

/** @param {string} file
 * @param {Program} program
 * @returns {Site[]} */
export function exceptionSites(file, program) {
	switch (file) {
		case `${lib}config.ts`:
			return credentialSites(program);
		case `${lib}process.ts`:
			return cancellationSites(program, "runAgentBrowserProcess", ["prepared", "stockLauncher"]);
		case `${lib}orchestration/browser-run/managed-session-daemon-policy.ts`:
			return cancellationSites(program, "verifyRestoredElectronAttachment", ["connection"]);
		case `${lib}tool-surface.ts`:
			return surfaceSites(program);
		case `${lib}orchestration/extension-tool-boundary.ts`:
			return boundarySites(program);
		case `${lib}web-search.ts`:
			return searchSites(program);
		case `${lib}orchestration/extension-prompt.ts`:
			return promptSites(program);
		default:
			return [];
	}
}
