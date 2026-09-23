/**
 * HTTP + WebSocket server for the Chrome relay sidecar.
 *
 * Node port of oh-my-pi's browser relay (Bun.serve original, MIT — see
 * ./VENDOR.md): impersonates Chrome's CDP discovery endpoint so any CDP
 * client can `connect` with a plain ws URL while the user's real, headed
 * Chrome drives the tabs through the bundled MV3 extension:
 * - `GET /json/version` → 200 with `webSocketDebuggerUrl` once the extension
 *   is connected, 503 with a {@link RelayUnavailableInfo} body before that.
 * - `GET /json` / `/json/list` → attachable page targets (debugging aid).
 * - `WS /cdp` → downstream CDP clients; any `Origin` is rejected so a web
 *   page can't drive the relay.
 * - `WS /ext` → the Chrome extension (token-gated when configured).
 *
 * Binds loopback only: anything that can reach this port can drive the
 * user's logged-in browser.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { RelayBridge } from "./bridge.js";

/** Options for {@link startRelayServer}. */
export interface RelayServerOptions {
	port: number;
	/** Shared secret the extension must present as `?token=`; unset disables the check. */
	token?: string;
	/** Group tabs the agent actively drives under one per-window Chrome tab group (default on); `false` disables. */
	group?: boolean | { title: string; color: string };
	log?: (message: string, data?: Record<string, unknown>) => void;
}

/** Body of the 503 `/json/version` answer while no extension is connected. */
export interface RelayUnavailableInfo {
	error: string;
	/** An extension completed the hello handshake at least once in this server's lifetime. */
	extensionSeen: boolean;
	/** Milliseconds this server has been listening. */
	uptimeMs: number;
}

/** A running relay server. */
export interface RelayServer {
	bridge: RelayBridge;
	/** Bound port (useful when started with `port: 0`); the configured port until listening. */
	readonly port: number;
	/** Resolves once the socket is listening; rejects if the bind fails (e.g. port taken). */
	readonly ready: Promise<void>;
	/** The listening address, or null before listening / after stop. */
	address(): { address: string; port: number } | null;
	stop(): void;
}

interface SocketData {
	role: "cdp" | "ext";
	connId?: number;
}

const WS_KEEPALIVE_MS = 30_000;
/** Screenshots travel base64-encoded through both websocket legs. */
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
/** Default appearance of the agent tab group. */
const DEFAULT_GROUP = { title: "agent", color: "cyan" } as const;

/** True when `raw` can serve as the authority of a `ws://` URL: no whitespace,
 *  slashes, userinfo, fragments, or control characters, and URL-parseable. */
