import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { adminToken, hookToken } from "../src/derive.ts";
import { forwardUrl } from "../src/forwarder.ts";
import { MappingEngine } from "../src/mapping.ts";
import { ReceiverClient, type ReceiverApi } from "../src/receiver-client.ts";
import { createHubServer } from "../src/server.ts";
import { githubPr, MAPPINGS, post, removeDir, SECRET, startEdge, startWorld, tempDir, waitFor, type World } from "./support.ts";

const worlds: World[] = [];
const servers: Server[] = [];
const hubServer = (...args: Parameters<typeof createHubServer>) => {
	const server = createHubServer(...args);
	servers.push(server);
	return server;
};
const world = async (...args: Parameters<typeof startWorld>) => {
	const w = await startWorld(...args);
	worlds.push(w);
	return w;
};
afterEach(async () => {
	while (servers.length) {
		const server = servers.pop()!;
		if (server.listening) await new Promise((r) => { server.closeAllConnections(); server.close(r); });
	}
	while (worlds.length) {
		const w = worlds.pop()!;
		await w.hub.stop().catch(() => {});
		await w.stop();
	}
});

describe("from webhook to published event", () => {
	it("publishes a GitHub pull request as the github producer, with a stable key", async () => {
		const w = await world();
		const pr = githubPr("delivery-0001");
		assert.equal((await post(w.edge.hook("github"), pr)).status, 202);
		w.hub.start();
		await waitFor(() => w.domain.uniqueEvents === 1, 8000, "the event");
		const call = w.domain.calls[0]!;
		assert.equal(call.issuer, "service:producer/github", "published under the source's own principal");
		assert.equal(call.body.topic, "github.pull_request.opened");
		assert.equal(call.body.key, "github:delivery:delivery-0001");
		assert.equal(call.body.source, "github");
		assert.equal(call.body.verified, true);
		assert.equal(call.body.classification, "internal");
		assert.equal(call.body.data.repository.cloneUrl, "https://github.com/o/r.git");
		assert.equal(call.body.data.number, 7);
		await waitFor(() => w.edge.queue.stats().queued === 0, 5000, "the receiver queue to be acknowledged");
	});

	it("turns a duplicate delivery of the same GitHub delivery id into one event", async () => {
		const w = await world();
		const pr = githubPr("delivery-dup");
		await post(w.edge.hook("github"), pr);
		await post(w.edge.hook("github"), pr);
		await post(w.edge.hook("github"), githubPr("delivery-other", "synchronize"));
		w.hub.start();
		await waitFor(() => w.domain.calls.length === 3, 8000, "three publish calls");
		assert.equal(w.domain.uniqueEvents, 2, "two distinct events");
		assert.deepEqual(w.domain.calls.map((c) => c.duplicate), [false, true, false]);
		assert.match(w.hub.metrics.render(), /hub_events_duplicate_total\{source="github"\} 1/);
	});

	it("publishes each source under its own principal", async () => {
		const w = await world();
		await post(w.edge.hook("github"), githubPr("d-1"));
		await post(w.edge.hook("jira"), { headers: { "content-type": "application/json" }, body: JSON.stringify({ webhookEvent: "jira:issue_created", timestamp: 1, issue: { id: "10", key: "ADM-1", fields: { summary: "s", status: { name: "Open" } } } }) });
		await post(w.edge.hook("datadog"), { headers: { "content-type": "application/json" }, body: JSON.stringify({ alert_id: "9", transition: "Triggered", status: "Alert", date: "1759651200000", title: "t" }) });
		w.hub.start();
		await waitFor(() => w.domain.uniqueEvents === 3, 8000, "three events");
		assert.deepEqual(w.domain.calls.map((c) => `${c.issuer}=${c.body.topic}`).sort(), ["service:producer/datadog=datadog.monitor.alert", "service:producer/github=github.pull_request.opened", "service:producer/jira=jira.issue.created"]);
	});

	it("drops a webhook that maps to nothing, counts it, and still acknowledges it", async () => {
		const w = await world();
		await post(w.edge.hook("github"), { headers: { "x-github-event": "ping", "x-github-delivery": "p1", "content-type": "application/json" }, body: JSON.stringify({ zen: "hi" }) });
		w.hub.start();
		await waitFor(() => w.edge.queue.stats().queued === 0, 8000, "the ping to be acknowledged");
		assert.equal(w.domain.calls.length, 0);
		assert.match(w.hub.metrics.render(), /hub_events_dropped_total\{reason="no_event",source="github"\} 1/);
	});
});

