import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ElectronLaunchRecord } from "../../electron/launch.js";
import type { AgentBrowserLifecycle, AgentBrowserWindow } from "../../results/contracts.js";
import type { ToolPresentationObservation } from "../../results/presentation/observation-contracts.js";
import type { FinalResultInput } from "./types.js";

// Publication borrows completed analysis. Only its newly assembled result is owned here.
export type PublicationInput = Omit<
	FinalResultInput,
	"presentation" | "categoryDetails" | "processResult" | "electronLaunchRecords" | "redactedContent"
> &
	Readonly<{
		presentation: ToolPresentationObservation;
		categoryDetails: Readonly<FinalResultInput["categoryDetails"]>;
		processResult: Readonly<FinalResultInput["processResult"]>;
		electronLaunchRecords: ReadonlyMap<string, ElectronLaunchRecord>;
		redactedContent: PublicationContent;
	}>;

export type PublicationContent = ReadonlyArray<
	Readonly<AgentToolResult<unknown>["content"][number]>
>;
export type PublicationToolResult = AgentToolResult<unknown>;
export type PublicationLifecycle = Readonly<{
	effectiveLaunch: Readonly<AgentBrowserLifecycle["effectiveLaunch"]>;
}>;
export type PublicationWindow = Readonly<AgentBrowserWindow>;
