import { readArray, readRecord, readString } from "./helpers/assertions.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createExtensionHarness,
	executeRegisteredTool,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

interface ScreenshotResult {
	readonly details?: Readonly<Record<string, unknown>>;
	readonly content: readonly { readonly type: string }[];
}

test("Lightpanda captures stay attached as text-rendered images without coordinate claims across direct, batch and code output", async () => {
	const dir = await mkdtemp(join(tmpdir(), "piab-text-image-"));
	const path = join(dir, "image.png");
	const imageBytes = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
		"base64",
	);
	await writeFakeAgentBrowserBinary(
		dir,
		`
const fs = require("node:fs");
const args = process.argv.slice(2);
const engine = process.env.PIAB_FIXTURE_ENGINE ?? 'lightpanda';
const lifecycle = { effectiveLaunch: { browserLaunched: true, ...(engine === 'absent' ? {} : {engine}) } };
const sample = { ...(process.env.PIAB_FIXTURE_RENDERING === 'text' ? {rendering:'text'} : {}), url:'https://fixture.test/', frame:'main', childFrameCount:0, viewport:{width:1,height:1}, document:{width:1,height:1}, scroll:{x:0,y:0}, dpr:1, visualViewport:{x:0,y:0,scale:1} };
const capture = {path:${JSON.stringify(path)},lifecycle};
if (args.includes('screenshot') || args.includes('batch')) {
  fs.writeFileSync(${JSON.stringify(path)}, Buffer.from(${JSON.stringify(imageBytes.toString("base64"))}, 'base64'));
}
const data = args.includes('batch') ? [{command:['screenshot',${JSON.stringify(path)}],success:true,result:capture}]
  : args.includes('screenshot') ? capture : args.includes('eval') ? {result:sample}
  : {url:'https://fixture.test/',title:'Fixture',lifecycle};
console.log(JSON.stringify({success:true,data}));`,
	);
	try {
		await withPatchedEnv(
			{ PATH: `${dir}:${process.env.PATH ?? ""}`, PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0" },
			async () => {
				const h = createExtensionHarness({ cwd: dir });
				const call = async (args: readonly string[], extra = {}) => {
					const result = await executeRegisteredTool(h.tool, h.ctx, { args, ...extra });
					assert.equal(result.isError, false, result.content[0].text);
					return result;
				};
				const checkImage = (result: ScreenshotResult) => {
					const observed = readArray(result.details?.imageObservations).map((value) =>
						readRecord(value),
					)[0];
					assert.equal(observed.rendering, "text");
					assert.equal(readRecord(observed.geometry).status, "unknown");
					assert.match(
						readString(readRecord(observed.geometry).reason),
						/Lightpanda.*text-rendered/i,
					);
					assert.equal(readRecord(observed.geometry).crop, undefined);
					assert.equal(readRecord(observed.geometry).pixelsPerCssPixel, undefined);
					const image = result.content.find((part) => part.type === "image");
					assert.ok(image);
					assert.deepEqual(Buffer.from(readString(readRecord(image).data), "base64"), imageBytes);
				};
				try {
					await call(["--engine", "lightpanda", "open", "https://fixture.test/"], {
						sessionMode: "fresh",
					});
					const direct = await call(["--json", "screenshot", path]);
					const directDetails = readRecord(direct.details);
					checkImage(direct);
					assert.deepEqual(
						readRecord(JSON.parse(readString(direct.content[0].text))).imageObservations,
						directDetails.imageObservations,
					);
					const batch = await call(["batch", "--bail"], {
						stdin: JSON.stringify([["screenshot", path]]),
					});
					checkImage(batch);
					assert.match(readString(batch.content[0].text), /Lightpanda.*text-rendered/i);
					const code = await executeRegisteredTool(
						// Missing code-tool registration fails immediately; no passing path skips the code assertions.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						h.getTool("agent_browser_code") ?? assert.fail("code tool must be registered"),
						h.ctx,
						{
							code: `const r = await browser({args:["screenshot",${JSON.stringify(path)}]}); emitImage(r.imageObservations[0]);`,
						},
					);
					assert.equal(code.isError, false, code.content[0].text);
					checkImage(code);
					for (const engine of ["chrome", "absent"]) {
						// Engine variants share the browser and screenshot path; capture before changing its environment.
						// oxlint-disable-next-line no-await-in-loop
						await withPatchedEnv(
							{ PIAB_FIXTURE_ENGINE: engine, PIAB_FIXTURE_RENDERING: "text" },
							async () => {
								checkImage(await call(["screenshot", path]));
							},
						);
					}
					assert.deepEqual(await readFile(path), imageBytes);
				} finally {
					await call(["close"]);
				}
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// Based on recon geometry-probe.mjs: CSS1200x800/DPR2, target box(100,160,100,60).
test(
	"native screenshots expose DPR, viewport/full/element crop and honest unknowns",
	{ skip: process.env.PI_AGENT_BROWSER_REAL_UPSTREAM !== "1", timeout: 90_000 },
	async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "piab-geometry-"));
		const sockets = join(dir, "s");
		await mkdir(sockets, { mode: 0o700 });
		const server = createServer((_req, res) => {
			res.setHeader("content-type", "text/html");
			res.end(
				`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Geometry Fixture</title><style>html{scrollbar-width:none}body{margin:0;min-height:1600px}button{position:absolute;left:100px;top:160px;width:100px;height:60px;box-sizing:border-box}iframe{position:absolute;left:600px;top:20px;width:300px;height:200px}</style><button id="target">Target</button><script>window.hits=0;document.querySelector('button').onclick=()=>window.hits++;</script>`,
			);
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		assert.ok(address !== null && typeof address !== "string");
		const session = `geometry-${process.pid}`;
		try {
			await withPatchedEnv(
				{
					HOME: dir,
					USERPROFILE: dir,
					PI_CODING_AGENT_DIR: join(dir, "pi"),
					PI_AGENT_BROWSER_CONFIG: undefined,
					PI_AGENT_BROWSER_SOCKET_DIR: sockets,
					AGENT_BROWSER_SOCKET_DIR: sockets,
					AGENT_BROWSER_CONFIG: undefined,
					AGENT_BROWSER_NAMESPACE: undefined,
					AGENT_BROWSER_PROFILE: undefined,
					AGENT_BROWSER_RESTORE: undefined,
					AGENT_BROWSER_CDP: undefined,
					AGENT_BROWSER_AUTO_CONNECT: undefined,
				},
				async () => {
					const h = createExtensionHarness({ cwd: dir });
					await runExtensionEvent(h.handlers, "session_start", { reason: "new" }, h.ctx);
					const call = async (args: readonly string[], stdin?: string) => {
						const result = await executeRegisteredTool(h.tool, h.ctx, {
							args: ["--session", session, ...args],
							stdin,
						});
						assert.equal(
							result.isError,
							false,
							`${args.join(" ")}: ${readString(result.content[0].text)}`,
						);
						return result;
					};
					const image = (result: ScreenshotResult) => {
						assert.equal(result.content.filter((part) => part.type === "image").length, 1);
						const observed = readArray(result.details?.imageObservations).map((value) =>
							readRecord(value),
						)[0];
						assert.notEqual(observed, undefined);
						return observed;
					};
					try {
						await call(["open", `http://127.0.0.1:${address.port}/`]);
						await call(["set", "viewport", "1200", "800", "2"]);
						const viewportResult = await call(["--json", "screenshot", join(dir, "viewport.png")]);
						const viewportResultDetails = readRecord(viewportResult.details);
						const viewport = image(viewportResult);
						assert.deepEqual(viewport.pixels, { width: 2400, height: 1600 });
						assert.equal(
							readRecord(viewport.geometry).status,
							"measured",
							JSON.stringify(viewport),
						);
						assert.deepEqual(readRecord(viewport.geometry).pixelsPerCssPixel, { x: 2, y: 2 });
						assert.deepEqual(
							readRecord(JSON.parse(readString(viewportResult.content[0].text))).imageObservations,
							viewportResultDetails.imageObservations,
						);
						const element = image(await call(["screenshot", "#target", join(dir, "element.png")]));
						assert.deepEqual(element.pixels, { width: 200, height: 120 });
						assert.deepEqual(readRecord(element.geometry).crop, {
							x: 100,
							y: 160,
							width: 100,
							height: 60,
						});
						const full = image(await call(["screenshot", join(dir, "full.png"), "--full"]));
						assert.deepEqual(full.pixels, { width: 2400, height: 3200 });
						assert.deepEqual(readRecord(full.geometry).crop, {
							x: 0,
							y: 0,
							width: 1200,
							height: 1600,
						});
						await call(
							["batch", "--bail"],
							JSON.stringify([
								["mouse", "move", "150", "190"],
								["mouse", "down"],
								["mouse", "up"],
								["mouse", "move", "300", "380"],
								["mouse", "down"],
								["mouse", "up"],
							]),
						);
						const hitCount = readRecord((await call(["eval", "window.hits"])).details?.data);
						assert.equal(hitCount.result, 1, "only the CSS-coordinate mouse input hits");
						await call(["eval", "scrollTo(0,100)"]);
						const scrolled = image(await call(["screenshot", join(dir, "scrolled.png")]));
						assert.equal(readRecord(readRecord(scrolled.geometry).crop).y, 100);
						const crop = image(
							await call(["screenshot", "#target", join(dir, "scrolled-element.png")]),
						);
						assert.equal(readRecord(crop.geometry).status, "unknown");
						assert.equal(readRecord(crop.geometry).crop, undefined);
						const batch = image(
							await call(
								["batch", "--bail"],
								JSON.stringify([["screenshot", join(dir, "batch.png")]]),
							),
						);
						assert.equal(
							readRecord(batch.geometry).status,
							"unknown",
							"batch-final browser geometry is not per-image evidence",
						);
						await call([
							"eval",
							"document.body.insertAdjacentHTML('beforeend', '<iframe id=child srcdoc=\"<button>Frame target</button>\"></iframe>')",
						]);
						await call(["frame", "#child"]);
						const framed = image(await call(["screenshot", join(dir, "frame.png")]));
						assert.equal(
							readRecord(readRecord(framed.geometry).before).frame,
							"main",
							"native viewport screenshot and eval use the main frame even after frame selection",
						);
						assert.equal(readRecord(readRecord(framed.geometry).before).childFrameCount, 1);
						await call(["frame", "main"]);
						const ambiguousElement = image(
							await call(["screenshot", "#target", join(dir, "frame-element.png")]),
						);
						assert.equal(readRecord(ambiguousElement.geometry).status, "unknown");
						await call(["open", "about:blank"]);
						await call(["screenshot", "--if-changed", join(dir, "first.png")]);
						const unchanged = await call([
							"screenshot",
							"--threshold",
							"0",
							join(dir, "absent.png"),
						]);
						const unchangedDetails = readRecord(unchanged.details);
						assert.equal(
							readRecord(unchangedDetails.data).changed,
							false,
							JSON.stringify(unchangedDetails.data),
						);
						assert.equal(
							unchanged.content.some((part) => part.type === "image"),
							false,
						);
						assert.equal(unchangedDetails.imageObservations, undefined);
						const failure = await executeRegisteredTool(h.tool, h.ctx, {
							args: ["--session", session, "--json", "click", "#missing"],
							timeoutMs: 3000,
						});
						const failureDetails = readRecord(failure.details);
						assert.equal(failure.isError, true);
						const payload = readRecord(JSON.parse(readString(failure.content[0].text)));
						assert.equal(payload.success, false);
						assert.equal(payload.failureCategory, failureDetails.failureCategory);
						assert.ok(
							readArray(payload.nextActions).length > 0,
							"native JSON failure retains actionable recovery",
						);
						t.diagnostic(
							JSON.stringify({
								viewport: viewport.pixels,
								element: element.pixels,
								full: full.pixels,
								cssHits: 1,
								scrolledElement: readRecord(crop.geometry).status,
								frame: readRecord(framed.geometry).status,
								jsonFailure: payload.failureCategory,
							}),
						);
					} finally {
						await call(["close"]);
					}
				},
			);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
			await rm(dir, { recursive: true, force: true });
		}
	},
);
