import assert from "node:assert/strict";
import test from "node:test";
import { addendumPrompt, noOperatorSetup, piArguments } from "../src/pi-process.ts";
import { describeManager } from "../src/setup/profile.ts";
import { override, rig, setupMessage } from "./setup-helpers.ts";

const BASELINE = { provider: "openai-codex", modelId: "gpt-5.5" };
const SOL = { provider: "openai-codex", modelId: "gpt-6.1-sol" };
const limits = (revision: number, extra: Record<string, unknown> = {}) => ({ schema: 1, kind: "limits", revision, savedBy: "admin", savedAt: "2026-10-12T12:00:00Z", maxTokensCap: 1000, maxMinutesCap: 10, dailyTokenLimit: 5000, budgetRaiseCeiling: 100, ...extra });
const deliverLimits = (r: Awaited<ReturnType<typeof rig>>, revision: number, extra: Record<string, unknown> = {}) => r.intake.handle(setupMessage(r.domain, limits(revision, extra), { kind: "limits" }));
const deliverOverride = (r: Awaited<ReturnType<typeof rig>>, revision: number, extra: Record<string, unknown> = {}) => r.intake.handle(setupMessage(r.domain, override({ revision, ...extra })));
const lastAck = (r: Awaited<ReturnType<typeof rig>>) => r.domain.sentMessages.at(-1)!;

test("Pi is started with its thinking level when one is set, right after the model, and without one otherwise", () => {
	const args = piArguments(["a.yaml"], "/s/session.jsonl", { model: SOL, thinking: "high", secrets: [] });
	assert.deepEqual(args.slice(args.indexOf("--model")), ["--model", "openai-codex/gpt-6.1-sol", "--thinking", "high"]);
	const effortOnly = piArguments(["a.yaml"], "/s", { thinking: "xhigh", secrets: [] });
	assert.deepEqual(effortOnly.slice(effortOnly.indexOf("--thinking")), ["--thinking", "xhigh"]);
	assert.ok(!effortOnly.includes("--model"));
	assert.ok(!piArguments(["a.yaml"], "/s", noOperatorSetup).includes("--thinking"));
	assert.ok(!piArguments(["a.yaml"], "/s", { model: SOL, secrets: [] }).includes("--thinking"), "an effort nobody sets leaves Pi's own default");
});

test("an override that sets only an effort keeps the model Pi ran with before any setup", async () => {
	const r = await rig();
	await r.store.rememberBaselineModel(BASELINE);
	await deliverOverride(r, 1, { model: { effort: "high" } });
	assert.deepEqual(r.restarts[0], { model: BASELINE, thinking: "high", secrets: [] });
	assert.equal(r.store.status.override?.revision, 1);
});

test("an override that names provider, model and effort sets all three", async () => {
	const r = await rig();
	await deliverOverride(r, 1, { instructions: "Be brief.", model: { ...SOL, effort: "max" } });
	assert.deepEqual(r.restarts[0]!.model, SOL);
	assert.equal(r.restarts[0]!.thinking, "max");
	assert.equal(r.restarts[0]!.addendum, addendumPrompt(1, "Be brief."));
});

test("the fleet's model reaches Pi and keeps the rest of the setup, and a limits document that changes nothing about it restarts nothing", async () => {
	const r = await rig();
	await r.store.rememberBaselineModel(BASELINE);
	await deliverOverride(r, 1, { instructions: "Stay." });
	assert.equal(r.restarts.length, 1);
	await deliverLimits(r, 1, { model: { ...SOL, effort: "high" } });
	assert.equal(r.restarts.length, 2);
	assert.deepEqual(r.restarts[1], { addendum: addendumPrompt(1, "Stay."), model: SOL, thinking: "high", secrets: [] });
	assert.equal(r.store.status.limits?.revision, 1);
	await deliverLimits(r, 2, { model: { ...SOL, effort: "high" }, maxMinutesCap: 99 });
	assert.equal(r.restarts.length, 2, "only the model decides whether Pi restarts for limits");
	await deliverLimits(r, 3);
	assert.deepEqual(r.restarts[2], { addendum: addendumPrompt(1, "Stay."), model: BASELINE, secrets: [] }, "withdrawing the fleet's model puts back what Pi ran with");
});

