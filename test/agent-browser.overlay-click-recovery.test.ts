import assert from "node:assert/strict";
import nodeTest from "node:test";

import { compileAgentBrowserSemanticAction } from "../extensions/agent-browser/lib/input-modes/semantic-action.js";
import { getAgentBrowserErrorText } from "../extensions/agent-browser/lib/results/envelope.js";
import { buildToolPresentation } from "../extensions/agent-browser/lib/results/presentation.js";
import { parseCommandInfo } from "../extensions/agent-browser/lib/runtime.js";

// Upstream 0.36.0 reports this before dispatch; hover uses the same geometry check.
const coveredClick =
	"Element '#target' is covered by <div#cover> at its click point, so the input would land on that element instead.";
const clickCommands = [
	["click", "#target"],
	["find", "text", "Target", "click"],
	["find", "text", "Target"],
	["find", "role", "button", "click", "--name", "Target"],
	["find", "role", "button"],
	["find", "first", "button", "click"],
	["find", "last", "button"],
	["find", "nth", "0", "button", "click"],
	["find", "nth", "0", "button"],
	["--namespace", "", "--session", "work", "find", "nth", "0", "button", "--json"],
];

nodeTest(
	"covered-click inspection follows the actual direct, semantic, and raw find action",
	async (t) => {
		const { compiled } = compileAgentBrowserSemanticAction({
			action: "click",
			locator: "text",
			value: "Target",
		});
		assert.ok(compiled);
		const errorText = getAgentBrowserErrorText({
			aborted: false,
			envelope: { error: { message: coveredClick }, success: false },
			exitCode: 1,
			plainTextInspection: false,
			stderr: "",
		});
		assert.equal(errorText, coveredClick);
		for (const args of clickCommands) {
			for (const input of [{ errorText }, { envelope: { data: coveredClick, success: false } }]) {
				await t.test(
					`${args.join(" ")}: ${"errorText" in input ? "error text" : "data envelope"}`,
					async () => {
						const presentation = await buildToolPresentation({
							args,
							commandInfo: parseCommandInfo(args),
							cwd: process.cwd(),
							sessionName: "work",
							...input,
						});
						assert.equal(presentation.resultCategory, "failure");
						assert.ok(
							presentation.content.some(
								(content) => content.type === "text" && content.text.includes(coveredClick),
							),
						);
						assert.equal(presentation.failureCategory, "upstream-error");
						assert.deepEqual(
							presentation.nextActions?.map(({ id, params }) => ({ id, params })),
							[
								{
									id: "inspect-overlay-state",
									params: { args: ["--session", "work", "snapshot", "-i"] },
								},
							],
							args.join(" "),
						);
					},
				);
			}
		}
		const semantic = await buildToolPresentation({
			commandInfo: { command: "find", subcommand: "text" },
			compiledSemanticAction: compiled,
			cwd: process.cwd(),
			errorText,
			sessionName: "work",
		});
		assert.equal(semantic.resultCategory, "failure");
		assert.equal(semantic.failureCategory, "upstream-error");
		assert.deepEqual(
			semantic.nextActions?.map(({ id, params }) => ({ id, params })),
			[
				{
					id: "inspect-overlay-state",
					params: { args: ["--session", "work", "snapshot", "-i"] },
				},
			],
		);
	},
);

nodeTest(
	"covered-click data error envelopes reach presentation without losing the upstream error",
	async (t) => {
		for (const data of [coveredClick, { error: { message: coveredClick } }]) {
			await t.test(typeof data, () => {
				assert.equal(
					getAgentBrowserErrorText({
						aborted: false,
						envelope: { data, success: false },
						exitCode: 1,
						plainTextInspection: false,
						stderr: "",
					}),
					coveredClick,
				);
				assert.equal(
					getAgentBrowserErrorText({
						aborted: false,
						envelope: { data, error: "Click failed.", success: false },
						exitCode: 1,
						plainTextInspection: false,
						stderr: "",
					}),
					"Click failed.",
				);
			});
		}
	},
);

nodeTest("failed batch rows preserve exact namespace/session on overlay inspection", async (t) => {
	for (const namespace of ["tenant", ""]) {
		await t.test(`namespace ${JSON.stringify(namespace)}`, async (variant) => {
			const envelope = {
				success: false,
				error: null,
				data: clickCommands.map((command) => ({
					command,
					error: { message: coveredClick },
					success: false,
				})),
			};
			const errorText = getAgentBrowserErrorText({
				aborted: false,
				envelope,
				exitCode: 1,
				plainTextInspection: false,
				stderr: "",
			});
			assert.equal(errorText, undefined, "an empty outer error must not hide failed batch rows");
			const presentation = await buildToolPresentation({
				commandInfo: { command: "batch" },
				cwd: process.cwd(),
				namespace,
				sessionName: "work",
				envelope,
				errorText,
			});
			for (const [index, row] of [presentation, ...(presentation.batchSteps ?? [])].entries()) {
				await variant.test(`result ${index}`, () => {
					assert.equal(row.failureCategory, "upstream-error");
					assert.deepEqual(
						row.nextActions?.map(({ id, params }) => ({ id, params })),
						[
							{
								id: "inspect-overlay-state",
								params: { args: ["--namespace", namespace, "--session", "work", "snapshot", "-i"] },
							},
						],
					);
				});
			}
		});
	}
});

nodeTest("generic errors and non-click actions do not get overlay click recovery", async (t) => {
	for (const [args, errorText] of [
		[["click", "#target"], "Element '#target' is covered by a sticky header."],
		[["click", "#target"], "The target moved at its click point."],
		[["click", "#target"], "Click failed."],
		[["hover", "#target"], coveredClick],
		[["find", "text", "click", "hover"], coveredClick],
		[["find", "nth", "0", "button", "hover"], coveredClick],
		[["find", "text", "Target", "fill", "click"], coveredClick],
		[["find", "role", "button", "--name", "click"], coveredClick],
	] as const) {
		await t.test(`${args.join(" ")}: ${errorText}`, async () => {
			const presentation = await buildToolPresentation({
				args: [...args],
				commandInfo: parseCommandInfo([...args]),
				cwd: process.cwd(),
				errorText,
			});
			assert.equal(presentation.failureCategory, "upstream-error");
			assert.equal(presentation.nextActions, undefined, args.join(" "));
		});
	}
});
