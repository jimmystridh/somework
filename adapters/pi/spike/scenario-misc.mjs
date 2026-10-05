import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchEvents, defineDoc } from "@earendil-works/pi-durable";
import { ctx, open, sleep } from "./lib.mjs";

const fresh = async (opts) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-misc-"));
	return { dir, ...(await open({ db: join(dir, "s.sqlite"), marker: join(dir, "m.log"), ...opts })) };
};
const t0 = () => performance.now();
const ms = (t) => Math.round(performance.now() - t);

// C. abort a running submission
{
	console.log("## C. abort");
	const { harness, modelChoice, dir } = await fresh({ tool: "slow_read", toolMs: 8000 });
	const root = await harness.root(ctx, { agent: { model: modelChoice } });
	const sub = await root.submit({ type: "input", content: "go", requestId: "abort-1" }, ctx);
	await sleep(600);
	const t = t0();
	await root.abort(ctx);
	console.log(`root.abort resolved after ${ms(t)} ms; submission status:`, JSON.stringify(await sub.status?.(ctx) ?? "n/a"));
	const settled = await Promise.race([sub.wait(ctx), sleep(3000).then(() => "STILL PENDING after 3 s")]);
	console.log("wait() ->", typeof settled === "string" ? settled : `${settled.status}${settled.reason ? ": " + settled.reason : ""}`);
	console.log("marker:\n" + readFileSync(join(dir, "m.log"), "utf8").trim().replace(/pid=\d+ /g, ""));
	await harness.close(ctx);
}

// D. event stream shape
{
	console.log("## D. watchEvents");
	const { harness, modelChoice } = await fresh({ tool: "slow_read", toolMs: 100 });
	const root = await harness.root(ctx, { agent: { model: modelChoice } });
	const stream = await watchEvents(harness, root.id, ctx);
	console.log("snapshot keys:", Object.keys(stream.snapshot ?? {}).join(", "));
	const seen = [];
	stream.start(async (events) => { for (const e of events) seen.push(e.type); });
	const sub = await root.submit({ type: "input", content: "go", requestId: "ev-1" }, ctx);
	await sub.wait(ctx);
	await sleep(300);
	console.log("event types in order (deduped runs):", seen.filter((t, i) => t !== seen[i - 1]).join(" > "));
	await harness.close(ctx);
}

// E. conversations per key: parallel across keys, serial within one key, key index survives restart
{
	console.log("## E. conversation per key");
	const Keys = defineDoc({ kind: "app.keys", version: 1, scope: "conversation", history: "latest", initial: () => ({ map: {} }) });
	const { harness, modelChoice, dir } = await fresh({ tool: "slow_read", toolMs: 2000 });
	const root = await harness.root(ctx, { agent: { model: modelChoice } });
	const conversationFor = async (key) => {
		const existing = (await harness.snapshot?.(Keys, root.id, ctx))?.map?.[key];
		if (existing) return harness.conversation(existing, ctx);
		const created = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: modelChoice } }, ctx);
		await root.commit(async (tx) => { (await tx.doc(Keys, root.id)).map[key] = created.id; }, ctx);
		return created;
	};
	const [a, b] = [await conversationFor("repo-a#1"), await conversationFor("repo-b#1")];
	console.log("distinct conversations:", a.id !== b.id, "| same key resolves to same conversation:", (await conversationFor("repo-a#1")).id === a.id);
	let t = t0();
	const [sa, sb] = await Promise.all([
		a.submit({ type: "input", content: "go", requestId: "a-1" }, ctx),
		b.submit({ type: "input", content: "go", requestId: "b-1" }, ctx),
	]);
	await Promise.all([sa.wait(ctx), sb.wait(ctx)]);
	console.log(`two keys, 2 s of tool work each, wall time: ${ms(t)} ms (parallel if ~2000, serial if ~4000)`);
	t = t0();
	const [s1, s2] = [
		await a.submit({ type: "input", content: "one", requestId: "a-2" }, ctx),
		await a.submit({ type: "input", content: "two", requestId: "a-3" }, ctx),
	];
	await Promise.all([s1.wait(ctx), s2.wait(ctx)]);
	console.log(`same key, two submissions, wall time: ${ms(t)} ms (serial if ~4000)`);
	console.log("requestId is conversation-scoped: same id in another conversation is a new submission:",
		(await b.submit({ type: "input", content: "go", requestId: "a-1" }, ctx)).id !== sa.id);
	await harness.close(ctx);
}
