import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { sleep } from "../src/backoff.ts";
import { interpret, natsInfoFrom, NatsWakeSource, runWakes, wakes, type Wake } from "../src/wake.ts";
import { startDomain, type Domain } from "./harness.ts";

const FAST_POLL_MS = 150;

let domain: Domain;
before(async () => {
	domain = await startDomain({ nats: true });
});
after(async () => {
	await domain.close();
});

async function until(what: string, ms: number, condition: () => boolean): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await sleep(50);
	}
}

/** A message from the author to the worker that wakes it. */
const say = async (text: string): Promise<string> =>
	(await domain.author.post("/v1/messages", { recipients: [{ kind: "agent", id: "agent/ts-worker" }], content: { mediaType: "text/plain", data: text }, triggerMode: "directed" })).messageId as string;

function listen() {
	const abort = new AbortController();
	const logs: string[] = [];
	const seen: Wake[] = [];
	const finished = runWakes(
		domain.worker(),
		abort.signal,
		(wake) => {
			seen.push(wake);
			void wake.ack();
		},
		{ pollEveryMs: FAST_POLL_MS, logger: (_level, message) => logs.push(message) },
	);
	return {
		logs,
		seen,
		connections: () => logs.filter((message) => message === "NATS wake connected").length,
		stop: async () => {
			abort.abort();
			await finished;
		},
	};
}

describe("NATS wake", () => {
	it("hands a message over at once, and never holds a request open", async () => {
		const listener = listen();
		await until("the listener to connect to NATS", 30_000, () => listener.connections() === 1);
		const sentAt = Date.now();
		const messageId = await say("hello");
		await until("the wake", 10_000, () => listener.seen.some((wake) => wake.messageId === messageId));
		const latency = Date.now() - sentAt;
		await listener.stop();
		assert.ok(latency < 2000, `woken after ${latency} ms`);
		const lookups = domain.requests.filter((line) => line.includes("/v1/events"));
		assert.ok(lookups.every((line) => /[?&]wait=0(&|$)/.test(line)), `no lookup may be held open: ${lookups.filter((line) => !/[?&]wait=0(&|$)/.test(line)).join(", ")}`);
	});

	it("keeps receiving through a broker outage over HTTP and returns to NATS afterwards", async () => {
		const listener = listen();
		await until("the listener to connect to NATS", 30_000, () => listener.connections() === 1);
		await domain.nats!.stop();
		await until("the listener to notice the lost broker", 15_000, () => listener.logs.includes("NATS wake lost; falling back to HTTP and reconnecting") || listener.logs.includes("NATS wake unavailable; polling over HTTP meanwhile"));
		await sleep(400);
		const whileDown = await say("sent with no broker");
		await until("the wake over HTTP", 20_000, () => listener.seen.some((wake) => wake.messageId === whileDown));
		await domain.nats!.start();
		await until("the listener to reconnect to NATS", 60_000, () => listener.connections() === 2);
		const afterwards = await say("sent after the broker came back");
		await until("the wake over NATS again", 20_000, () => listener.seen.some((wake) => wake.messageId === afterwards));
		await listener.stop();
	});

	it("refuses a plaintext broker when TLS is required", async () => {
		const info = natsInfoFrom(await domain.worker().connection());
		assert.ok(info, "the domain offers NATS");
		await assert.rejects(() => NatsWakeSource.connect(info, "agent/ts-worker", { requireTls: true }, () => {}), /./);
	});

	it("verifies a TLS broker that is addressed by IP and rejects an unknown CA", async () => {
		const secured = await startDomain({ nats: "tls" });
		try {
			const info = natsInfoFrom(await secured.worker().connection());
			assert.ok(info?.url.startsWith("tls://127.0.0.1:"), "the domain hands out the TLS URL");
			const source = await NatsWakeSource.connect(info, "agent/ts-worker", { requireTls: true, caPem: secured.nats!.caPem }, () => {});
			await source.close();
			const other = await startDomain({ nats: "tls" });
			try {
				await assert.rejects(() => NatsWakeSource.connect(info, "agent/ts-worker", { requireTls: true, caPem: other.nats!.caPem }, () => {}), /./);
			} finally {
				await other.close();
			}
		} finally {
			await secured.close();
		}
	});

	it("streams wakes to a requester-style consumer", async () => {
		const abort = new AbortController();
		const stream = wakes(domain.worker(), abort.signal, { pollEveryMs: FAST_POLL_MS });
		const first = Promise.race([stream.next(), sleep(20_000).then(() => undefined)]);
		await sleep(1500);
		const messageId = await say("for the stream");
		const wake = await first;
		abort.abort();
		await stream.return(undefined);
		assert.ok(wake && !wake.done, "a wake arrived");
		assert.deepEqual([wake.value.kind, wake.value.messageId], ["message", messageId]);
		await wake.value.ack();
	});
});

describe("wake interpretation", () => {
	it("reads the connection block", () => {
		const base = { url: "nats://h:4222", user: "u", password: "p", inboxStream: "I", inboxConsumer: "inbox-1" };
		assert.deepEqual(natsInfoFrom({ nats: base }), { url: "nats://h:4222", user: "u", password: "p", token: undefined, inboxStream: "I", inboxConsumer: "inbox-1" });
		assert.equal(natsInfoFrom({ nats: { urls: ["nats://a:1"] } })?.url, "nats://a:1");
		assert.equal(natsInfoFrom({}), undefined);
	});

	it("maps message notifications and ignores the agent's own, non-waking and other ones", () => {
		assert.deepEqual(interpret({ wake: true, kind: "message", messageId: "m1", sender: "agent/other" }, "agent/me"), { messageId: "m1", dedupeKey: "msg:m1" });
		assert.equal(interpret({ wake: false, kind: "message", messageId: "m2" }, "agent/me"), undefined);
		assert.equal(interpret({ wake: true, kind: "message", messageId: "m3", sender: "agent/me" }, "agent/me"), undefined);
		assert.equal(interpret({ wake: true, kind: "task", taskId: "t2" }, "agent/me"), undefined);
	});
});
