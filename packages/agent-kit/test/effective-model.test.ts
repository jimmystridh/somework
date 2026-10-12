import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import { FileCredentialStore } from "../src/credentials.ts";
import { allowlist, type ModelRef } from "../src/providers/allowlist.ts";
import { modelCheck, resolveModel, supportedEfforts, type ModelLayers, type RegistryModel } from "../src/providers/effective-model.ts";
import { registerProviders } from "../src/providers/index.ts";

const REASONING: RegistryModel = { reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" } };
const NO_OFF: RegistryModel = { reasoning: true, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } };
const PLAIN: RegistryModel = { reasoning: false };

const registry: Record<string, RegistryModel> = {
	"openai-codex/gpt-5.5": { reasoning: true, thinkingLevelMap: { xhigh: "xhigh", minimal: "low" } },
	"openai-codex/gpt-6.1-sol": NO_OFF,
	"openai-codex/gpt-6-luna": REASONING,
	"opencode-go/kimi-k3": PLAIN,
};
const DEFAULT: ModelRef = { provider: "openai-codex", modelId: "gpt-5.5" };
const allowed = allowlist(DEFAULT, [
	{ provider: "openai-codex", modelId: "gpt-6.1-sol" },
	{ provider: "openai-codex", modelId: "gpt-6-luna" },
	{ provider: "opencode-go", modelId: "kimi-k3" },
]);
const check = modelCheck({ allowed, find: (provider, modelId) => registry[`${provider}/${modelId}`] });
const resolve = (layers: Partial<ModelLayers>) => resolveModel({ env: DEFAULT, ...layers }, check);
const resolved = (layers: Partial<ModelLayers>) => {
	const result = resolve(layers);
	assert.ok(result.ok, result.ok ? "" : result.reason);
	return result;
};
const refusal = (layers: Partial<ModelLayers>): string => {
	const result = resolve(layers);
	assert.ok(!result.ok, "expected a refusal");
	return result.reason;
};

