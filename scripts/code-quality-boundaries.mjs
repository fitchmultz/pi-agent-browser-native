// Exact ownership boundaries, not general-purpose mutable type allowances.
const outputReducers = [
	"confirmation",
	"publication",
	"electron",
	"analysis",
	"receipts",
	"refs",
	"presentation",
	"tabs",
	"navigation",
	"native",
	"lifecycle",
	"managed",
].map((name) => `extensions/agent-browser/lib/orchestration/browser-run/process-output-${name}.ts`);

const outputOperations = [
	...outputReducers,
	...["ownership", "native-phase", "page-phase", "lifecycle-phase", "publication-phase"].map(
		(name) => `extensions/agent-browser/lib/orchestration/browser-run/process-output-${name}.ts`,
	),
	"extensions/agent-browser/lib/orchestration/browser-run/process-output.ts",
];

const runtimeConsumers = [
	"branch-restore",
	"execution-locks",
	"command-run",
	"host-run",
	"code",
	"execution-queue",
	"command-result",
	"host-coordination",
	"tool-boundary",
	"command-admission",
	"lifecycle",
].map((name) => `extensions/agent-browser/lib/orchestration/extension-${name}.ts`);

// The root composition is checked recursively; only its actual lifetime owners qualify.
const runtimeOwners = [
	["extension-prompt.ts", ["BrowserPrompt"], "prompt cache and companion registration"],
	["extension-artifacts.ts", ["BrowserArtifacts"], "artifact publication and manifest"],
	["extension-recording.ts", ["BrowserRecordingRegistry"], "durable recording reservations"],
	["extension-electron-ownership.ts", ["BrowserElectronResources"], "Electron launch cleanup"],
	[
		"extension-runtime.ts",
		[
			"BrowserManagedSessions",
			"BrowserSessionResources",
			"BrowserBranchState",
			"BrowserCodeActivity",
		],
		"managed identities, page resources, branch generations and in-flight code",
	],
].map(([file, names, responsibility]) => ({
	files: runtimeConsumers,
	declaration: `./extensions/agent-browser/lib/orchestration/${file}`,
	names,
	reason: `Readonly root composition retains the canonical owner of ${responsibility}.`,
}));

