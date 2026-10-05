// Restart acceptance on the pilot: publish 50 distinct events, restart the domain container in the middle, retry like the hub does, then
// count what the domain made of them. Expect exactly 50 events published and 50 reaction tasks, none twice.
import { execFile } from "node:child_process";
import { deployer, producer, sleep } from "./lib.ts";

const COUNT = 50;
const run = Date.now().toString(36);
const reaction = {
	capability: { id: "code.review", version: 3 },
	input: { repository: { url: "https://github.com/jimmystridh/acceptance-does-not-exist.git", ref: "main" }, focus: "burst acceptance ${/data/n}" },
	budget: { maxTokens: 10000, maxMinutes: 2 },
	maxDepth: 3,
	maxFiringsPerHour: 200,
};
const rules = deployer();
const ruleName = `accept-burst-${run}`;
await rules.putRule(ruleName, { description: "acceptance burst", owner: "automation/pr-review", selector: "acceptance.burst.*", where: [], wake: false, reaction, status: "active" } as any);

let restarted: Promise<void> | undefined;
let retries = 0;
const events = producer();
const seqs = new Set<number>();
const eventIds = new Set<string>();
for (let i = 0; i < COUNT; i++) {
	if (i === 8) {
		restarted = new Promise((resolve) => execFile("ssh", ["admin-cloud-services", "cd ~/somework-pilot/vm105 && docker compose stop domain && sleep 6 && docker compose start domain"], () => resolve()));
	}
	for (let attempt = 0; ; attempt++) {
		try {
			const result = await events.publishEvent({ topic: "acceptance.burst.item", key: `${run}:burst:${i}`, source: "acceptance", data: { n: i }, classification: "internal", verified: true });
			seqs.add(result.seq);
			eventIds.add(result.eventId);
			await sleep(300);
			break;
		} catch (error) {
			retries += 1;
			if (attempt > 60) throw error;
			await sleep(2000);
		}
	}
}
await restarted;
console.log(`published ${COUNT} keys, ${seqs.size} distinct sequence numbers, ${retries} retries across the restart`);

let rule: any;
for (let i = 0; i < 30; i++) {
	await sleep(5000);
	rule = await rules.getRule(ruleName);
	if ((rule.counters?.fired ?? 0) + Object.values(rule.counters?.skipped ?? {}).reduce((a: number, b: any) => a + b, 0) >= COUNT) break;
}
const allFirings = ((await (rules as any).get(`/v1/rules/${ruleName}/firings?limit=200`)).firings ?? []) as any[];
const firings = allFirings.filter((f) => eventIds.has(f.eventId));
const tasks = new Set(firings.filter((f) => f.taskId).map((f) => f.taskId));
console.log("counters", JSON.stringify(rule.counters), "firings", firings.length, "distinct tasks", tasks.size);
const ok = seqs.size === COUNT && rule.counters.fired === COUNT && tasks.size === COUNT && firings.length === COUNT;
console.log(ok ? "PASS: 50 events, 50 firings, 50 distinct tasks across a domain restart" : "FAIL: counts differ");
await rules.deleteRule(ruleName);
process.exit(ok ? 0 : 1);
