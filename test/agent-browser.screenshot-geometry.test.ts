import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ImageObservation } from "../extensions/agent-browser/lib/results/contracts.js";
import { createExtensionHarness, executeRegisteredTool, runExtensionEvent, withPatchedEnv } from "./helpers/agent-browser-harness.js";

// Based on recon geometry-probe.mjs: CSS1200x800/DPR2, target box(100,160,100,60).
test("native screenshots expose DPR, viewport/full/element crop and honest unknowns", { skip: process.env.PI_AGENT_BROWSER_REAL_UPSTREAM !== "1", timeout: 90_000 }, async t => {
	const dir = await mkdtemp(join(tmpdir(), "piab-geometry-"));
	const sockets = join(dir, "s");
	await mkdir(sockets, { mode: 0o700 });
	const server = createServer((_req, res) => {
		res.setHeader("content-type", "text/html");
		res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Geometry Fixture</title><style>html{scrollbar-width:none}body{margin:0;min-height:1600px}button{position:absolute;left:100px;top:160px;width:100px;height:60px;box-sizing:border-box}iframe{position:absolute;left:600px;top:20px;width:300px;height:200px}</style><button id="target">Target</button><script>window.hits=0;document.querySelector('button').onclick=()=>window.hits++;</script>`);
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const session = `geometry-${process.pid}`;
	try {
		await withPatchedEnv({ HOME: dir, USERPROFILE: dir, PI_CODING_AGENT_DIR: join(dir, "pi"), PI_AGENT_BROWSER_CONFIG: undefined, PI_AGENT_BROWSER_SOCKET_DIR: sockets, AGENT_BROWSER_SOCKET_DIR: sockets, AGENT_BROWSER_CONFIG: undefined, AGENT_BROWSER_NAMESPACE: undefined, AGENT_BROWSER_PROFILE: undefined, AGENT_BROWSER_RESTORE: undefined, AGENT_BROWSER_CDP: undefined, AGENT_BROWSER_AUTO_CONNECT: undefined }, async () => {
			const h = createExtensionHarness({ cwd: dir });
			await runExtensionEvent(h.handlers, "session_start", { reason: "new" }, h.ctx);
			const call = async (args: string[], stdin?: string) => {
				const result = await executeRegisteredTool(h.tool, h.ctx, { args: ["--session", session, ...args], stdin });
				assert.equal(result.isError, false, `${args.join(" ")}: ${result.content[0]?.text}`);
				return result;
			};
			const image = (result: Awaited<ReturnType<typeof call>>) => {
				assert.equal(result.content.filter(part => part.type === "image").length, 1);
				const observed = (result.details?.imageObservations as ImageObservation[])[0];
				assert.ok(observed);
				return observed;
			};
			try {
				await call(["open", `http://127.0.0.1:${address.port}/`]);
				await call(["set", "viewport", "1200", "800", "2"]);
				const viewportResult = await call(["--json", "screenshot", join(dir, "viewport.png")]);
				const viewport = image(viewportResult);
				assert.deepEqual(viewport.pixels, { width: 2400, height: 1600 });
				assert.equal(viewport.geometry.status, "measured", JSON.stringify(viewport));
				assert.deepEqual(viewport.geometry.pixelsPerCssPixel, { x: 2, y: 2 });
				assert.deepEqual(JSON.parse(viewportResult.content[0].text!).imageObservations, viewportResult.details?.imageObservations);
				const element = image(await call(["screenshot", "#target", join(dir, "element.png")]));
				assert.deepEqual(element.pixels, { width: 200, height: 120 });
				assert.deepEqual(element.geometry.crop, { x: 100, y: 160, width: 100, height: 60 });
				const full = image(await call(["screenshot", join(dir, "full.png"), "--full"]));
				assert.deepEqual(full.pixels, { width: 2400, height: 3200 });
				assert.deepEqual(full.geometry.crop, { x: 0, y: 0, width: 1200, height: 1600 });
				await call(["batch", "--bail"], JSON.stringify([["mouse", "move", "150", "190"], ["mouse", "down"], ["mouse", "up"], ["mouse", "move", "300", "380"], ["mouse", "down"], ["mouse", "up"]]));
				const hitCount = (await call(["eval", "window.hits"])).details?.data as { result: number };
				assert.equal(hitCount.result, 1, "only the CSS-coordinate mouse input hits");
				await call(["eval", "scrollTo(0,100)"]);
				const scrolled = image(await call(["screenshot", join(dir, "scrolled.png")]));
				assert.equal(scrolled.geometry.crop?.y, 100);
				const crop = image(await call(["screenshot", "#target", join(dir, "scrolled-element.png")]));
				assert.equal(crop.geometry.status, "unknown");
				assert.equal(crop.geometry.crop, undefined);
				const batch = image(await call(["batch", "--bail"], JSON.stringify([["screenshot", join(dir, "batch.png")]])));
				assert.equal(batch.geometry.status, "unknown", "batch-final browser geometry is not per-image evidence");
				await call(["eval", "document.body.insertAdjacentHTML('beforeend', '<iframe id=child srcdoc=\"<button>Frame target</button>\"></iframe>')"]);
				await call(["frame", "#child"]);
				const framed = image(await call(["screenshot", join(dir, "frame.png")]));
				assert.equal(framed.geometry.before?.frame, "main", "native viewport screenshot and eval use the main frame even after frame selection");
				assert.equal(framed.geometry.before?.childFrameCount, 1);
				await call(["frame", "main"]);
				const ambiguousElement = image(await call(["screenshot", "#target", join(dir, "frame-element.png")]));
				assert.equal(ambiguousElement.geometry.status, "unknown");
				await call(["open", "about:blank"]);
				await call(["screenshot", "--if-changed", join(dir, "first.png")]);
				const unchanged = await call(["screenshot", "--threshold", "0", join(dir, "absent.png")]);
				assert.equal((unchanged.details?.data as { changed: boolean }).changed, false, JSON.stringify(unchanged.details?.data));
				assert.equal(unchanged.content.some(part => part.type === "image"), false);
				assert.equal(unchanged.details?.imageObservations, undefined);
				const failure = await executeRegisteredTool(h.tool, h.ctx, { args: ["--session", session, "--json", "click", "#missing"], timeoutMs: 3000 });
				assert.equal(failure.isError, true);
				const payload = JSON.parse(failure.content[0].text!);
				assert.equal(payload.success, false);
				assert.equal(payload.failureCategory, failure.details?.failureCategory);
				assert.ok(payload.nextActions?.length, "native JSON failure retains actionable recovery");
				t.diagnostic(JSON.stringify({ viewport: viewport.pixels, element: element.pixels, full: full.pixels, cssHits: 1, scrolledElement: crop.geometry.status, frame: framed.geometry.status, jsonFailure: payload.failureCategory }));
			} finally { await call(["close"]); }
		});
	} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
