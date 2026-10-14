import { BROWSER_STATE_FIELDS } from "./browser-transcript-contracts.js";

const DETAILS_FIELDS = [
	...BROWSER_STATE_FIELDS,
	"browserEventVersion",
	"electron",
	"compiledNetworkSourceLookup",
	"sessionTabTarget",
	"sessionTabTargetUnknown",
	"sessionTabReopenPending",
	"sessionConfirmActions",
	"refSnapshot",
	"refSnapshotInvalidation",
	"artifactManifest",
	"error",
	"summary",
];
const CONFIRMED_CLOSE_FIELDS = [
	["confirmed"],
	["action"],
	["result", "success"],
	["result", "data", "closed"],
];

/** Shared read-only projection for runtime replay and optional separate-copy conversion. */
export const LEGACY_BROWSER_FIELDS = [
	["data", "event"],
	["data", "snapshot"],
	["data", "cleanup"],
	["data", "sessionName"],
	["data", "ownerSessionId"],
	["data", "closeCommandArgs"],
	["data", "launchAttempted"],
	["data", "toolCallId"],
	["data", "isError"],
	["message", "toolName"],
	["message", "toolCallId"],
	["message", "isError"],
	...["data", "message"].flatMap((root) => DETAILS_FIELDS.map((field) => [root, "details", field])),
	...["data", "message"].flatMap((root) =>
		CONFIRMED_CLOSE_FIELDS.flatMap((field) => [
			[root, "details", "data", ...field],
			[root, "details", "batchSteps", "*", "data", ...field],
		]),
	),
	...["data", "message"].flatMap((root) =>
		["command", "success", "lifecycle"]
			.map((field) => [root, "details", "batchSteps", "*", field])
			.concat(
				[
					["data", "lifecycle"],
					["result", "lifecycle"],
				].map((field) => [root, "details", "batchSteps", "*"].concat(field)),
			),
	),
	...["data", "message"].flatMap((root) =>
		["command", "success", "error"]
			.map((field) => [root, "details", "data", "*", field])
			.concat(
				["url", "title", "origin", "targetId"].map((field) => [
					root,
					"details",
					"data",
					"*",
					"result",
					field,
				]),
			),
	),
];
