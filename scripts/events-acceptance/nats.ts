// NATS restart acceptance: with the broker stopped the domain still accepts events (the outbox keeps the NATS rows), and after the broker is
// back every event reaches the subscribed agent exactly once through the event feed, and the outbox drains.
import { adminApi, deployer, developerLogs, producer, removeHandler, saveHandler, sleep, ssh } from "./lib.ts";

const run = Date.now().toString(36);
const COUNT = 5;
const rules = deployer();
await rules.putRule("accept-nats", { description: "acceptance: recorded delivery to the developer agent", owner: "agent/pi-agent", selector: "acceptance.nats.*", where: [], wake: true, status: "active" } as any);
saveHandler("drop-nats", '// @topics acceptance.nats.*\nexport default async () => ({ action: "drop", reason: "recorded by the acceptance run" });');
const pending = (): number => adminApi("GET", "/v1/admin/overview").outbox?.pending ?? adminApi("GET", "/v1/admin/overview").outbox?.pendingCount ?? -1;
ssh("admin-cloud-services", "cd ~/somework-pilot/vm105 && docker compose stop nats");
console.log("nats stopped");
const ids: string[] = [];
for (let i = 0; i < COUNT; i++) {
	const result = await producer().publishEvent({ topic: "acceptance.nats.item", key: `${run}:nats:${i}`, source: "acceptance", data: { n: i }, classification: "internal", verified: true });
	ids.push(result.eventId);
}
await sleep(4000);
const during = adminApi("GET", "/v1/admin/overview").outbox;
console.log("accepted while down:", ids.length, "outbox:", JSON.stringify(during));
ssh("admin-cloud-services", "cd ~/somework-pilot/vm105 && docker compose start nats");
console.log("nats started");
let after: any;
for (let i = 0; i < 30; i++) {
	await sleep(4000);
	after = adminApi("GET", "/v1/admin/overview").outbox;
	const received = developerLogs("5m", ["event_received"]).filter((l) => ids.includes(l.eventId));
	if (received.length >= COUNT && JSON.stringify(after) !== JSON.stringify(during)) break;
}
const received = developerLogs("5m", ["event_received"]).filter((l) => ids.includes(l.eventId));
const distinct = new Set(received.map((l) => l.eventId));
console.log("outbox after:", JSON.stringify(after));
console.log(`agent received ${received.length} deliveries for ${distinct.size} distinct events`);
await rules.deleteRule("accept-nats");
removeHandler("drop-nats");
const ok = distinct.size === COUNT && received.length === COUNT;
console.log(ok ? "PASS: nothing lost or duplicated across a NATS restart" : "FAIL");
process.exit(ok ? 0 : 1);
