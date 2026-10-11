import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { InboxReader, Notifications } from "../src/notifier.ts";
import { isSetupMessage } from "../src/setup/intake.ts";
import { parseOverride, sha256Hex } from "../src/setup/contract.ts";
import { build, OWNER } from "./events-helpers.ts";
import { hashOf, override, rig, setupMessage, skill, stdioEntry } from "./setup-helpers.ts";

const acks = (r: Awaited<ReturnType<typeof rig>>) => r.domain.sentMessages.filter((m) => m.type === "chat.notice");

test("a document from Operations is downloaded, verified, applied and acknowledged to the sender", async () => {
	const r = await rig();
	const document = override({ revision: 3, instructions: "Be brief.", model: { provider: "openai-codex", modelId: "gpt-5.5" } });
	const message = setupMessage(r.domain, document, { senderDomain: "development" });
	await r.intake.handle(message);
	assert.equal(r.store.status.override?.revision, 3);
	assert.equal(r.store.status.override?.hash, hashOf(parseOverride(document, "agent/manager")));
	assert.equal(r.restarts.length, 1, "Pi is asked to start again with it");
	assert.match(r.restarts[0]!.addendum ?? "", /Be brief\./);
	assert.deepEqual(r.restarts[0]!.model, { provider: "openai-codex", modelId: "gpt-5.5" });
	assert.equal(acks(r).length, 1);
	const ack = acks(r)[0]!;
	assert.equal(ack.to, "operations");
	assert.equal(ack.recipientKind, "service");
	assert.equal(ack.triggerMode, "never");
	assert.equal(ack.replyTo, message.messageId);
	assert.equal(ack.conversationId, "conv_setup");
	assert.deepEqual(ack.labels, { "setup.ack": "3", "setup.status": "applied", "setup.kind": "override" });
	assert.equal(ack.idempotencyKey, "setup-ack:agent/manager:override:3:applied");
	assert.match(ack.text, /^Applied override revision 3;/);
});

test("a sender other than the operations principal is ignored and logged, and nothing is applied or answered", async () => {
	const r = await rig();
	for (const sender of [{ from: "operations", senderKind: "service", senderDomain: "other-domain" }, { from: "agent/reviewer", senderKind: "agent" }, { from: "operations", senderKind: "agent" }, { from: "operations", senderKind: undefined }, { from: "someone", senderKind: "service" }]) {
		await r.intake.handle(setupMessage(r.domain, override(), sender));
	}
	assert.equal(r.store.status.override, null);
	assert.equal(r.restarts.length, 0);
	assert.equal(r.domain.sentMessages.length, 0, "not even an acknowledgement");
	assert.equal(r.logs.filter((entry) => entry.event === "setup_ignored").length, 5);
	assert.equal(r.store.status.rejected, undefined);
});

test("a setup message never reaches the owner or the model, whoever sent it: the inbox takes it before it can become chat", async () => {
	const b = build();
	const r = await rig();
	const good = setupMessage(r.domain, override({ revision: 2 }));
	const forged = setupMessage(r.domain, override({ revision: 9 }), { from: "agent/evil", senderKind: "agent" });
	b.domain.unread = [good, forged];
	b.domain.artifacts = r.domain.artifacts;
	const notifications = new Notifications();
	let forwarded = 0;
	notifications.onMessage(async () => void forwarded++);
	const inbox = new InboxReader(b.domain, notifications, { claims: isSetupMessage, handle: (message) => r.intake.handle(message) });
	await inbox.drain();
	assert.equal(forwarded, 0);
	assert.deepEqual(b.domain.read, [good.messageId, forged.messageId], "both are marked read");
	assert.equal(r.store.status.override?.revision, 2);
	assert.equal(b.telegram.texts().length, 0);
	assert.equal(b.rpcCalls.length, 0);
	const seen: any = await b.service.inbox({});
	assert.equal(seen.messages.length, 0, "the model's inbox tool does not list them either");
	void OWNER;
});

