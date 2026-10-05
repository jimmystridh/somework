// Loop cut on the pilot: a rule whose reaction fails, and a second rule that reacts to every failed task of that capability.
// With maxDepth 2 the chain must stop: depth 0 (event) -> task -> failed event (depth 1) -> task -> failed event (depth 2) -> skipped.
import { deployer, producer, sleep } from "./lib.ts";

const reaction = {
	capability: { id: "code.review", version: 3 },
	input: { repository: { url: "https://github.com/jimmystridh/acceptance-does-not-exist.git", ref: "main" }, focus: "loop acceptance" },
	budget: { maxTokens: 10000, maxMinutes: 2 },
	maxDepth: 2,
	maxFiringsPerHour: 100,
};
const rules = deployer();
await rules.putRule("accept-loop-start", { description: "acceptance loop start", owner: "automation/pr-review", selector: "acceptance.loop.start", where: [], wake: false, reaction, status: "active" } as any);
await rules.putRule("accept-loop-chain", { description: "acceptance loop chain", owner: "automation/pr-review", selector: "task.failed", where: [{ path: "/capabilityId", equals: "code.review" }], wake: false, reaction, status: "active" } as any);
const event = await producer().publishEvent({ topic: "acceptance.loop.start", key: `loop:${Date.now()}`, source: "acceptance", data: {}, classification: "internal", verified: true });
console.log("published", event.eventId);
let start: any, chain: any;
for (let i = 0; i < 24; i++) {
	await sleep(10_000);
	start = await rules.getRule("accept-loop-start");
	chain = await rules.getRule("accept-loop-chain");
	const skippedDepth = (chain.counters?.skipped?.depth ?? 0) + (start.counters?.skipped?.depth ?? 0);
	if (skippedDepth > 0 && (chain.counters?.fired ?? 0) >= 2) break;
}
console.log("start", JSON.stringify(start.counters), "chain", JSON.stringify(chain.counters));
const firings = await (rules as any).get("/v1/rules/accept-loop-chain/firings?limit=20");
console.log("chain firings", JSON.stringify((firings.firings ?? firings).map((f: any) => ({ status: f.status, reason: f.reason, taskId: f.taskId }))));
const depthCut = (chain.counters?.skipped?.depth ?? 0) > 0;
console.log(depthCut ? "PASS: the loop was cut by the depth limit" : "FAIL: no depth skip recorded");
await rules.deleteRule("accept-loop-chain");
await rules.deleteRule("accept-loop-start");
process.exit(depthCut ? 0 : 1);
