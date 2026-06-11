import type { PersistentSessionArtifactStore } from "../../temp.js";
import type { BrowserRunContext } from "./types.js";

export function getPersistentSessionArtifactStore(ctx: BrowserRunContext): PersistentSessionArtifactStore | undefined {
	const sessionDir = typeof ctx.sessionManager.getSessionDir === "function" ? ctx.sessionManager.getSessionDir() : undefined;
	const sessionId = ctx.sessionManager.getSessionId();
	return sessionDir && sessionId ? { sessionDir, sessionId } : undefined;
}