test("a document that does not match its SHA-256 is rejected, reported, and the earlier setup stays", async () => {
	const r = await rig();
	await r.intake.handle(setupMessage(r.domain, override({ revision: 1, instructions: "first" })));
	await r.intake.handle(setupMessage(r.domain, override({ revision: 2, instructions: "second" }), { sha256: sha256Hex("something else") }));
	assert.equal(r.store.status.override?.revision, 1);
	assert.equal(r.store.override?.instructions, "first");
	assert.equal(r.restarts.length, 1);
	assert.equal(r.store.status.rejected?.revision, 2);
	assert.match(r.store.status.rejected?.reason ?? "", /SHA-256|setup\.sha256/);
	const ack = acks(r).at(-1)!;
	assert.equal(ack.labels["setup.status"], "rejected");
	assert.match(ack.text, /^Rejected override revision 2: .*setup\.sha256/);
});

test("rejected documents: not JSON, wrong agent, revision that disagrees with the label, no artifact, unreadable artifact", async () => {
	const r = await rig();
	const cases: [string, ReturnType<typeof setupMessage>, RegExp][] = [
		["wrong agent", setupMessage(r.domain, override({ agent: "agent/reviewer" })), /agent\/reviewer/],
		["label revision", setupMessage(r.domain, override({ revision: 4 }), { revision: 5 }), /revision 4/],
		["no artifact", { ...setupMessage(r.domain, override()), artifacts: [] }, /no application\/json artifact/],
		["missing artifact", { ...setupMessage(r.domain, override()), artifacts: [{ artifactId: "nope" }] }, /could not be downloaded/],
		["bad document", setupMessage(r.domain, { schema: 2 }), /not a setup override/],
	];
	for (const [name, message, reason] of cases) {
		await r.intake.handle(message);
		assert.match(r.store.status.rejected?.reason ?? "", reason, name);
	}
	const notJson = setupMessage(r.domain, override());
	r.domain.artifacts[(notJson.artifacts![0] as any).artifactId] = Buffer.from("{nope");
	notJson.labels["setup.sha256"] = sha256Hex("{nope");
	await r.intake.handle(notJson);
	assert.match(r.store.status.rejected?.reason ?? "", /not valid JSON/);
	assert.equal(r.store.status.override, null);
	assert.equal(r.restarts.length, 0);
});

test("the document may name the Manager by its short name", async () => {
	const r = await rig();
	await r.intake.handle(setupMessage(r.domain, override({ agent: "manager" })));
	assert.equal(r.store.status.override?.revision, 1);
});

test("an artifact above 2 MiB is not taken", async () => {
	const r = await rig();
	const message = setupMessage(r.domain, override());
	r.domain.artifacts[(message.artifacts![0] as any).artifactId] = Buffer.alloc(2 * 1024 * 1024 + 1);
	await r.intake.handle(message);
	assert.match(r.store.status.rejected?.reason ?? "", /could not be downloaded/);
});

test("a stale revision is acknowledged and ignored; an equal one too", async () => {
	const r = await rig();
	await r.intake.handle(setupMessage(r.domain, override({ revision: 5, instructions: "five" })));
	await r.intake.handle(setupMessage(r.domain, override({ revision: 4, instructions: "four" })));
	await r.intake.handle(setupMessage(r.domain, override({ revision: 5, instructions: "five again" })));
	assert.equal(r.store.override?.instructions, "five");
	assert.equal(r.restarts.length, 1, "nothing was applied again");
	assert.equal(acks(r).length, 3);
	assert.match(acks(r)[1]!.text, /revision 4 was not applied: revision 5 is already applied/);
	assert.equal(acks(r)[1]!.labels["setup.status"], "rejected");
	assert.equal(r.store.status.rejected, undefined, "a stale message is not a rejection of the setup");
	assert.equal(acks(r)[2]!.labels["setup.ack"], "5");
});

test("a message the feed delivers twice at the same time applies once", async () => {
	const r = await rig();
	const message = setupMessage(r.domain, override({ revision: 2 }));
	await Promise.all([r.intake.handle(message), r.intake.handle(message)]);
	assert.equal(r.restarts.length, 1);
	assert.equal(acks(r).length, 2);
});

