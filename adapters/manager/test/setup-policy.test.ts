import assert from "node:assert/strict";
import test from "node:test";
import { Controls } from "../src/controls.ts";
import { registerApprovalGate, type GateHost } from "../extension/tools.ts";
import { createGateway } from "../src/gateway.ts";
import { ApprovalGrants, ApprovalRules, defaultPolicy } from "../src/policy.ts";
import { ManagerService } from "../src/service.ts";
import { build } from "./events-helpers.ts";
import { httpEntry, override, rig, setupMessage, stdioEntry } from "./setup-helpers.ts";

test("approval patterns replace the Manager's own list, and an empty list removes it", async () => {
	const r = await rig();
	assert.equal(r.rules.reasonFor({ kind: "bash", command: "git push origin main" }), undefined, "the Manager's default asks about nothing");
	await r.intake.handle(setupMessage(r.domain, override({ revision: 1, approvalPatterns: [{ pattern: "^git push", reason: "publishing" }, { pattern: "rm -rf", reason: "deleting" }] })));
	assert.equal(r.rules.reasonFor({ kind: "bash", command: "git push origin main" }), "publishing");
	assert.equal(r.rules.reasonFor({ kind: "bash", command: "ls" }), undefined);
	await r.intake.handle(setupMessage(r.domain, override({ revision: 2, approvalPatterns: [{ pattern: "curl", reason: "network" }] })));
	assert.equal(r.rules.reasonFor({ kind: "bash", command: "git push" }), undefined, "replaced, not added to");
	assert.equal(r.rules.reasonFor({ kind: "bash", command: "curl x" }), "network");
	await r.intake.handle(setupMessage(r.domain, override({ revision: 3, approvalPatterns: [] })));
	assert.equal(r.rules.reasonFor({ kind: "bash", command: "curl x" }), undefined);
	assert.deepEqual(r.rules.settings(), { patterns: [], mcp: {} });
});

test("the approval setting of an MCP entry decides which of its calls ask the owner", async () => {
	const r = await rig();
	await r.intake.handle(setupMessage(r.domain, override({ mcp: [stdioEntry("jira-tools", { approval: "ask" }), httpEntry("docs", { approval: "writes" }), httpEntry("wiki", { approval: "never" })] })));
	const call = (tool: string, readOnly = false) => r.rules.reasonFor({ kind: "mcp", tool, input: "{}", readOnly });
	assert.match(call("mcp__jira_tools__search", true) ?? "", /every call/, "Pi writes the server's - as _");
	assert.equal(call("mcp__docs__read", true), undefined);
	assert.match(call("mcp__docs__update") ?? "", /not read-only/);
	assert.equal(call("mcp__wiki__update"), undefined);
	assert.equal(call("mcp__other__update"), undefined, "a server the setup does not name is not Operations' business");
});

test("a pattern that is not a regular expression leaves the earlier rules in place", () => {
	const rules = new ApprovalRules();
	rules.replace({ patterns: [{ pattern: "ls", reason: "x" }], mcp: {} });
	assert.throws(() => rules.replace({ patterns: [{ pattern: "(", reason: "bad" }], mcp: {} }));
	assert.equal(rules.reasonFor({ kind: "bash", command: "ls" }), "x");
});

function wired() {
	const b = build();
	const rules = new ApprovalRules();
	const grants = new ApprovalGrants();
	rules.replace({ patterns: [{ pattern: "^git push", reason: "publishing needs the owner" }], mcp: { docs: "ask" } });
	const controls = new Controls({ domain: b.domain, state: b.state, save: async () => {}, config: { agentHealth: {} }, grants: { store: grants, ttlMs: 60_000 } });
	const service = new ManagerService({ domain: b.domain, policy: defaultPolicy, owner: b.bridge, controls, approvals: { rules, grants } });
	return { ...b, rules, grants, service };
}

test("a call the rules cover waits for the owner; their confirmation lets exactly that call through once", async () => {
	const w = wired();
	assert.deepEqual(await w.service.checkCall({ kind: "bash", command: "ls -la" }), { allowed: true });
	const first = await w.service.checkCall({ kind: "bash", command: "git push origin main" });
	assert.equal(first.allowed, false);
	assert.match(first.reason ?? "", /publishing/);
	assert.match(w.telegram.texts().at(-1)!, /git push origin main/);
	const again = await w.service.checkCall({ kind: "bash", command: "git push origin main" });
	assert.equal(again.requestId, first.requestId, "asking again does not ask the owner again");
	assert.equal(w.telegram.texts().length, 1);
	assert.equal((await w.service.checkCall({ kind: "bash", command: "git push origin other" })).allowed, false, "another command is another question");
	assert.equal((await w.service.approve(first.requestId!)).ok, true);
	assert.deepEqual(await w.service.checkCall({ kind: "bash", command: "git push origin main" }), { allowed: true });
	assert.equal((await w.service.checkCall({ kind: "bash", command: "git push origin main" })).allowed, false, "the permission was used up");
});

test("denying leaves the call blocked; MCP calls are asked about with their arguments", async () => {
	const w = wired();
	const asked = await w.service.checkCall({ kind: "mcp", tool: "mcp__docs__update", input: '{"page":1}', readOnly: false });
	assert.equal(asked.allowed, false);
	await w.service.denyAny(asked.requestId!);
	assert.equal((await w.service.checkCall({ kind: "mcp", tool: "mcp__docs__update", input: '{"page":1}', readOnly: false })).allowed, false);
	const second = await w.service.checkCall({ kind: "mcp", tool: "mcp__docs__update", input: '{"page":2}', readOnly: false });
	await w.service.approve(second.requestId!);
	assert.equal((await w.service.checkCall({ kind: "mcp", tool: "mcp__docs__update", input: '{"page":1}', readOnly: false })).allowed, false, "approval is for the arguments that were shown");
	assert.equal((await w.service.checkCall({ kind: "mcp", tool: "mcp__docs__update", input: '{"page":2}', readOnly: false })).allowed, true);
});

test("the model cannot create an allow_call request itself", async () => {
	const w = wired();
	await assert.rejects(w.service.controlRequest({ action: "allow_call", key: "x", summary: "y" }), /action must be/);
});

test("the gateway and the Pi extension gate work together: blocked with a reason the model can act on, allowed after the owner confirms", async () => {
	const w = wired();
	const server = createGateway({ service: w.service, token: "t".repeat(40) });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as any).port}`;
	let handler: any;
	const pi: GateHost = { on: (_event, h) => (handler = h), getAllTools: () => [{ name: "mcp__docs__read", annotations: { readOnlyHint: true } }] };
	registerApprovalGate(pi, { MANAGER_GATEWAY_URL: url, MANAGER_GATEWAY_TOKEN: "t".repeat(40) });
	assert.equal(await handler({ toolName: "read", input: {} }), undefined, "other tools are not asked about");
	assert.equal(await handler({ toolName: "bash", input: { command: "ls" } }), undefined);
	const blocked = await handler({ toolName: "bash", input: { command: "git push origin main" } });
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /needs the owner's approval/);
	const request = w.service.controlRequests!.pending()[0]!;
	await w.service.approve(request.id);
	assert.equal(await handler({ toolName: "bash", input: { command: "git push origin main" } }), undefined);
	assert.equal((await handler({ toolName: "mcp__docs__read", input: {} }))?.block, true, "a server set to ask asks even for a read-only tool");
	server.closeAllConnections();
	server.close();
});