test("the override replaces single parts of the fleet's model and inherits the rest", async () => {
	const r = await rig();
	await r.store.rememberBaselineModel(BASELINE);
	await deliverLimits(r, 1, { model: { ...SOL, effort: "high" } });
	await deliverOverride(r, 1, { model: { effort: "max" } });
	assert.deepEqual(r.restarts.at(-1), { model: SOL, thinking: "max", secrets: [] });
	await deliverOverride(r, 2, { model: { modelId: "gpt-6-luna" } });
	assert.deepEqual(r.restarts.at(-1), { model: { provider: "openai-codex", modelId: "gpt-6-luna" }, thinking: "high", secrets: [] });
	await deliverOverride(r, 3);
	assert.deepEqual(r.restarts.at(-1), { model: SOL, thinking: "high", secrets: [] }, "a reset goes back to the fleet's model, not past it");
});

test("a model that names only a provider cannot be completed before Pi's own model is known, and is rejected with the reason", async () => {
	const r = await rig();
	await deliverOverride(r, 1, { model: { provider: "opencode-go" } });
	assert.equal(r.restarts.length, 0);
	assert.equal(r.store.status.override, null);
	assert.match(r.store.status.rejected!.reason, /only a provider or only a model id/);
	assert.match(lastAck(r).text, /Rejected override revision 1/);
	await r.store.rememberBaselineModel(BASELINE);
	await deliverOverride(r, 2, { model: { provider: "opencode-go" } });
	assert.deepEqual(r.restarts[0]!.model, { provider: "opencode-go", modelId: "gpt-5.5" }, "once the baseline is known the other part is taken from it");
});

test("a fleet model that cannot be completed is rejected and the earlier limits stay", async () => {
	const r = await rig();
	await deliverLimits(r, 1);
	await deliverLimits(r, 2, { model: { modelId: "gpt-6.1-sol" } });
	assert.equal(r.store.status.limits?.revision, 1);
	assert.match(r.store.status.rejected!.reason, /only a provider or only a model id/);
	assert.equal(r.restarts.length, 0);
});

test("after a restart the saved fleet model and override are put to work together", async () => {
	const first = await rig();
	await first.store.rememberBaselineModel(BASELINE);
	await deliverLimits(first, 1, { model: { ...SOL, effort: "high" } });
	await deliverOverride(first, 1, { instructions: "Stay.", model: { effort: "xhigh" } });
	const second = await rig({ dir: first.dir });
	const launch = await second.applier.restore();
	assert.deepEqual(launch, { addendum: addendumPrompt(1, "Stay."), model: SOL, thinking: "xhigh", secrets: [] });
	const onlyFleet = await rig();
	await onlyFleet.store.rememberBaselineModel(BASELINE);
	await deliverLimits(onlyFleet, 1, { model: { effort: "low" } });
	const third = await rig({ dir: onlyFleet.dir });
	assert.deepEqual(await third.applier.restore(), { model: BASELINE, thinking: "low", secrets: [] });
});

test("/profile tells the thinking level Pi runs with as the effort of the model", async () => {
	const made = await rig();
	const described = describeManager({ agentId: "agent/manager", override: undefined, status: made.store.status, rules: made.rules, model: { ...SOL, effort: "high" }, restartPending: false });
	assert.deepEqual(described.model, { ...SOL, effort: "high", allowed: [] });
	const plain = describeManager({ agentId: "agent/manager", override: undefined, status: made.store.status, rules: made.rules, model: SOL, restartPending: false });
	assert.deepEqual(plain.model, { ...SOL, allowed: [] });
	assert.notEqual(described.hash, plain.hash);
});