test("a later document that applies clears the rejection", async () => {
	const r = await rig();
	await r.intake.handle(setupMessage(r.domain, override({ revision: 1, mcp: [stdioEntry("tool", { secrets: ["TOOL_TOKEN"] })] })));
	assert.match(r.store.status.rejected?.reason ?? "", /TOOL_TOKEN/);
	await r.intake.handle(setupMessage(r.domain, override({ revision: 2 })));
	assert.equal(r.store.status.rejected, undefined);
	assert.equal(r.store.status.override?.revision, 2);
});

test("fleet limits are taken the same way, with their own revision", async () => {
	const r = await rig();
	const limits = { schema: 1, kind: "limits", revision: 7, savedBy: "admin", savedAt: "2026-10-10T12:00:00Z", maxTokensCap: 1000, maxMinutesCap: 10, dailyTokenLimit: 5000, budgetRaiseCeiling: 100 };
	await r.intake.handle(setupMessage(r.domain, limits, { kind: "limits" }));
	assert.equal(r.store.status.limits?.revision, 7);
	assert.equal(r.store.status.override, null);
	assert.equal(r.restarts.length, 0, "limits never restart Pi");
	assert.equal(acks(r)[0]!.labels["setup.kind"], "limits");
	await r.intake.handle(setupMessage(r.domain, { ...limits, revision: 6 }, { kind: "limits" }));
	assert.equal(r.store.status.limits?.revision, 7);
	await r.intake.handle(setupMessage(r.domain, { ...limits, maxTokensCap: 0, revision: 8 }, { kind: "limits" }));
	assert.match(r.store.status.rejected?.reason ?? "", /maxTokensCap/);
});

test("the accepted documents survive a restart and are applied at start", async () => {
	const first = await rig({ env: { TOOL_TOKEN: "x" } });
	const document = override({ revision: 6, instructions: "Keep it short.", model: { provider: "openai-codex", modelId: "gpt-5.5" }, skills: { library: [skill("triage")], overlays: {} }, mcp: [stdioEntry("tool", { secrets: ["TOOL_TOKEN"], env: { TOKEN: "${TOOL_TOKEN}" } })], approvalPatterns: [{ pattern: "git push", reason: "pushes" }] });
	await first.intake.handle(setupMessage(first.domain, document));
	await first.intake.handle(setupMessage(first.domain, { schema: 1, kind: "limits", revision: 2, savedBy: "a", savedAt: "", maxTokensCap: 1, maxMinutesCap: 1, dailyTokenLimit: 1, budgetRaiseCeiling: 1 }, { kind: "limits" }));

	const second = await rig({ dir: first.dir, env: { TOOL_TOKEN: "x" } });
	assert.equal(second.store.override?.revision, 6, "read back from the state directory");
	const launch = await second.applier.restore();
	assert.equal(second.store.status.override?.revision, 6);
	assert.equal(second.store.status.override?.hash, hashOf(parseOverride(document, "agent/manager")));
	assert.equal(second.store.status.limits?.revision, 2);
	assert.match(launch.addendum ?? "", /Keep it short\./);
	assert.deepEqual(launch.secrets, ["TOOL_TOKEN"]);
	assert.deepEqual(second.rules.settings().patterns, [{ pattern: "git push", reason: "pushes" }]);
	assert.ok(JSON.parse(await readFile(join(second.agentDir, "mcp.json"), "utf8")).mcpServers.tool);
	await second.intake.handle(setupMessage(second.domain, { ...document, revision: 6 }));
	assert.equal(second.restarts.length, 0, "the same revision after a restart is stale, not applied again");
});

test("a saved setup that cannot be applied at start is reported rejected and Pi starts without it", async () => {
	const first = await rig({ env: { TOOL_TOKEN: "x" } });
	await first.intake.handle(setupMessage(first.domain, override({ revision: 2, instructions: "x", mcp: [stdioEntry("tool", { secrets: ["TOOL_TOKEN"] })] })));
	const second = await rig({ dir: first.dir, env: {} });
	const launch = await second.applier.restore();
	assert.deepEqual(launch, { secrets: [] });
	assert.equal(second.store.status.override, null);
	assert.match(second.store.status.rejected?.reason ?? "", /could not be applied at start.*TOOL_TOKEN/);
});