export const readonlyBoundaries = [
	...runtimeOwners,
	{
		files: [
			...runtimeConsumers,
			"extensions/agent-browser/lib/orchestration/extension-command-output.ts",
		],
		declaration: "./extensions/agent-browser/lib/orchestration/execution-queue.ts",
		names: ["AsyncExecutionQueue"],
		reason: "Execution holds its actual queue owner across cancellation and drain.",
	},
	{
		files: runtimeConsumers,
		declaration: "./extensions/agent-browser/lib/orchestration/execution-queue.ts",
		names: ["KeyedAsyncExecutionQueue"],
		reason:
			"Readonly root composition retains the native identity queue and namespace barrier owner.",
	},
	{
		files: [
			"extensions/agent-browser/lib/orchestration/browser-run/prepare.ts",
			"extensions/agent-browser/lib/orchestration/browser-run/prepare-resources.ts",
			"extensions/agent-browser/lib/orchestration/browser-run/prepare-page-state.ts",
			...outputOperations,
		],
		declaration: "./extensions/agent-browser/lib/orchestration/browser-run/types.ts",
		names: ["BrowserRunState"],
		reason: "Preparation and output operations retain the actual canonical command-state owner.",
	},
	{
		files: [
			"extensions/agent-browser/lib/orchestration/browser-run/prepare-page-state.ts",
			"extensions/agent-browser/lib/orchestration/browser-run/prepare-page-selection.ts",
			"extensions/agent-browser/lib/orchestration/browser-run/prepare-session-plan.ts",
			"extensions/agent-browser/lib/orchestration/browser-run/prepare-guards.ts",
			"extensions/agent-browser/lib/orchestration/browser-run/prepare-observations.ts",
		],
		declaration: "./extensions/agent-browser/lib/session-page-state.ts",
		names: ["SessionPageState"],
		reason: "Preparation commits generation, target and snapshot evidence through its live owner.",
	},
	{
		files: [
			"extensions/agent-browser/lib/orchestration/browser-run/prepare.ts",
			"extensions/agent-browser/lib/orchestration/browser-run/prepare-command.ts",
			...outputOperations,
		],
		declaration: "./extensions/agent-browser/lib/orchestration/browser-run/observation-types.ts",
		names: ["ClickDispatchProbe"],
		reason: "Preparation and output transfer the installed native probe through cleanup.",
	},
	{
		files: ["extensions/agent-browser/lib/browser-journal.ts"],
		declaration: "./extensions/agent-browser/lib/browser-journal-branch.ts",
		names: ["BrowserBranch"],
		reason: "Journal publication advances the owned branch anchor after a verified append.",
	},
	{
		files: [
			"extensions/agent-browser/lib/process.ts",
			"extensions/agent-browser/lib/owned-managed-session-context.ts",
			"extensions/agent-browser/lib/managed-session-restore.ts",
			"extensions/agent-browser/lib/managed-session-restore-policy.ts",
			"extensions/agent-browser/lib/managed-session-restore-context.ts",
			"extensions/agent-browser/lib/orchestration/browser-run/managed-session-close.ts",
			"extensions/agent-browser/lib/orchestration/browser-run/managed-session-daemon-policy.ts",
			"extensions/agent-browser/lib/orchestration/browser-run/index.ts",
			"extensions/agent-browser/lib/orchestration/electron-host/policy.ts",
			"extensions/agent-browser/lib/orchestration/electron-host/index.ts",
			"extensions/agent-browser/lib/orchestration/electron-host/cleanup.ts",
			"extensions/agent-browser/lib/orchestration/electron-host/probe.ts",
			"extensions/agent-browser/lib/orchestration/electron-host/status.ts",
			"test/agent-browser.managed-session-restore.test.ts",
			...[
				"prepare",
				"prepare-daemon",
				"prepare-session-plan",
				"prepare-page-state",
				"prepare-page-selection",
				"prepare-guards",
				"prepare-observations",
				"prepare-command",
			].map((name) => `extensions/agent-browser/lib/orchestration/browser-run/${name}.ts`),
			...outputOperations,
		],
		declaration: "./extensions/agent-browser/lib/managed-session-restore-state.ts",
		names: ["ManagedSessionRestoreState"],
		reason: "Restore policy and Electron launch retain the canonical daemon-provenance controller.",
	},
	{
		files: ["extensions/agent-browser/lib/orchestration/browser-run/final-result-recovery.ts"],
		declaration: "./extensions/agent-browser/lib/session-page-state.ts",
		names: ["SessionPageState"],
		reason: "Final recovery commits ref state through its branch-token-guarded canonical owner.",
	},
	{
		files: ["extensions/agent-browser/lib/orchestration/browser-run/prepare/snapshot-filter.ts"],
		declaration: "./extensions/agent-browser/lib/session-page-state.ts",
		names: ["SessionPageState"],
		reason: "Snapshot preparation commits its result through the canonical branch-guarded owner.",
	},
	{
		files: [
			"extensions/agent-browser/lib/orchestration/browser-run/index.ts",
			"extensions/agent-browser/lib/orchestration/browser-run/native-helper-observation.ts",
		],
		declaration: "./extensions/agent-browser/lib/orchestration/browser-run/types.ts",
		names: ["BrowserRunState"],
		reason: "Execution and native helper observations update the existing command state owner.",
	},
	{
		files: [
			"extensions/agent-browser/lib/orchestration/browser-run/click-dispatch.ts",
			"extensions/agent-browser/lib/orchestration/browser-run/index.ts",
		],
		declaration: "./extensions/agent-browser/lib/orchestration/browser-run/observation-types.ts",
		names: ["ClickDispatchProbe"],
		reason: "Diagnostic collection retires the existing native marker probe after cleanup.",
	},
	{
		files: [
			"extensions/agent-browser/lib/orchestration/extension-command-state.ts",
			"extensions/agent-browser/lib/orchestration/extension-command-run.ts",
			"extensions/agent-browser/lib/orchestration/extension-command-result.ts",
			"extensions/agent-browser/lib/orchestration/extension-result-state.ts",
			"extensions/agent-browser/lib/orchestration/extension-branch-restore.ts",
		],
		declaration: "./extensions/agent-browser/lib/session-page-state.ts",
		names: ["SessionPageState"],
		reason: "Command execution and branch restore retain the actual forked page-state owner.",
	},
	{
		files: [
			"extensions/agent-browser/lib/orchestration/extension-command-run.ts",
			"extensions/agent-browser/lib/orchestration/extension-command-result.ts",
			"extensions/agent-browser/lib/orchestration/extension-command-state.ts",
		],
		declaration: "./extensions/agent-browser/lib/orchestration/browser-run/types.ts",
		names: ["BrowserRunState"],
		reason: "Execution mutates the initialized command state before reconciliation adopts it.",
	},
	{
		files: [
			"extensions/agent-browser/lib/orchestration/electron-host/cleanup.ts",
			"extensions/agent-browser/lib/orchestration/electron-host/index.ts",
		],
		declaration: "./extensions/agent-browser/lib/orchestration/electron-host/contracts.ts",
		names: ["ElectronHostLaunchRecords", "ElectronHostChildProcesses"],
		reason: "Electron cleanup and replay own the launch-record and child-process stores.",
	},
	{
		files: [
			"extensions/agent-browser/lib/orchestration/electron-host/index.ts",
			"extensions/agent-browser/lib/orchestration/electron-host/cleanup.ts",
			"extensions/agent-browser/lib/orchestration/electron-host/probe.ts",
			"extensions/agent-browser/lib/orchestration/electron-host/policy.ts",
			"extensions/agent-browser/lib/orchestration/electron-host/status.ts",
		],
		declaration: "./extensions/agent-browser/lib/session-page-state.ts",
		names: ["SessionPageState"],
		reason: "Electron lifecycle operations retain the canonical session page-state controller.",
	},
	{
		files: ["extensions/agent-browser/lib/orchestration/browser-run/session-state.ts"],
		declaration: "./extensions/agent-browser/lib/orchestration/browser-run/types.ts",
		names: ["BrowserRunState", "BrowserRunStatePatch"],
		reason:
			"The canonical reducer applies a patch and transfers owned resource references without cloning.",
	},
	{
		files: ["extensions/agent-browser/lib/browser-legacy-projection.ts"],
		declaration: "./extensions/agent-browser/lib/browser-legacy-types.ts",
		names: ["LegacyProjectionState"],
		reason: "Legacy conversion creates and owns the per-entry manifest and next-index accumulator.",
	},
	{
		files: [
			"extensions/agent-browser/lib/orchestration/extension-managed-ownership.ts",
			"extensions/agent-browser/lib/orchestration/extension-electron-ownership.ts",
			"extensions/agent-browser/lib/orchestration/extension-script-leases.ts",
		],
		declaration: "./extensions/agent-browser/lib/orchestration/extension-resource-contracts.ts",
		names: ["OwnedManagedSessionStore"],
		reason: "Managed ownership mutators deliberately update the canonical owned-session store.",
	},
	{
		files: [
			...runtimeConsumers,
			"extensions/agent-browser/lib/orchestration/extension-version-check.ts",
		],
		declaration: "./extensions/agent-browser/lib/orchestration/extension-resource-contracts.ts",
		names: ["ValidatedUpstreamPaths"],
		reason: "The version gate owns its set of already-validated upstream paths.",
	},
	{
		files: [
			"extensions/agent-browser/lib/orchestration/extension-managed-ownership.ts",
			"extensions/agent-browser/lib/orchestration/extension-script-leases.ts",
		],
		declaration: "./extensions/agent-browser/lib/managed-session-restore-state.ts",
		names: ["ManagedSessionRestoreState"],
		reason: "Managed close and code cleanup retain the native daemon-provenance controller.",
	},
	{
		files: ["extensions/agent-browser/lib/orchestration/extension-host-run.ts"],
		declaration: "./extensions/agent-browser/lib/session-page-state.ts",
		names: ["SessionPageState"],
		reason: "Host execution holds its forked page-state owner through guarded reconciliation.",
	},
	{
		files: [
			"extensions/agent-browser/lib/config-validation.js",
			"extensions/agent-browser/lib/config-policy.js",
		],
		declaration: "./extensions/agent-browser/lib/config-validation.js",
		names: ["ConfigDiagnostics"],
		reason: "Validator collectors deliberately append diagnostics to caller-owned arrays.",
	},
	{
		files: ["extensions/agent-browser/lib/web-search.ts"],
		declaration: "./extensions/agent-browser/lib/web-search-request.ts",
		names: ["WebSearchRequestGate"],
		reason: "The request lifecycle gate owns cancellation and request sequencing.",
	},
	{
		files: ["extensions/agent-browser/lib/results/next-actions.ts"],
		declaration: "./extensions/agent-browser/lib/results/next-actions.ts",
		names: ["AgentBrowserNextActionAccumulator"],
		reason: "Next-action assembly deliberately appends to the owned output accumulator.",
	},
	{
		files: [
			"test/helpers/read-confirmation-fixture.ts",
			"test/agent-browser.read-confirmation-routing.test.ts",
			"test/agent-browser.read-confirmation-capture-replay.test.ts",
			"test/agent-browser.read-confirmation-capture-actions.test.ts",
		],
		declaration: "./test/helpers/read-confirmation-fixture.ts",
		names: ["ConfirmationFixture"],
		reason: "The confirmation fixture deliberately mutates its shared branch replay state.",
	},
	{
		files: ["test/helpers/agent-browser-harness.ts"],
		declaration: "./test/helpers/agent-browser-harness.ts",
		names: ["ExtensionHarnessOptions", "FixtureBranch"],
		reason: "Harness branch inputs retain shared mutable replay identity.",
	},
	{
		files: [
			"extensions/agent-browser/lib/results/presentation/artifacts.ts",
			"extensions/agent-browser/lib/results/presentation/artifact-images.ts",
			"extensions/agent-browser/lib/results/presentation/early-result.ts",
			"extensions/agent-browser/lib/results/presentation/outcomes.ts",
			"extensions/agent-browser/lib/results/presentation/notices.ts",
			"extensions/agent-browser/lib/results/presentation/output-completion.ts",
			"extensions/agent-browser/lib/results/presentation/large-output.ts",
			...outputOperations,
		],
		declaration: "./extensions/agent-browser/lib/results/contracts.ts",
		names: ["ToolPresentation"],
		reason: "Artifact assembly fills the existing presentation object without changing identity.",
	},
];