function isWsAuthority(raw: string): boolean {
	if (/[\s/\\@#?]|[\x00-\x1f]/.test(raw)) return false;
	try {
		return new URL(`ws://${raw}`).host.length > 0;
	} catch {
		return false;
	}
}

/** Plain HTTP rejection for an upgrade we refuse; ws clients surface the status. */
function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
	socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

function textResponse(res: ServerResponse, status: number, body: string): void {
	res.writeHead(status, { "content-type": "text/plain" });
	res.end(body);
}

/** Start the relay server on 127.0.0.1. `ready` rejects if the port is taken. */
export function startRelayServer(opts: RelayServerOptions): RelayServer {
	const log = opts.log ?? (() => {});
	const group =
		opts.group === false ? null : opts.group === true || opts.group === undefined ? DEFAULT_GROUP : opts.group;
	const bridge = new RelayBridge({ log, group });
	const sockets = new Map<WebSocket, SocketData>();
	const startedAt = Date.now();

	const server: Server = createServer((req, res) => {
		const rawHost = req.headers.host?.trim();
		const host = rawHost && isWsAuthority(rawHost) ? rawHost : `127.0.0.1:${opts.port}`;
		const url = new URL(req.url ?? "/", `http://${host}`);
		const path = url.pathname.replace(/\/+$/, "") || "/";

		// Upgrade requests never reach here (the "upgrade" event claims them);
		// plain GETs on the websocket paths get Chrome-style rejections.
		if (path === "/cdp") {
			if (req.headers.origin) return textResponse(res, 403, "Forbidden");
			return textResponse(res, 426, "websocket upgrade required");
		}
		if (path === "/ext") {
			const origin = req.headers.origin;
			if (origin && !origin.startsWith("chrome-extension://")) return textResponse(res, 403, "Forbidden");
			if (opts.token && url.searchParams.get("token") !== opts.token) {
				return textResponse(res, 401, "Unauthorized");
			}
			return textResponse(res, 426, "websocket upgrade required");
		}
		if (req.method !== "GET") return textResponse(res, 405, "Method not allowed");
		if (path === "/json/version") {
			if (!bridge.ready) {
				const info: RelayUnavailableInfo = {
					error: "relay extension is not connected",
					extensionSeen: bridge.extensionSeen,
					uptimeMs: Date.now() - startedAt,
				};
				return jsonResponse(res, 503, info);
			}
			return jsonResponse(res, 200, bridge.versionInfo(`ws://${host}/cdp`));
		}
		if (path === "/json" || path === "/json/list") {
			return jsonResponse(res, 200, bridge.listTargets());
		}
		return textResponse(res, 404, "Not found");
	});

	function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
		const path = url.pathname.replace(/\/+$/, "") || "/";
		let role: SocketData["role"];
		if (path === "/cdp") {
			// Browsers set Origin on websocket upgrades; native CDP clients
			// don't. Reject any Origin so a web page can't drive the relay.
			if (req.headers.origin) return rejectUpgrade(socket, 403, "Forbidden");
			role = "cdp";
		} else if (path === "/ext") {
			const origin = req.headers.origin;
			if (origin && !origin.startsWith("chrome-extension://")) return rejectUpgrade(socket, 403, "Forbidden");
			if (opts.token && url.searchParams.get("token") !== opts.token) {
				return rejectUpgrade(socket, 401, "Unauthorized");
			}
			role = "ext";
		} else {
			socket.destroy();
			return;
		}

		wss.handleUpgrade(req, socket, head, ws => {
			const data: SocketData = { role };
			sockets.set(ws, data);
			ws.on("message", raw => {
				const text = String(raw);
				if (data.role === "ext") bridge.extMessage(ws, text);
				else if (data.connId !== undefined) bridge.cdpMessage(data.connId, text);
			});
			ws.on("close", () => {
				sockets.delete(ws);
				if (data.role === "ext") bridge.extClosed(ws);
				else if (data.connId !== undefined) bridge.cdpClosed(data.connId);
			});
			ws.on("error", () => {
				// "close" always follows; nothing to do but avoid an unhandled event.
			});
			if (role === "ext") bridge.extConnected(ws);
			else data.connId = bridge.cdpConnected(ws);
		});
	}

	const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
	server.on("upgrade", handleUpgrade);

	const ready = new Promise<void>((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(opts.port, "127.0.0.1");

	// Puppeteer connections go silent while the agent is idle; protocol-level
	// pings keep intermediaries and dead peers from strangling the socket.
	const keepalive = setInterval(() => {
		for (const ws of sockets.keys()) ws.ping();
	}, WS_KEEPALIVE_MS);
	keepalive.unref();

	log("relay listening", { port: opts.port });
	return {
		bridge,
		get port(): number {
			const addr = server.address();
			return typeof addr === "object" && addr !== null ? addr.port : opts.port;
		},
		ready,
		address() {
			const addr = server.address();
			return typeof addr === "object" && addr !== null ? { address: addr.address, port: addr.port } : null;
		},
		stop() {
			clearInterval(keepalive);
			for (const ws of sockets.keys()) ws.terminate();
			sockets.clear();
			if (server.listening) server.close();
		},
	};
}
