import type { SessionTabTarget } from "./session-page-types.js";
import type { SessionArtifactManifest } from "./results/contracts.js";
export interface LegacySnapshot {
	readonly id: string;
	readonly digest: string;
	readonly usable: boolean;
	readonly candidate: boolean;
}
export interface LegacyPage {
	readonly target?: SessionTabTarget | undefined;
	readonly unknown?: true | undefined;
	readonly reopenPending?: boolean | undefined;
	readonly snapshot?: LegacySnapshot | undefined;
	readonly pending?:
		| {
				readonly operationId: string;
				readonly toolCallId: string;
				readonly index: number;
		  }
		| undefined;
}
export interface LegacyProjection {
	readonly pages: ReadonlyMap<string, LegacyPage>;
	readonly manifest?: SessionArtifactManifest | undefined;
	readonly nextIndex: number;
}
/** A conversion owns this cloned projection; its parent and published outputs remain readonly views. */
export interface LegacyProjectionState {
	pages: Map<string, LegacyPage>;
	manifest?: SessionArtifactManifest | undefined;
	nextIndex: number;
}
export interface LegacyContext {
	readonly nativeId: string;
	readonly details: Readonly<Record<string, unknown>>;
	readonly key?: string | undefined;
	readonly namespace?: string | undefined;
	readonly tokens: readonly string[];
	readonly command?: string | undefined;
	readonly subcommand?: string | undefined;
	readonly isError: boolean;
	readonly toolCallId: string;
	readonly prior: LegacyPage;
	readonly begin: boolean;
	readonly phase: "begin" | "finish" | "state";
	readonly commandIndex: number;
	readonly operationId: string;
}