describe("the effective model, field by field", () => {
	it("is the environment's default, with no effort, when nothing above sets anything", () => {
		const result = resolved({});
		assert.deepEqual(result.model, DEFAULT);
		assert.deepEqual(result.sources, { provider: "env", modelId: "env" });
		assert.equal("effort" in result.model, false, "an effort nobody sets is not passed on");
	});

	it("takes the environment's effort when PI_EFFORT is set", () => {
		const result = resolveModel({ env: { ...DEFAULT, effort: "medium" } }, check);
		assert.ok(result.ok);
		assert.deepEqual(result.model, { ...DEFAULT, effort: "medium" });
		assert.deepEqual(result.sources, { provider: "env", modelId: "env", effort: "env" });
	});

	it("lets each layer replace only the fields it sets and inherit the rest from the layer below", () => {
		const fleet = resolved({ fleet: { effort: "high" } });
		assert.deepEqual(fleet.model, { ...DEFAULT, effort: "high" });
		assert.deepEqual(fleet.sources, { provider: "env", modelId: "env", effort: "fleet" });

		const fleetModel = resolved({ fleet: { provider: "openai-codex", modelId: "gpt-6.1-sol", effort: "high" } });
		assert.deepEqual(fleetModel.model, { provider: "openai-codex", modelId: "gpt-6.1-sol", effort: "high" });
		assert.deepEqual(fleetModel.sources, { provider: "fleet", modelId: "fleet", effort: "fleet" });

		const overrideEffort = resolved({ fleet: { provider: "openai-codex", modelId: "gpt-6.1-sol", effort: "high" }, override: { effort: "max" } });
		assert.deepEqual(overrideEffort.model, { provider: "openai-codex", modelId: "gpt-6.1-sol", effort: "max" });
		assert.deepEqual(overrideEffort.sources, { provider: "fleet", modelId: "fleet", effort: "override" });

		const overrideModel = resolved({ fleet: { provider: "openai-codex", modelId: "gpt-6.1-sol", effort: "high" }, override: { modelId: "gpt-6-luna" } });
		assert.deepEqual(overrideModel.model, { provider: "openai-codex", modelId: "gpt-6-luna", effort: "high" });
		assert.deepEqual(overrideModel.sources, { provider: "fleet", modelId: "override", effort: "fleet" });

		const overrideProvider = resolved({ override: { provider: "opencode-go", modelId: "kimi-k3", effort: "off" } });
		assert.deepEqual(overrideProvider.model, { provider: "opencode-go", modelId: "kimi-k3", effort: "off" });
		assert.deepEqual(overrideProvider.sources, { provider: "override", modelId: "override", effort: "override" });
	});

	it("puts one job's choice on top of everything, and inherits what it leaves out", () => {
		const layers = { fleet: { effort: "high" as const }, override: { modelId: "gpt-6-luna" } };
		assert.deepEqual(resolved({ ...layers, job: { effort: "low" } }).model, { provider: "openai-codex", modelId: "gpt-6-luna", effort: "low" });
		const job = resolved({ ...layers, job: { provider: "openai-codex", modelId: "gpt-5.5" } });
		assert.deepEqual(job.model, { provider: "openai-codex", modelId: "gpt-5.5", effort: "high" });
		assert.deepEqual(job.sources, { provider: "job", modelId: "job", effort: "fleet" });
	});

	it("takes a field from a lower layer when a higher layer's document leaves it out, even when that makes the pair odd", () => {
		assert.match(refusal({ override: { provider: "opencode-go" } }), /opencode-go\/gpt-5\.5 is not one of this agent's allowed models/);
	});
});

describe("when the result is refused", () => {
	it("refuses a model that is not on the allowlist, naming where each part came from", () => {
		const reason = refusal({ fleet: { provider: "openai", modelId: "gpt-9" } });
		assert.match(reason, /the model openai\/gpt-9 is not one of this agent's allowed models \(openai-codex\/gpt-5\.5, openai-codex\/gpt-6\.1-sol/);
		assert.match(reason, /provider from the fleet's document, model from the fleet's document/);
	});

	it("keeps the allowlist semantics: the default is always allowed, anything else must be listed", () => {
		assert.ok(resolve({ override: { effort: "low" } }).ok);
		const strict = modelCheck({ allowed: allowlist(DEFAULT, []), find: (provider, modelId) => registry[`${provider}/${modelId}`] });
		assert.ok(resolveModel({ env: DEFAULT, override: { effort: "low" } }, strict).ok, "the default model is allowed without being listed");
		assert.ok(!resolveModel({ env: DEFAULT, override: { modelId: "gpt-6.1-sol" } }, strict).ok);
	});

	it("refuses a listed model that its provider does not offer", () => {
		const unoffered = modelCheck({ allowed: allowlist(DEFAULT, [{ provider: "openai-codex", modelId: "ghost" }]), find: () => undefined });
		const result = resolveModel({ env: DEFAULT, override: { modelId: "ghost" } }, unoffered);
		assert.ok(!result.ok);
		assert.match(result.reason, /openai-codex\/ghost is not offered by its provider/);
	});

	it("refuses an effort the model maps to null, and says what it does take", () => {
		const reason = refusal({ fleet: { modelId: "gpt-6.1-sol", effort: "off" } });
		assert.match(reason, /gpt-6\.1-sol does not support the effort off \(it supports minimal, low, medium, high, xhigh, max\)/);
		assert.match(reason, /effort from the fleet's document/);
	});

	it("refuses an effort the model has no mapping for at the top levels, and lets the lower ones through", () => {
		assert.match(refusal({ override: { effort: "max" } }), /gpt-5\.5 does not support the effort max/);
		assert.ok(resolve({ override: { effort: "xhigh" } }).ok);
		assert.ok(resolve({ override: { effort: "off" } }).ok);
		assert.ok(resolve({ override: { effort: "minimal" } }).ok);
	});

	it("lets a model without reasoning take only off, or no effort at all", () => {
		assert.ok(resolve({ override: { provider: "opencode-go", modelId: "kimi-k3" } }).ok);
		assert.ok(resolve({ override: { provider: "opencode-go", modelId: "kimi-k3", effort: "off" } }).ok);
		assert.match(refusal({ override: { provider: "opencode-go", modelId: "kimi-k3", effort: "high" } }), /kimi-k3 does not support the effort high \(it supports off\)/);
	});

	it("refuses a combination no single layer got wrong: the fleet's effort on an agent's own model", () => {
		const reason = refusal({ fleet: { effort: "off" }, override: { modelId: "gpt-6.1-sol" } });
		assert.match(reason, /gpt-6\.1-sol does not support the effort off/);
		assert.match(reason, /model from the agent's override, effort from the fleet's document/);
	});
});

describe("what the installed registry says", () => {
	it("takes the owner's target, gpt-6.1-sol on openai-codex at high effort, and refuses what the model does not do", async () => {
		const models = createModels({ credentials: new FileCredentialStore(join(mkdtempSync(join(tmpdir(), "effort-")), "auth.json")) });
		const target: ModelRef = { provider: "openai-codex", modelId: "gpt-6.1-sol" };
		await registerProviders(models, [DEFAULT, target], { stateDir: tmpdir() });
		const real = modelCheck({ allowed: allowlist(DEFAULT, [target]), find: (provider, modelId) => models.getModel(provider, modelId) as RegistryModel | undefined });
		for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) assert.equal(real({ ...target, effort }), undefined, effort);
		assert.match(real({ ...target, effort: "off" }) ?? "", /does not support the effort off/);
		const entry = models.getModel("openai-codex", "gpt-6.1-sol") as RegistryModel;
		assert.deepEqual(supportedEfforts(entry), ["minimal", "low", "medium", "high", "xhigh", "max"]);
		const result = resolveModel({ env: DEFAULT, fleet: { provider: "openai-codex", modelId: "gpt-6.1-sol", effort: "high" } }, real);
		assert.ok(result.ok);
		assert.deepEqual(result.model, { provider: "openai-codex", modelId: "gpt-6.1-sol", effort: "high" });
	});
});
