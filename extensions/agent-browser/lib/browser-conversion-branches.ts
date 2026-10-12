import type { LegacyProjection } from "./browser-legacy-types.js";

/** Offline conversion retains a branch projection only until its last source child consumes it. */
export class BrowserConversionBranches {
	private readonly states = new Map<string, LegacyProjection>();
	private readonly children = new Map<string, number>();
	constructor(parentIds: readonly unknown[]) {
		for (const id of parentIds) {
			if (typeof id === "string") {
				this.children.set(id, (this.children.get(id) ?? 0) + 1);
			}
		}
	}
	get(id: string): LegacyProjection | undefined {
		return this.states.get(id);
	}
	advance(id: string, parentId: unknown, projection: LegacyProjection): void {
		if (typeof parentId === "string") {
			const remaining = (this.children.get(parentId) ?? 0) - 1;
			if (remaining > 0) {
				this.children.set(parentId, remaining);
			} else {
				this.children.delete(parentId);
				this.states.delete(parentId);
			}
		}
		if (this.children.has(id)) {
			this.states.set(id, projection);
		}
	}
}