describe("restarts lose and duplicate nothing", () => {
	it("a restarted receiver still hands over everything it had accepted", async () => {
		const w = await world();
		for (let i = 0; i < 5; i++) await post(w.edge.hook("github"), githubPr(`before-restart-${i}`));
		await w.edge.stop();
		const again = await startEdge(w.dir);
		const rebuilt = w.rebuild({ receiver: new ReceiverClient({ url: again.privateUrl }, SECRET) });
		rebuilt.start();
		await waitFor(() => w.domain.uniqueEvents === 5, 10000, "five events after the receiver restart");
		await waitFor(() => again.queue.stats().queued === 0, 5000, "acknowledged");
		await rebuilt.stop();
		await again.stop();
		assert.equal(w.domain.calls.length, 5, "each webhook was published once");
		w.edge.stop = async () => {};
	});

	it("a hub that dies between publishing and acknowledging republishes, and the key makes it a no-op", async () => {
		let failAck = true;
		const w = await world({
			receiver: (real): ReceiverApi => ({
				pull: (...args) => real.pull(...args),
				ack: async (upTo) => {
					if (failAck) throw new Error("hub killed before the acknowledgement");
					return real.ack(upTo);
				},
				stats: () => real.stats(),
				setPaused: (...args) => real.setPaused(...args),
			}),
		});
		for (let i = 0; i < 4; i++) await post(w.edge.hook("github"), githubPr(`crash-${i}`));
		w.hub.start();
		await waitFor(() => w.domain.calls.length === 4, 8000, "the first four publishes");
		await w.hub.stop();
		assert.equal(w.edge.queue.stats().queued, 4, "nothing was acknowledged");

		failAck = false;
		const second = w.rebuild();
		second.start();
		await waitFor(() => w.edge.queue.stats().queued === 0, 8000, "the queue to drain after the restart");
		await second.stop();
		assert.equal(w.domain.uniqueEvents, 4, "no event lost");
		assert.equal(w.domain.calls.length, 8);
		assert.equal(w.domain.calls.filter((c) => c.duplicate).length, 4, "the republished ones were recognised by their keys");
	});

	it("resumes from the stored cursor and notices a receiver whose sequence was reset", async () => {
		const w = await world();
		await post(w.edge.hook("github"), githubPr("c-1"));
		await post(w.edge.hook("github"), githubPr("c-2"));
		w.hub.start();
		await waitFor(() => w.store.cursor() === 2, 8000, "cursor 2");
		await w.hub.stop();
		w.store.setCursor(500);
		const again = w.rebuild();
		await post(w.edge.hook("github"), githubPr("c-3"));
		again.start();
		await waitFor(() => w.domain.uniqueEvents === 3, 8000, "the event after the cursor reset");
		await again.stop();
	});
});

