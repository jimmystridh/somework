import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apply, ApplyRefused } from "../src/apply.ts";
import { asLive, declared, FakeDomain, parse } from "./fake.ts";
import { view } from "./helpers.ts";

const two = parse({ ...declared("a"), ...declared("b") });
const writes = (domain: FakeDomain) => domain.calls.filter((call) => call !== "list");

describe("apply", () => {
	it("creates, then replaces, then deletes, and ends converged", async () => {
		const domain = new FakeDomain([...asLive([two[0]!]).map((rule) => ({ ...rule, selector: "github.pull_request.closed" })), view("old", { owner: "agent/x", selector: "x.y.z", wake: true })]);
		const result = await apply(domain, two);
		assert.deepEqual(writes(domain), ["put b", "put a", "delete old"]);
		assert.equal(result.converged, true);
		assert.deepEqual(result.failures, []);
		assert.deepEqual([...domain.rules.keys()].sort(), ["a", "b"]);
	});

	it("is idempotent: a second apply changes nothing", async () => {
		const domain = new FakeDomain();
		await apply(domain, two);
		domain.calls.length = 0;
		const again = await apply(domain, two);
		assert.deepEqual(writes(domain), []);
		assert.equal(again.converged, true);
	});

	it("never un-pauses a rule whose file has no status, even when it replaces the rule", async () => {
		const domain = new FakeDomain(asLive(two, { status: "paused" }));
		const changed = parse({ ...declared("a", (yaml) => yaml.replace("wake: false", "wake: true")), ...declared("b") });
		const result = await apply(domain, changed);
		assert.equal(domain.rules.get("a")!.status, "paused");
		assert.equal(domain.rules.get("b")!.status, "paused");
		assert.equal(result.converged, true);
		assert.ok(!domain.calls.some((call) => call.startsWith("resume")));
	});

	it("resumes only when the file says status: active", async () => {
		const domain = new FakeDomain(asLive(two, { status: "paused" }));
		const explicit = parse({ ...declared("a", (yaml) => `${yaml}status: active\n`), ...declared("b") });
		await apply(domain, explicit);
		assert.equal(domain.rules.get("a")!.status, "active");
		assert.equal(domain.rules.get("b")!.status, "paused");
	});

	it("corrects the status itself when the domain ignores it on PUT", async () => {
		const domain = new FakeDomain();
		domain.ignoreStatusOnPut = true;
		const paused = parse(declared("a", (yaml) => `${yaml}status: paused\n`));
		const result = await apply(domain, paused);
		assert.deepEqual(writes(domain), ["put a", "pause a"]);
		assert.equal(result.converged, true);
	});

	it("dry run reads but writes nothing", async () => {
		const domain = new FakeDomain();
		const result = await apply(domain, two, { dryRun: true });
		assert.deepEqual(writes(domain), []);
		assert.equal(result.plan.counts.create, 2);
		assert.equal(result.converged, false);
	});

	it("keeps going after one failure, reports it, and is not converged", async () => {
		const domain = new FakeDomain();
		domain.failOn.add("put a");
		const result = await apply(domain, two);
		assert.deepEqual(result.failures.map((failure) => `${failure.action} ${failure.name}`), ["create a"]);
		assert.ok(domain.rules.has("b"));
		assert.equal(result.converged, false);
	});

	it("does not delete anything when a replacement failed (deletes come last, and a failed rule stays)", async () => {
		const domain = new FakeDomain([...asLive([two[0]!]).map((rule) => ({ ...rule, description: "stale" })), view("old", { owner: "agent/x", selector: "x.y.z", wake: true })]);
		domain.failOn.add("put a");
		const result = await apply(domain, two);
		assert.ok(domain.rules.has("a"));
		assert.equal(result.converged, false);
	});

	it("treats a delete of a rule that is already gone as done", async () => {
		const stale = view("old", { owner: "agent/x", selector: "x.y.z", wake: true });
		const domain = new FakeDomain();
		let listed = 0;
		domain.list = async () => (listed++ === 0 ? [stale] : []);
		const result = await apply(domain, [], { allowEmpty: true });
		assert.deepEqual(result.failures, []);
		assert.deepEqual(writes(domain), ["delete old"]);
		assert.equal(result.converged, true);
	});

	it("refuses to wipe the domain when there are no rule files", async () => {
		const domain = new FakeDomain(asLive(two));
		await assert.rejects(apply(domain, []), ApplyRefused);
		assert.deepEqual(writes(domain), []);
		const allowed = await apply(domain, [], { allowEmpty: true });
		assert.equal(allowed.converged, true);
		assert.equal(domain.rules.size, 0);
	});

	it("refuses to delete more than the limit at once unless confirmed", async () => {
		const many = Array.from({ length: 7 }, (_, index) => view(`old${index}`, { owner: "agent/x", selector: "x.y.z", wake: true }));
		const domain = new FakeDomain([...asLive(two), ...many]);
		await assert.rejects(apply(domain, two), /would delete 7 rules \(limit 5\)/);
		assert.equal(domain.rules.size, 9);
		await apply(domain, two, { allowDeleteMany: true });
		assert.equal(domain.rules.size, 2);
	});

	it("leaves undeclared rules alone with prune off", async () => {
		const domain = new FakeDomain([view("old", { owner: "agent/x", selector: "x.y.z", wake: true })]);
		const result = await apply(domain, two, { prune: false });
		assert.ok(domain.rules.has("old"));
		assert.equal(result.converged, true);
	});
});