export const mutationBoundaries = [
	{
		files: ["extensions/agent-browser/lib/orchestration/browser-run/prepare-page-state.ts"],
		names: ["state"],
		reason: "Confirmed-capture consumption updates only the canonical state owner.",
	},
	{
		files: [
			"extensions/agent-browser/lib/orchestration/browser-run/index.ts",
			"extensions/agent-browser/lib/orchestration/browser-run/click-dispatch.ts",
		],
		names: ["options"],
		reason: "These boundaries mutate only the actual command state or cleanup probe they own.",
	},
	{
		files: ["extensions/agent-browser/lib/orchestration/browser-run/native-helper-observation.ts"],
		names: ["state"],
		reason: "Native helper reconciliation updates the existing command working state.",
	},
	{
		files: ["extensions/agent-browser/lib/browser-journal.ts"],
		names: ["branch"],
		reason: "appendToBranch alone advances the captured publication anchor after native append.",
	},
	{
		files: [
			"extensions/agent-browser/lib/results/presentation/notices.ts",
			"extensions/agent-browser/lib/results/presentation/large-output.ts",
			"extensions/agent-browser/lib/results/presentation/outcomes.ts",
			"extensions/agent-browser/lib/results/presentation/output-completion.ts",
			...outputReducers,
		],
		names: ["draft"],
		reason:
			"Presentation notice and compaction reducers mutate their existing owned assembly draft.",
	},
	{
		files: ["extensions/agent-browser/lib/orchestration/browser-run/session-state.ts"],
		names: ["state"],
		reason: "The canonical browser-run reducer mutates its original owned state.",
	},
	{
		files: ["extensions/agent-browser/lib/browser-legacy-projection.ts"],
		names: ["current"],
		reason: "The converter mutates only its fresh per-entry owned projection state.",
	},
	{
		files: ["scripts/verify-recording-native.mjs"],
		names: ["sm"],
		reason:
			"The deterministic test-only harness fault-injects SessionManager persistence and restores it.",
	},
	{
		files: ["extensions/agent-browser/lib/orchestration/extension-prompt.ts"],
		names: ["event"],
		reason: "Pi's before-agent-start event contract intentionally permits prompt event mutation.",
	},
	{
		files: [
			"extensions/agent-browser/lib/results/presentation/artifacts.ts",
			"extensions/agent-browser/lib/results/presentation/artifact-images.ts",
		],
		names: ["presentation"],
		reason: "Artifact assembly retains the caller's mutable presentation identity.",
	},
];