describe("failures", () => {
	it("retries a domain that is down and publishes when it comes back", async () => {
		const w = await world();
		w.domain.failures = [{ status: 503 }, { status: 503 }];
		await post(w.edge.hook("github"), githubPr("flaky"));
		w.hub.start();
		await waitFor(() => w.domain.uniqueEvents === 1, 8000, "the event after two 503s");
		assert.equal(w.domain.calls.length, 3);
		assert.equal(w.store.deadLetters().length, 0);
		assert.ok(w.sleeps.length >= 2, "it backed off between attempts");
	});

	it("treats a 401 (credentials being fixed) as worth waiting for, not as a dead letter", async () => {
		const w = await world();
		w.domain.failures = [{ status: 401 }];
		await post(w.edge.hook("github"), githubPr("auth"));
		w.hub.start();
		await waitFor(() => w.domain.uniqueEvents === 1, 8000, "the event after a 401");
		assert.equal(w.store.deadLetters().length, 0);
	});

	it("dead-letters a refused event, acknowledges it, and can replay it once the cause is fixed", async () => {
		const w = await world();
		w.domain.always = { status: 400 };
		await post(w.edge.hook("github"), githubPr("refused"));
		await post(w.edge.hook("github"), githubPr("fine-after"));
		w.hub.start();
		await waitFor(() => w.store.deadLetters().length === 2, 8000, "two dead letters");
		await waitFor(() => w.edge.queue.stats().queued === 0, 5000, "the queue to be acknowledged");
		const [letter] = w.store.deadLetters();
		assert.equal(letter!.kind, "publish");
		assert.match(letter!.error, /400/);
		assert.match(w.hub.metrics.render(), /hub_events_dead_lettered_total\{kind="publish",source="github"\} 2/);

		w.domain.always = undefined;
		const outcome = await w.hub.replayDeadLetter(letter!.id);
		assert.equal(outcome.kind, "published");
		assert.equal(w.domain.uniqueEvents, 1);
		assert.equal(w.store.deadLetters({ pending: true }).length, 1, "the replayed one is no longer pending");
		await assert.rejects(w.hub.replayDeadLetter("no-such-id"), /no dead letter/);
	});

	it("dead-letters after maxAttempts of a domain that stays down", async () => {
		const w = await world({ maxAttempts: 3 });
		w.domain.always = { status: 503 };
		await post(w.edge.hook("github"), githubPr("down"));
		w.hub.start();
		await waitFor(() => w.store.deadLetters().length === 1, 8000, "a dead letter");
		assert.match(w.store.deadLetters()[0]!.error, /gave up after 3 attempts/);
		assert.equal(w.domain.calls.length, 3);
	});

	it("dead-letters a webhook whose mapping throws, and replays it after the mapping is fixed", async () => {
		const broken = tempDir("mappings-broken-");
		writeFileSync(join(broken, "github.jsonata"), `$error("cannot handle this")`);
		const w = await world({ mappingsDir: broken });
		await post(w.edge.hook("github"), githubPr("mapped-badly"));
		w.hub.start();
		await waitFor(() => w.store.deadLetters().length === 1, 8000, "the mapping failure to be dead-lettered");
		await w.hub.stop();
		assert.equal(w.store.deadLetters()[0]!.kind, "mapping");
		assert.match(w.store.deadLetters()[0]!.error, /cannot handle this/);
		assert.equal(w.domain.calls.length, 0);

		writeFileSync(join(broken, "github.jsonata"), readFileSync(join(MAPPINGS, "github.jsonata"), "utf8"));
		const outcome = await w.rebuild().replayDeadLetter(w.store.deadLetters()[0]!.id);
		assert.equal(outcome.kind, "published");
		assert.equal(w.domain.uniqueEvents, 1);
		removeDir(broken);
	});

	it("rejects an event whose topic is outside the source's prefix before it reaches the domain", async () => {
		const dir = tempDir("mappings-prefix-");
		writeFileSync(join(dir, "github.jsonata"), `{"topic": "jira.issue.created", "key": "k", "data": {"a": 1}}`);
		const w = await world({ mappingsDir: dir });
		await post(w.edge.hook("github"), githubPr("wrong-prefix"));
		w.hub.start();
		await waitFor(() => w.edge.queue.stats().queued === 0, 8000, "acknowledged");
		assert.equal(w.domain.calls.length, 0);
		assert.match(w.hub.metrics.render(), /reason="topic_outside_source_prefix"/);
		removeDir(dir);
	});
});

