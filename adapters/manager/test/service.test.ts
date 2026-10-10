import assert from "node:assert/strict";
import test from "node:test";
import { ControlRequests, Controls } from "../src/controls.ts";
import { defaultPolicy, PolicyError, RateLimiter } from "../src/policy.ts";
import { ManagerService } from "../src/service.ts";
import { FakeDomain } from "./helpers.ts";

function setup(overrides: { now?: () => number; policy?: Partial<typeof defaultPolicy>; unreachable?: boolean } = {}) {
	const domain = new FakeDomain();
	const told: string[] = [];
	const owner = {
		tell: async (text: string) => {
			if (overrides.unreachable) throw new Error("owner not paired");
			told.push(text);
			return told.length;
		},
	};
	const controls = new Controls({ domain, state: {}, save: async () => {}, config: { agentHealth: {} } });
	const service = new ManagerService({ domain, policy: { ...defaultPolicy, ...overrides.policy }, owner, controls, now: overrides.now });
	return { domain, told, service };
}

test("the rate limiter slides", () => {
	let clock = 0;
	const limiter = new RateLimiter(2, 1000, () => clock);
	assert.deepEqual([limiter.take(), limiter.take(), limiter.take()], [true, true, false]);
	clock = 1001;
	assert.equal(limiter.take(), true);
});

test("messages are length and rate limited", async () => {
	const { service, domain } = setup({ policy: { messagesPerHour: 1 } });
	await assert.rejects(service.message({ to: "agent/x", text: "x".repeat(9000) }), (e: PolicyError) => e.status === 413);
	await service.message({ to: "agent/reviewer", text: "hello" });
	assert.equal(domain.sentMessages.length, 1);
	await assert.rejects(service.message({ to: "agent/reviewer", text: "again" }), (e: PolicyError) => e.status === 429);
});

test("a message needs a recipient and a text", async () => {
	const { service, domain } = setup();
	await assert.rejects(service.message({ to: "", text: "hello" }), (e: PolicyError) => e.code === "invalid_request");
	await assert.rejects(service.message({ to: "agent/reviewer", text: "" }), (e: PolicyError) => e.code === "invalid_request");
	assert.equal(domain.sentMessages.length, 0);
});

test("a switch the model asks for waits for the owner, and nothing changes before they confirm", async () => {
	const { service, domain, told } = setup();
	domain.rules = [{ name: "r1", description: "", owner: "agent/manager", selector: "x.y.z", wake: true, status: "active", lastFiredAt: null, counters: { fired: 0, skipped: {} } }];
	const answer: any = await service.controlRequest({ action: "pause_rule", rule: "r1" });
	assert.equal(answer.status, "awaiting_owner");
	assert.match(told[0]!, /Confirmation c[0-9a-f]{8} needed/);
	assert.deepEqual(domain.rulesPaused, []);
	assert.equal(service.pendingRequests(), 1);
	const approved = await service.approve(answer.requestId);
	assert.equal(approved.ok, true);
	assert.deepEqual(domain.rulesPaused, ["r1"]);
	assert.equal((await service.approve(answer.requestId)).ok, false, "a confirmation is single use");
	assert.equal(service.pendingRequests(), 0);
});

test("a denied or expired switch never runs, and an id that is not a request is refused", async () => {
	let clock = 1_000_000;
	const { service, domain } = setup({ now: () => clock });
	domain.rules = [{ name: "r1", description: "", owner: "agent/manager", selector: "x.y.z", wake: true, status: "active", lastFiredAt: null, counters: { fired: 0, skipped: {} } }];
	const first: any = await service.controlRequest({ action: "pause_rule", rule: "r1" });
	assert.equal((await service.denyAny(first.requestId)).ok, true);
	assert.equal((await service.approve(first.requestId)).ok, false);
	const second: any = await service.controlRequest({ action: "pause_rule", rule: "r1" });
	clock += defaultPolicy.approvalTtlMs;
	assert.equal((await service.approve(second.requestId)).ok, false);
	assert.equal((await service.approve("a00000000")).ok, false);
	assert.deepEqual(domain.rulesPaused, []);
});

test("when the owner cannot be asked nothing is requested", async () => {
	const { service } = setup({ unreachable: true });
	await assert.rejects(service.controlRequest({ action: "pause_rule", rule: "r1" }), (error: PolicyError) => error.code === "owner_unreachable" && error.status === 503);
});

test("control requests expire by themselves", () => {
	let clock = 0;
	const controls = new Controls({ domain: new FakeDomain(), state: {}, save: async () => {}, config: { agentHealth: {} } });
	const requests = new ControlRequests(controls, 1000, () => clock);
	const request = requests.create({ action: "pause_rule", rule: "r1" });
	assert.equal(requests.pending().length, 1);
	clock = 1000;
	assert.equal(requests.get(request.id)?.status, "expired");
	assert.equal(requests.pending().length, 0);
});

test("the catalog is advertisement only: capabilities with their description and schema, no side-effect class", async () => {
	const { service } = setup();
	const { results } = (await service.catalog("review")) as { results: { agentId: string; capability: Record<string, unknown> }[] };
	assert.equal(results[0]!.agentId, "agent/reviewer");
	assert.equal(results[0]!.capability.description, "reviews a branch");
	assert.ok(!("sideEffects" in results[0]!.capability));
});

test("the catalog lists the highest version of a capability first and marks it", async () => {
	const { domain, service } = setup();
	domain.searchCatalog = async () => ({
		matches: [
			{ agentId: "agent/reviewer-old", availability: "online", matchedCapabilities: [{ id: "code.review", version: "2" }] },
			{ agentId: "agent/reviewer", availability: "online", matchedCapabilities: [{ id: "code.review", version: "10" }, { id: "code.review", version: "3" }] },
			{ agentId: "agent/fixer", availability: "online", matchedCapabilities: [{ id: "code.fix", version: "1" }] },
		],
	});
	domain.capabilities = { "code.review@2": {}, "code.review@3": {}, "code.review@10": {}, "code.fix@1": {} };
	const { results } = (await service.catalog("review")) as { results: { agentId: string; capability: { id: string; version: string }; latest: boolean }[] };
	assert.deepEqual(results.map((r) => `${r.capability.id}@${r.capability.version}${r.latest ? "*" : ""}`), ["code.review@10*", "code.review@3", "code.review@2", "code.fix@1*"]);
});
