import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseConfig } from "../src/config.ts";
import { watchToken } from "../src/derive.ts";
import { createHubServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { MappedEvent, RawItem } from "../src/types.ts";
import { watchTopic, Watches, WatchError } from "../src/watches.ts";
import { removeDir, SECRET, startWorld, tempDir, type World } from "./support.ts";

const AGENT = "agent/aikido-fixer";
const OTHER = "agent/reviewer";
const DAY = 86_400_000;

const base = { domain: { url: "http://x" }, receiver: { url: "http://y" } };
const github = { name: "github", mapping: "github", producer: { keyFile: "k" } };
const configOf = (watches: object = {}) => parseConfig({ ...base, sources: [github], watches }).watches!;

const repo = { fullName: "Visma/Repo", cloneUrl: "https://github.com/Visma/Repo.git", htmlUrl: "https://github.com/Visma/Repo" };
const event = (topic: string, delivery: string, data: object): MappedEvent => ({ topic, key: `github:delivery:${delivery}`, classification: "internal", data: { repository: repo, sender: "anna", ...data } as MappedEvent["data"] });
const pr = (action: string, delivery: string, number = 7, headSha = "aaa") => event(`github.pull_request.${action}`, delivery, { action, number, headSha });

const rig = () => {
	const dir = tempDir("watches-");
	const store = new Store(join(dir, "hub.sqlite"));
	let clock = Date.parse("2026-10-13T08:00:00Z");
	const published: { event: MappedEvent; occurredAt: string }[] = [];
	const failures = { next: 0 };
	const watches = new Watches({ config: configOf({ maxPerAgent: 3 }), store, now: () => clock });
	const relay = (...events: MappedEvent[]) =>
		watches.relay(events, "2026-10-13T08:00:00Z", async (e, occurredAt) => {
			if (failures.next > 0) {
				failures.next--;
				throw new Error("domain down");
			}
			published.push({ event: e, occurredAt });
		});
	return { watches, store, published, failures, relay, advance: (ms: number) => (clock += ms), done: () => (store.close(), removeDir(dir)) };
};

describe("watches", () => {
	it("re-publishes the events of one pull request on the agent's own topic, and nothing else", async () => {
		const r = rig();
		const { watch } = r.watches.request(AGENT, { repository: "visma/repo", number: 7 });
		assert.equal(watch.topic, "github.watch.aikido_fixer.event");
		const review = event("github.pull_request_review.submitted", "d1", { number: 7, review: { id: 1, state: "approved" } });
		await r.relay(review, event("github.pull_request_review.submitted", "d2", { number: 8, review: { id: 2 } }), event("github.push.pushed", "d3", { ref: "refs/heads/fix" }));
		assert.equal(r.published.length, 1);
		const { event: out } = r.published[0]!;
		assert.equal(out.topic, "github.watch.aikido_fixer.event");
		assert.equal(out.key, `github:watch:${watch.id}:d1`);
		assert.deepEqual(out.data, { watchId: watch.id, topic: "github.pull_request_review.submitted", repository: "Visma/Repo", number: 7, event: review.data });
		r.done();
	});

	it("delivers to every agent that watches the pull request, and to none that watch another", async () => {
		const r = rig();
		r.watches.request(AGENT, { repository: "visma/repo", number: 7 });
		r.watches.request(OTHER, { url: "https://github.com/Visma/Repo/pull/7/files" });
		r.watches.request(OTHER, { repository: "visma/repo", number: 9 });
		await r.relay(pr("synchronize", "d1"));
		assert.deepEqual(r.published.map((p) => p.event.topic).sort(), ["github.watch.aikido_fixer.event", "github.watch.reviewer.event"]);
		r.done();
	});

	it("matches pull request comments but not comments on issues, and check runs by pull request or, without one, by commit", async () => {
		const r = rig();
		r.watches.request(AGENT, { repository: "visma/repo", number: 7 });
		await r.relay(pr("synchronize", "d0", 7, "abc123"));
		r.published.length = 0;
		await r.relay(
			event("github.issue_comment.created", "d1", { number: 7, isPullRequest: true }),
			event("github.issue_comment.created", "d2", { number: 7, isPullRequest: false }),
			event("github.check_run.completed", "d3", { headSha: "zzz", pullRequests: [7, 8] }),
			event("github.check_run.completed", "d4", { headSha: "abc123", pullRequests: [] }),
			event("github.check_run.completed", "d5", { headSha: "other", pullRequests: [] }),
			event("github.check_run.completed", "d6", { headSha: "abc123", pullRequests: [9] }),
		);
		assert.deepEqual(r.published.map((p) => (p.event.data as { event: { headSha?: string } }).event.headSha ?? "comment"), ["comment", "zzz", "abc123"]);
		r.done();
	});

	it("renews the same watch instead of adding another, and keeps its id", () => {
		const r = rig();
		const first = r.watches.request(AGENT, { repository: "Visma/Repo", number: 7 });
		const again = r.watches.request(AGENT, { url: "https://github.com/visma/repo/pull/7" });
		assert.equal(first.created, true);
		assert.equal(again.created, false);
		assert.equal(again.watch.id, first.watch.id);
		assert.equal(r.watches.list(AGENT).length, 1);
		r.done();
	});

	it("ends on merge after delivering the merge, and a renewal brings it back", async () => {
		const r = rig();
		const { watch } = r.watches.request(AGENT, { repository: "visma/repo", number: 7 });
		await r.relay(pr("merged", "d1"));
		assert.equal(r.published.length, 1);
		assert.deepEqual(r.watches.list(AGENT).map((w) => [w.status, w.endReason]), [["ended", "merged"]]);
		await r.relay(event("github.check_run.completed", "d2", { pullRequests: [7], headSha: "x" }));
		assert.equal(r.published.length, 1, "nothing after the end");
		const renewed = r.watches.request(AGENT, { repository: "visma/repo", number: 7 });
		assert.equal(renewed.watch.id, watch.id);
		assert.equal(renewed.watch.status, "active");
		assert.equal(renewed.watch.endReason, undefined);
		r.done();
	});

	it("keeps a closed pull request for 7 days (a reopening resumes it), then ends the watch", async () => {
		const r = rig();
		r.watches.request(AGENT, { repository: "visma/repo", number: 7 });
		await r.relay(pr("closed", "d1"));
		assert.equal(r.watches.list(AGENT)[0]!.status, "closed");
		r.advance(6 * DAY);
		await r.relay(pr("reopened", "d2"));
		assert.equal(r.watches.list(AGENT)[0]!.status, "active");
		await r.relay(pr("closed", "d3"));
		r.advance(6 * DAY);
		assert.equal(r.watches.maintain(), 0);
		r.advance(2 * DAY);
		assert.equal(r.watches.maintain(), 1);
		assert.deepEqual(r.watches.list(AGENT).map((w) => [w.status, w.endReason]), [["ended", "closed"]]);
		r.done();
	});

	it("ends a watch nobody renewed and nothing happened to in 30 days; an event keeps it alive", async () => {
		const r = rig();
		r.watches.request(AGENT, { repository: "visma/repo", number: 7 });
		r.watches.request(AGENT, { repository: "visma/repo", number: 8 });
		r.advance(20 * DAY);
		await r.relay(pr("synchronize", "d1", 8));
		r.advance(15 * DAY);
		assert.equal(r.watches.maintain(), 1);
		assert.deepEqual(r.watches.list(AGENT).map((w) => [w.number, w.status, w.endReason]), [[7, "ended", "expired"], [8, "active", undefined]]);
		r.done();
	});

	it("lists an ended watch for 7 days, with its reason, and then forgets it", () => {
		const r = rig();
		r.watches.request(AGENT, { repository: "visma/repo", number: 7 });
		assert.equal(r.watches.cancel(AGENT, "visma/repo#7"), true);
		assert.equal(r.watches.cancel(AGENT, "visma/repo#7"), false);
		assert.equal(r.watches.list(AGENT)[0]!.endReason, "cancelled");
		r.advance(6 * DAY);
		r.watches.maintain();
		assert.equal(r.watches.list(AGENT).length, 1);
		r.advance(2 * DAY);
		r.watches.maintain();
		assert.equal(r.watches.list(AGENT).length, 0);
		r.done();
	});

	it("cancels by id, and only the agent's own", () => {
		const r = rig();
		const mine = r.watches.request(AGENT, { repository: "visma/repo", number: 7 });
		r.watches.request(OTHER, { repository: "visma/repo", number: 7 });
		assert.equal(r.watches.cancel(OTHER, mine.watch.id), false);
		assert.equal(r.watches.cancel(AGENT, mine.watch.id), true);
		assert.equal(r.watches.list(OTHER)[0]!.status, "active");
		r.done();
	});

	it("refuses what is out of bounds, with a reason", () => {
		const r = rig();
		const refused = (raw: Parameters<Watches["request"]>[1], status: number, why: RegExp, agent = AGENT) =>
			assert.throws(() => r.watches.request(agent, raw), (error: unknown) => error instanceof WatchError && error.status === status && why.test(error.message), JSON.stringify(raw));
		refused({ repository: "nope", number: 7 }, 400, /owner\/name/);
		refused({ repository: "a/b", number: 0 }, 400, /number/);
		refused({ repository: "a/b", number: "7" }, 400, /number/);
		refused({ repository: "a/b" }, 400, /number/);
		refused({ url: "http://github.com/a/b/pull/7" }, 400, /https address/);
		refused({ url: "https://github.com/a/b/issues/7" }, 400, /https address/);
		refused({ url: "https://github.com/a/b/pull/7", number: 7 }, 400, /either url or/);
		refused({ repository: "a/b", number: 1 }, 400, /not valid/, "stranger");
		for (const n of [1, 2, 3]) r.watches.request(AGENT, { repository: "a/b", number: n });
		refused({ repository: "a/b", number: 4 }, 429, /3 watches are active/);
		assert.doesNotThrow(() => r.watches.request(AGENT, { repository: "a/b", number: 3 }), "a renewal needs no free slot");
		r.watches.cancel(AGENT, "a/b#1");
		assert.doesNotThrow(() => r.watches.request(AGENT, { repository: "a/b", number: 4 }), "an ended watch frees its slot");
		r.done();
	});

	it("refuses two agent ids that would share one topic", () => {
		const r = rig();
		r.watches.request("agent/a-b", { repository: "a/b", number: 1 });
		assert.throws(() => r.watches.request("agent/a.b", { repository: "a/b", number: 2 }), (error: unknown) => error instanceof WatchError && error.status === 409);
		assert.equal(watchTopic("github", "agent/a.b"), watchTopic("github", "agent/a-b"));
		r.done();
	});

	it("changes nothing when a publish fails, so a retry delivers once", async () => {
		const r = rig();
		const { watch } = r.watches.request(AGENT, { repository: "visma/repo", number: 7 });
		r.failures.next = 1;
		await assert.rejects(r.relay(pr("merged", "d1")));
		assert.equal(r.watches.list(AGENT)[0]!.status, "active", "not ended by a delivery that failed");
		await r.relay(pr("merged", "d1"));
		assert.equal(r.published.length, 1);
		assert.equal(r.published[0]!.event.key, `github:watch:${watch.id}:d1`);
		assert.equal(r.watches.list(AGENT)[0]!.status, "ended");
		r.done();
	});

	it("is configured only on a source with a mapping and a producer", () => {
		assert.deepEqual(configOf(), { source: "github", maxPerAgent: 50 });
		assert.throws(() => parseConfig({ ...base, sources: [github], watches: { source: "jira" } }), /watches.source/);
		assert.throws(() => parseConfig({ ...base, sources: [github], watches: { maxPerAgent: 0 } }), /maxPerAgent/);
		assert.throws(() => parseConfig({ ...base, watches: {} }), /watches.source/);
	});
});

describe("watching over HTTP and through the pipeline", () => {
	const worlds: World[] = [];
	const servers: ReturnType<typeof createHubServer>[] = [];
	afterEach(async () => {
		for (const server of servers.splice(0)) await new Promise((r) => { server.closeAllConnections(); server.close(r); });
		for (const w of worlds.splice(0)) {
			await w.hub.stop().catch(() => {});
			await w.stop();
		}
	});
	const start = async () => {
		const w = await startWorld({ watches: {} });
		worlds.push(w);
		const server = createHubServer(w.hub, w.store, SECRET);
		servers.push(server);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-somework-agent": AGENT, authorization: `Bearer ${watchToken(SECRET, AGENT)}` }) =>
			fetch(`${base}${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
		return { w, call };
	};
	const webhook = (event: string, delivery: string, body: object): RawItem => ({
		id: delivery,
		source: "github",
		receivedAt: "2026-10-13T08:00:00Z",
		headers: { "x-github-event": event, "x-github-delivery": delivery },
		body: Buffer.from(JSON.stringify(body)),
		path: "",
		query: "",
	});
	const topicsOf = (w: World) => w.domain.calls.map((c) => c.body.topic as string);

	it("takes a watch with the agent's own token, with no list of agents, and relays a review to the domain as the github producer", async () => {
		const { w, call } = await start();
		const created = await call("POST", "/v1/watches", { repository: "o/r", number: 7 });
		assert.equal(created.status, 201);
		const body = (await created.json()) as { id: string; topic: string; note: string };
		assert.equal(body.topic, "github.watch.aikido_fixer.event");
		assert.match(body.note, /rule in git/);
		assert.equal((await call("POST", "/v1/watches", { repository: "o/r", number: 7 })).status, 200, "a renewal");
		const outcome = await w.hub.process(
			webhook("pull_request_review", "dlv-1", { action: "submitted", review: { id: 5, state: "APPROVED", user: { login: "bo" }, body: "ship it" }, pull_request: { number: 7, title: "Fix" }, repository: { full_name: "o/r" }, sender: { login: "bo" } }),
		);
		assert.deepEqual(outcome, { kind: "published", events: 1, duplicates: 0 });
		assert.deepEqual(topicsOf(w), ["github.pull_request_review.submitted", "github.watch.aikido_fixer.event"]);
		assert.ok(w.domain.calls.every((c) => c.issuer === "service:producer/github"));
		const watched = w.domain.calls[1]!.body;
		assert.equal(watched.key, `github:watch:${body.id}:dlv-1`);
		assert.equal(watched.data.watchId, body.id);
		assert.equal(watched.data.event.sender, "bo");
		assert.equal(watched.data.event.review.state, "approved");
		await w.hub.process(webhook("pull_request_review", "dlv-1", { action: "submitted", review: { id: 5, state: "APPROVED", user: { login: "bo" } }, pull_request: { number: 7 }, repository: { full_name: "o/r" } }));
		assert.equal(w.domain.uniqueEvents, 2, "a redelivery is the same two events");
		assert.match(w.hub.metrics.render(), /hub_watch_events_total\{agent="agent\/aikido-fixer"\} 2/);
	});

	it("lists and cancels over HTTP, by id or by owner/name#number", async () => {
		const { call } = await start();
		const { id } = (await (await call("POST", "/v1/watches", { url: "https://github.com/o/r/pull/7" })).json()) as { id: string };
		await call("POST", "/v1/watches", { repository: "o/r", number: 8 });
		const listed = ((await (await call("GET", "/v1/watches")).json()) as { watches: { number: number; status: string }[] }).watches;
		assert.deepEqual(listed.map((x) => [x.number, x.status]), [[7, "active"], [8, "active"]]);
		assert.equal((await call("DELETE", `/v1/watches/${id}`)).status, 200);
		assert.equal((await call("DELETE", `/v1/watches/${encodeURIComponent("o/r#8")}`)).status, 200);
		assert.equal((await call("DELETE", `/v1/watches/${id}`)).status, 404);
	});

	it("refuses a missing, wrong or another agent's token", async () => {
		const { call } = await start();
		const body = { repository: "o/r", number: 7 };
		assert.equal((await call("POST", "/v1/watches", body, {})).status, 401);
		assert.equal((await call("POST", "/v1/watches", body, { "x-somework-agent": AGENT, authorization: "Bearer nope" })).status, 401);
		assert.equal((await call("POST", "/v1/watches", body, { "x-somework-agent": AGENT, authorization: `Bearer ${watchToken(SECRET, OTHER)}` })).status, 401, "claiming another agent's id needs its token");
		assert.equal((await call("POST", "/v1/watches", body, { "x-somework-agent": OTHER, authorization: `Bearer ${watchToken(SECRET, OTHER)}` })).status, 201, "any agent with its own token, no list");
	});

	it("answers a bad request with its reason", async () => {
		const { call } = await start();
		const refused = await call("POST", "/v1/watches", { repository: "o/r", number: -1 });
		assert.equal(refused.status, 400);
		assert.match(((await refused.json()) as { error: string }).error, /number/);
	});

	it("is not there when the hub has no watches", async () => {
		const w = await startWorld();
		worlds.push(w);
		const server = createHubServer(w.hub, w.store, SECRET);
		servers.push(server);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/watches`, { headers: { "x-somework-agent": AGENT, authorization: `Bearer ${watchToken(SECRET, AGENT)}` } });
		assert.equal(response.status, 404);
	});
});