describe("forward-only sources", () => {
	const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJmb3JnZSI6MX0.Zm9vYmFyYmF6cXV4";
	const target = async (statuses: number[]) => {
		const received: { url: string; headers: Record<string, string | string[] | undefined>; body: Buffer }[] = [];
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => {
				received.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
				res.writeHead(statuses.shift() ?? 200).end("ok");
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		return { received, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
	};

	it("builds the target from the base, the sender's path suffix and its own query", () => {
		const base = { baseUrl: "https://10.10.10.14:9445" };
		assert.equal(forwardUrl(base, { path: "/api/hook", query: "access_token=a.b.c" }), "https://10.10.10.14:9445/api/hook?access_token=a.b.c");
		assert.equal(forwardUrl(base, { path: "/api/hook", query: "" }), "https://10.10.10.14:9445/api/hook");
		assert.equal(forwardUrl(base, { path: "", query: "" }), "https://10.10.10.14:9445");
		assert.equal(forwardUrl({ baseUrl: "https://h/prefix" }, { path: "/api/hook", query: "x=%2B" }), "https://h/prefix/api/hook?x=%2B", "the query is not decoded or re-encoded");
	});

	it("replays the exact bytes, path suffix and query with the original delivery headers, and publishes no event", async () => {
		const t = await target([]);
		const w = await world({ forwardUrl: t.baseUrl });
		const body = Buffer.from('{"zen":"å ä ö","n":1}\n  trailing whitespace  ', "utf8");
		const query = `access_token=${jwt}&x=a%2Bb`;
		await post(w.edge.hook("woodpecker", 1, `/api/hook?${query}`), { headers: { "content-type": "application/json", "x-github-event": "push", "x-github-delivery": "wp-1", "x-hub-signature-256": "sha256=cafebabe", cookie: "nope" }, body });
		w.hub.start();
		await waitFor(() => t.received.length === 1, 8000, "the forwarded webhook");
		assert.equal(t.received[0]!.url, `/api/hook?${query}`);
		assert.deepEqual(t.received[0]!.body, body);
		assert.equal(t.received[0]!.headers["x-hub-signature-256"], "sha256=cafebabe");
		assert.equal(t.received[0]!.headers["x-github-event"], "push");
		assert.equal(t.received[0]!.headers["content-type"], "application/json");
		assert.equal(t.received[0]!.headers.cookie, undefined);
		assert.equal(w.domain.calls.length, 0);
		await waitFor(() => w.edge.queue.stats().queued === 0, 5000, "acknowledged");
		await t.close();
	});

	it("never logs the query, even when the target is unreachable or refuses", async () => {
		const lines: string[] = [];
		const t = await target([403]);
		const w = await world({ forwardUrl: t.baseUrl, log: (level, event, fields) => lines.push(JSON.stringify({ level, event, ...fields })) });
		await post(w.edge.hook("woodpecker", 1, `/api/hook?access_token=${jwt}`), { headers: { "x-github-event": "push", "content-type": "application/json" }, body: "{}" });
		w.hub.start();
		await waitFor(() => w.store.deadLetters().length === 1, 8000, "the refused webhook dead-lettered");
		await w.hub.stop();
		await t.close();
		const log = lines.join("\n");
		assert.ok(log.includes("event_dead_lettered"));
		assert.ok(!log.includes(jwt) && !log.includes("access_token"));
		const stored = w.store.deadLetters()[0]!;
		assert.equal(stored.path, "/api/hook");
		assert.equal(stored.query, `access_token=${jwt}`, "kept for the replay, for at most 24 hours");

		const unreachable = await world({ forwardUrl: "http://127.0.0.1:9", maxAttempts: 2, log: (level, event, fields) => lines.push(JSON.stringify({ level, event, ...fields })) });
		await post(unreachable.edge.hook("woodpecker", 1, `/api/hook?access_token=${jwt}`), { headers: { "x-github-event": "push", "content-type": "application/json" }, body: "{}" });
		unreachable.hub.start();
		await waitFor(() => unreachable.store.deadLetters().length === 1, 8000, "dead letter after the target stayed unreachable");
		assert.ok(!lines.join("\n").includes(jwt));
	});

	it("keeps the query out of the operator's dead-letter listing", async () => {
		const t = await target([400]);
		const w = await world({ forwardUrl: t.baseUrl });
		const server = hubServer(w.hub, w.store, SECRET);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		await post(w.edge.hook("woodpecker", 1, `/api/hook?access_token=${jwt}`), { headers: { "x-github-event": "push", "content-type": "application/json" }, body: "{}" });
		w.hub.start();
		await waitFor(() => w.store.deadLetters().length === 1, 8000, "a dead letter");
		const listing = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/dead-letters`, { headers: { authorization: `Bearer ${adminToken(SECRET)}` } })).text();
		assert.ok(!listing.includes(jwt) && !listing.includes("access_token"));
		assert.match(listing, /"kind":"forward"/);
		await new Promise((r) => { server.closeAllConnections(); server.close(r); });
		await t.close();
	});

	it("retries a target that is down and dead-letters one that refuses", async () => {
		const t = await target([502, 200, 403]);
		const w = await world({ forwardUrl: t.baseUrl });
		await post(w.edge.hook("woodpecker", 1, "/api/hook?access_token=a"), { headers: { "x-github-event": "push", "content-type": "application/json" }, body: "{}" });
		await post(w.edge.hook("woodpecker", 1, "/api/hook?access_token=b"), { headers: { "x-github-event": "push", "content-type": "application/json" }, body: "{\"second\":true}" });
		w.hub.start();
		await waitFor(() => t.received.length === 3, 8000, "three attempts");
		await waitFor(() => w.store.deadLetters().length === 1, 5000, "the refused one dead-lettered");
		assert.equal(w.store.deadLetters()[0]!.kind, "forward");
		assert.deepEqual(t.received.map((r) => r.url), ["/api/hook?access_token=a", "/api/hook?access_token=a", "/api/hook?access_token=b"]);
		await t.close();
	});

	it("replays a dead-lettered forward with its original path and query", async () => {
		const t = await target([400, 200]);
		const w = await world({ forwardUrl: t.baseUrl });
		await post(w.edge.hook("woodpecker", 1, `/api/hook?access_token=${jwt}`), { headers: { "x-github-event": "push", "content-type": "application/json" }, body: "{\"n\":1}" });
		w.hub.start();
		await waitFor(() => w.store.deadLetters().length === 1, 8000, "a dead letter");
		const outcome = await w.hub.replayDeadLetter(w.store.deadLetters()[0]!.id);
		assert.equal(outcome.kind, "forwarded");
		assert.equal(t.received[1]!.url, `/api/hook?access_token=${jwt}`);
		await t.close();
	});
});

describe("the internal listener", () => {
	it("accepts Grafana alerts with the source token and publishes one event per alert", async () => {
		const w = await world();
		const server = hubServer(w.hub, w.store, SECRET);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const token = hookToken(SECRET, "grafana", 1);
		const alert = (fp: string) => ({ status: "firing", labels: { alertname: "A" }, annotations: {}, startsAt: "2026-10-05T10:00:00Z", endsAt: "0001-01-01T00:00:00Z", fingerprint: fp, generatorURL: "https://g.example/alerting/grafana/rule-uid-1/view?orgId=1" });
		const payload = JSON.stringify({ status: "firing", alerts: [alert("f1"), alert("f2")] });

		assert.equal((await post(`${base}/in/grafana/${"x".repeat(43)}`, { body: payload })).status, 401);
		assert.equal((await post(`${base}/in/github/${hookToken(SECRET, "github", 1)}`, { body: payload })).status, 404, "github is a public source, not an internal one");
		assert.equal((await post(`${base}/in/grafana/${token}`, { body: "" })).status, 400);
		assert.equal((await post(`${base}/in/grafana/${token}`, { body: Buffer.alloc(1024 * 1024 + 1, 97) })).status, 413);
		assert.equal((await post(`${base}/in/grafana/${token}`, { headers: { "content-type": "application/json" }, body: payload })).status, 202);

		w.hub.start();
		await waitFor(() => w.domain.uniqueEvents === 2, 8000, "two Grafana events");
		assert.deepEqual(w.domain.calls.map((c) => c.issuer), ["service:producer/grafana", "service:producer/grafana"]);
		await waitFor(() => w.store.inboxSize() === 0, 8000, "the inbox to drain");
		await new Promise((r) => { server.closeAllConnections(); server.close(r); });
	});
});

describe("operating the hub", () => {
	it("pauses and resumes a source: webhooks are refused at the edge, and ones already pulled are dropped", async () => {
		const w = await world();
		const server = hubServer(w.hub, w.store, SECRET);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const admin = { authorization: `Bearer ${adminToken(SECRET)}` };

		assert.equal((await fetch(`${base}/admin/sources/github/pause`, { method: "POST" })).status, 401);
		assert.equal((await fetch(`${base}/admin/sources/nosuch/pause`, { method: "POST", headers: admin })).status, 404);
		await post(w.edge.hook("github"), githubPr("queued-before-pause"));
		assert.equal((await fetch(`${base}/admin/sources/github/pause`, { method: "POST", headers: admin })).status, 200);
		assert.equal((await post(w.edge.hook("github"), githubPr("after-pause"))).status, 404, "refused at the receiver");
		w.hub.start();
		await waitFor(() => w.edge.queue.stats().queued === 0, 8000, "the queued webhook to be dropped");
		assert.equal(w.domain.calls.length, 0);
		assert.match(w.hub.metrics.render(), /reason="paused"/);

		assert.equal((await fetch(`${base}/admin/sources/github/resume`, { method: "POST", headers: admin })).status, 200);
		assert.equal((await post(w.edge.hook("github"), githubPr("after-resume"))).status, 202);
		await waitFor(() => w.domain.uniqueEvents === 1, 8000, "the event after resume");

		const listed = (await (await fetch(`${base}/admin/dead-letters`, { headers: admin })).json()) as { deadLetters: unknown[] };
		assert.deepEqual(listed.deadLetters, []);
		await new Promise((r) => { server.closeAllConnections(); server.close(r); });
	});

	it("reports sources, the clock's next runs and the receiver on /admin/stats, behind the admin bearer", async () => {
		const w = await world({ clock: { producer: { keyFile: "x" }, schedules: [{ name: "nightly_digest", cron: "0 23 * * *", timeZone: "Europe/Stockholm" }] } });
		const server = hubServer(w.hub, w.store, SECRET);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const admin = { authorization: `Bearer ${adminToken(SECRET)}` };
		assert.equal((await fetch(`${base}/admin/stats`)).status, 401);
		assert.equal((await fetch(`${base}/admin/stats`, { headers: { authorization: "Bearer nope" } })).status, 401);

		const before = (await (await fetch(`${base}/admin/stats`, { headers: admin })).json()) as any;
		assert.deepEqual(before.receiver, { queued: null, oldestAgeSeconds: null, reachable: false }, "nothing has been seen yet");
		assert.deepEqual(before.sources.map((s: any) => s.name), ["github", "jira", "datadog", "grafana", "woodpecker"]);
		assert.ok(before.sources.every((s: any) => s.paused === false));
		assert.equal(before.schedules.length, 1);
		assert.equal(before.schedules[0].name, "nightly_digest");
		assert.match(before.schedules[0].nextRunAt, /^\d{4}-\d\d-\d\dT23:00:00\+0[12]:00$/, "23:00 Stockholm with the zone's offset");

		await post(w.edge.hook("jira"), { headers: { "content-type": "application/json" }, body: JSON.stringify({ webhookEvent: "x" }) });
		await w.hub.setSourcePaused("datadog", true);
		w.hub.start();
		await waitFor(async () => ((await (await fetch(`${base}/admin/stats`, { headers: admin })).json()) as any).receiver.reachable === true, 8000, "the receiver to be seen");
		const after = (await (await fetch(`${base}/admin/stats`, { headers: admin })).json()) as any;
		assert.equal(typeof after.receiver.queued, "number");
		assert.equal(typeof after.receiver.oldestAgeSeconds, "number");
		assert.equal(after.sources.find((s: any) => s.name === "datadog").paused, true);
		assert.equal(after.sources.find((s: any) => s.name === "github").paused, false);

		await w.edge.stop();
		w.edge.stop = async () => {};
		await w.hub.stop();
		await new Promise((r) => { server.closeAllConnections(); server.close(r); });
	});

	it("shows an unreachable receiver as reachable:false with null numbers", async () => {
		const w = await world();
		const failing = w.rebuild({ receiver: { pull: async () => { throw new Error("down"); }, ack: async () => {}, stats: async () => { throw new Error("down"); }, setPaused: async () => {} } });
		failing.start();
		await new Promise((r) => setTimeout(r, 200));
		assert.deepEqual(failing.adminStats().receiver, { queued: null, oldestAgeSeconds: null, reachable: false });
		await failing.stop();
	});

	it("exposes health and Prometheus metrics", async () => {
		const w = await world();
		const server = hubServer(w.hub, w.store, SECRET);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		await post(w.edge.hook("github"), githubPr("m-1"));
		w.hub.start();
		await waitFor(() => w.domain.uniqueEvents === 1, 8000, "an event");
		assert.equal((await fetch(`${base}/healthz`)).status, 200);
		const metrics = await (await fetch(`${base}/metrics`)).text();
		for (const name of ["hub_events_received_total", "hub_events_published_total", "hub_events_duplicate_total", "hub_events_dropped_total", "hub_events_dead_lettered_total", "hub_dead_letters", "hub_receiver_oldest_pending_age_seconds", "hub_receiver_up"]) assert.match(metrics, new RegExp(`# TYPE ${name} `), name);
		assert.match(metrics, /hub_events_received_total\{source="github"\} 1/);
		assert.match(metrics, /hub_events_published_total\{source="github"\} 1/);
		await waitFor(() => /hub_receiver_up 1/.test(w.hub.metrics.render()), 5000, "receiver up gauge");
		await new Promise((r) => { server.closeAllConnections(); server.close(r); });
	});

	it("stops promptly even while a long poll is open", async () => {
		const w = await world();
		w.hub.start();
		await new Promise((r) => setTimeout(r, 200));
		const started = Date.now();
		await w.hub.stop();
		assert.ok(Date.now() - started < 3000, "stop() must abort the long poll");
	});

	it("logs events, never webhook bodies or tokens", async () => {
		const lines: string[] = [];
		const w = await world({ log: (level, event, fields) => lines.push(JSON.stringify({ level, event, ...fields })) });
		const pr = githubPr("log-1");
		pr.body = pr.body.replace("Fix rounding", "CANARY-TITLE-TEXT");
		await post(w.edge.hook("github"), pr);
		w.hub.start();
		await waitFor(() => w.domain.uniqueEvents === 1, 8000, "an event");
		await w.hub.stop();
		const log = lines.join("\n");
		assert.match(log, /hub_started/);
		assert.match(log, /event_published/);
		assert.match(log, /hub_stopped/);
		assert.ok(!log.includes("CANARY-TITLE-TEXT"));
		assert.ok(!log.includes(hookToken(SECRET, "github", 1)));
	});
});
