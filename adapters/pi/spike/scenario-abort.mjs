import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ctx, open, sleep } from "./lib.mjs";

for (const tool of ["slow_read", "coop_read"]) {
	const dir = mkdtempSync(join(tmpdir(), "pi-abort-"));
	const { harness, modelChoice } = await open({ db: join(dir, "s.sqlite"), marker: join(dir, "m.log"), tool, toolMs: 8000 });
	const root = await harness.root(ctx, { agent: { model: modelChoice } });
	const sub = await root.submit({ type: "input", content: "go", requestId: "a" }, ctx);
	await sleep(600);
	const t = performance.now();
	await root.abort(ctx);
	const settled = await sub.wait(ctx);
	console.log(`${tool.padEnd(10)} abort -> ${settled.status}${settled.reason ? " (" + settled.reason + ")" : ""} after ${Math.round(performance.now() - t)} ms`);
	await harness.close(ctx);
}

// what the model saw after the cooperative abort
{
	const dir = mkdtempSync(join(tmpdir(), "pi-abort2-"));
	const { harness, modelChoice } = await open({ db: join(dir, "s.sqlite"), marker: join(dir, "m.log"), tool: "coop_read", toolMs: 8000 });
	const root = await harness.root(ctx, { agent: { model: modelChoice } });
	const sub = await root.submit({ type: "input", content: "go", requestId: "b" }, ctx);
	await sleep(600);
	await root.abort(ctx);
	const settled = await sub.wait(ctx);
	const view = await root.viewState(ctx);
	const kinds = (view.value?.entries ?? []).map((e) => e.kind).join(",");
	const results = (view.value?.entries ?? []).filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e.data).slice(0, 160));
	console.log(`coop_read after abort: submission=${settled.status}${settled.reason ? "(" + settled.reason + ")" : ""} entries=${kinds}`);
	console.log("tool results:", results.join(" | ") || "(none)");
	console.log("marker:", readFileSync(join(dir, "m.log"), "utf8").trim().replace(/pid=\d+ /g, "").split("\n").map((l) => l.replace(/^\d+ /, "")).join("; "));
	await harness.close(ctx);
}