function readonlyOverrides(config) {
	const declarationsByFile = new Map();
	for (const boundary of readonlyBoundaries) {
		for (const file of boundary.files) {
			const declarations = declarationsByFile.get(file) ?? [];
			declarations.push({ from: "file", path: boundary.declaration, name: boundary.names });
			declarationsByFile.set(file, declarations);
		}
	}
	const groups = new Map();
	const [severity, options] = config.rules["typescript/prefer-readonly-parameter-types"];
	for (const [file, declarations] of declarationsByFile) {
		const key = JSON.stringify(declarations);
		const group = groups.get(key) ?? {
			files: [],
			rules: {
				"typescript/prefer-readonly-parameter-types": [
					severity,
					{ ...options, allow: [...options.allow, ...declarations] },
				],
			},
		};
		group.files.push(file);
		groups.set(key, group);
	}
	return [...groups.values()];
}

function mutationOverrides(config) {
	const namesByFile = new Map();
	for (const boundary of mutationBoundaries) {
		for (const file of boundary.files) {
			const names = namesByFile.get(file) ?? [];
			names.push(...boundary.names);
			namesByFile.set(file, names);
		}
	}
	return [...namesByFile].map(([file, names]) => ({
		files: [file],
		rules: {
			"no-param-reassign": [
				"error",
				{ ...config.rules["no-param-reassign"][1], ignorePropertyModificationsFor: names },
			],
		},
	}));
}

export function boundaryOverrides(config) {
	return [...readonlyOverrides(config), ...mutationOverrides(config)];
}
