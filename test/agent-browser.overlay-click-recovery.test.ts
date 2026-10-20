import assert from "node:assert/strict";
import test from "node:test";

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

test("covered-click inspection follows the actual direct, semantic, and raw find action", async () => {
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
			// Evaluate and assert each recovery variant before the next case.
			// oxlint-disable-next-line no-await-in-loop
			const presentation = await buildToolPresentation({
				args,
				commandInfo: parseCommandInfo(args),
				cwd: process.cwd(),
				sessionName: "work",
				...input,
			});
			// Each fixed click/envelope variant must preserve the original failed result.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(presentation.resultCategory, "failure");
			// Each fixed click/envelope variant must leave the native failure visible.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.ok(
				presentation.content.some(
					(content) => content.type === "text" && content.text.includes(coveredClick),
				),
			);
			// Each fixed click/envelope variant must retain the same failure classification.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(presentation.failureCategory, "upstream-error");
			// Every click/envelope fixture must expose the complete executable recovery.
			// oxlint-disable-next-line node-test/no-conditional-assertion
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
});

test("covered-click data error envelopes reach presentation without losing the upstream error", () => {
	for (const data of [coveredClick, { error: { message: coveredClick } }]) {
		// Both fixed data-error envelopes must retain the native error text.
		// oxlint-disable-next-line node-test/no-conditional-assertion
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
		// Both fixed data-error envelopes must retain the native error text.
		// oxlint-disable-next-line node-test/no-conditional-assertion
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
	}
});

test("failed batch rows preserve exact namespace/session on overlay inspection", async () => {
	for (const namespace of ["tenant", ""]) {
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
		// Each fixed namespace variant must defer failure evidence to the batch rows.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(errorText, undefined, "an empty outer error must not hide failed batch rows");
		// Evaluate and assert each recovery variant before the next case.
		// oxlint-disable-next-line no-await-in-loop
		const presentation = await buildToolPresentation({
			commandInfo: { command: "batch" },
			cwd: process.cwd(),
			namespace,
			sessionName: "work",
			envelope,
			errorText,
		});
		for (const row of [presentation, ...(presentation.batchSteps ?? [])]) {
			// The outer result and every emitted batch row must retain the failure category.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(row.failureCategory, "upstream-error");
			// The outer result and every emitted batch row must retain namespace-scoped recovery.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.deepEqual(
				row.nextActions?.map(({ id, params }) => ({ id, params })),
				[
					{
						id: "inspect-overlay-state",
						params: { args: ["--namespace", namespace, "--session", "work", "snapshot", "-i"] },
					},
				],
			);
		}
	}
});

test("generic errors and non-click actions do not get overlay click recovery", async () => {
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
		// Evaluate and assert each recovery variant before the next case.
		// oxlint-disable-next-line no-await-in-loop
		const presentation = await buildToolPresentation({
			args: [...args],
			commandInfo: parseCommandInfo([...args]),
			cwd: process.cwd(),
			errorText,
		});
		// Every fixed non-click command must retain its ordinary upstream failure category.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(presentation.failureCategory, "upstream-error");
		// Every non-click fixture must avoid inventing click-specific recovery.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(presentation.nextActions, undefined, args.join(" "));
	}
});
