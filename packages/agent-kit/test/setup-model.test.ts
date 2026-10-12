import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { McpHub } from "../src/mcp/hub.ts";
import { allowlist, type ModelRef } from "../src/providers/allowlist.ts";
import { modelCheck, type RegistryModel } from "../src/providers/effective-model.ts";
import { parseLimits, parseOverride, sha256Hex, SetupRejected } from "../src/setup/contract.ts";
import { Setup } from "../src/setup/setup.ts";

const AGENT = "qa";
const FULL: RegistryModel = { reasoning: true, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } };
const registry: Record<string, RegistryModel> = {
	"openai-codex/gpt-5.5": { reasoning: true, thinkingLevelMap: { xhigh: "xhigh", minimal: "low" } },
	"openai-codex/gpt-6.1-sol": FULL,
	"opencode-go/kimi-k3": { reasoning: false },
};
const DEFAULT: ModelRef = { provider: "openai-codex", modelId: "gpt-5.5" };
const ALLOWED = allowlist(DEFAULT, [{ provider: "openai-codex", modelId: "gpt-6.1-sol" }, { provider: "opencode-go", modelId: "kimi-k3" }]);

const hubs: McpHub[] = [];
afterEach(async () => {
	for (const hub of hubs.splice(0)) await hub.close();
});

const overrideDocument = (revision: number, over: Record<string, unknown> = {}) => ({ schema: 1, kind: "override", agent: AGENT, revision, savedBy: "ada", savedAt: "2026-10-10T10:00:00Z", ...over });
const limitsDocument = (revision: number, over: Record<string, unknown> = {}) => ({ schema: 1, kind: "limits", revision, savedBy: "admin", savedAt: "2026-10-10T10:00:00Z", maxTokensCap: 1, maxMinutesCap: 1, dailyTokenLimit: 1, budgetRaiseCeiling: 1, ...over });

function rig(options: { dir?: string; env?: ModelRef } = {}) {
	const dir = options.dir ?? mkdtempSync(join(tmpdir(), "kit-model-"));
	const hub = new McpHub({ root: join(dir, "mcp"), env: { PATH: process.env.PATH ?? "" } });
	hubs.push(hub);
	const set: (ModelRef | undefined)[] = [];
	const logged: { event: string; fields?: Record<string, unknown> }[] = [];
	const setup = new Setup({
		agentId: AGENT,
		dir: join(dir, "setup"),
		defaults: { approvalPatterns: [], repositorySkills: [], model: options.env ?? DEFAULT, allowedModels: ALLOWED },
		hub,
		checkModel: modelCheck({ allowed: ALLOWED, find: (provider, modelId) => registry[`${provider}/${modelId}`] }),
		setModel: (model) => void set.push(model),
		applyLimits: () => undefined,
		log: (_level, event, fields) => void logged.push({ event, fields }),
	});
	const applyOverride = (revision: number, over: Record<string, unknown> = {}) => {
		const raw = overrideDocument(revision, over);
		return setup.applyOverride(parseOverride(raw, AGENT), sha256Hex(JSON.stringify(raw)));
	};
	const applyLimits = (revision: number, over: Record<string, unknown> = {}) => {
		const raw = limitsDocument(revision, over);
		return setup.applyLimits(parseLimits(raw), sha256Hex(JSON.stringify(raw)));
	};
	return { dir, setup, set, logged, applyOverride, applyLimits };
}

const SOL = { provider: "openai-codex", modelId: "gpt-6.1-sol" };

describe("the model of an agent: environment, fleet, override", () => {
	it("is the environment's default until something above it sets a field", () => {
		const w = rig();
		assert.deepEqual(w.setup.model(), DEFAULT);
		assert.deepEqual(w.setup.effectiveModel().sources, { provider: "env", modelId: "env" });
		assert.equal(w.setup.conversationSuffix(), "");
	});

	it("follows the fleet's model, effort included, and tells the runtime once", async () => {
		const w = rig();
		await w.applyLimits(1, { model: { ...SOL, effort: "high" } });
		assert.deepEqual(w.setup.model(), { ...SOL, effort: "high" });
		assert.deepEqual(w.set, [{ ...SOL, effort: "high" }]);
		await w.applyLimits(2, { model: { ...SOL, effort: "high" }, maxMinutesCap: 5 });
		assert.equal(w.set.length, 1, "limits that change nothing about the model leave the runtime alone");
		const report = w.setup.report({ model: w.setup.model() });
		assert.deepEqual(report.effective.model, { ...SOL, effort: "high" });
		assert.deepEqual(report.effective.modelSources, { provider: "fleet", modelId: "fleet", effort: "fleet" });
	});

	it("lets the agent's override replace single fields of the fleet's model", async () => {
		const w = rig();
		await w.applyLimits(1, { model: { ...SOL, effort: "high" } });
		await w.applyOverride(1, { model: { effort: "xhigh" } });
		assert.deepEqual(w.setup.model(), { ...SOL, effort: "xhigh" });
		assert.deepEqual(w.set.at(-1), { ...SOL, effort: "xhigh" });
		assert.deepEqual(w.setup.report({ model: w.setup.model() }).effective.modelSources, { provider: "fleet", modelId: "fleet", effort: "override" });

		await w.applyOverride(2, { model: { provider: "opencode-go", modelId: "kimi-k3", effort: "off" } });
		assert.deepEqual(w.setup.model(), { provider: "opencode-go", modelId: "kimi-k3", effort: "off" });
		assert.deepEqual(w.setup.report({ model: w.setup.model() }).effective.modelSources, { provider: "override", modelId: "override", effort: "override" });
	});

	it("goes back to the fleet's model when the override is reset, and to the environment when the fleet's model is withdrawn", async () => {
		const w = rig();
		await w.applyLimits(1, { model: { effort: "high" } });
		await w.applyOverride(1, { model: SOL });
		assert.deepEqual(w.setup.model(), { ...SOL, effort: "high" });
		await w.applyOverride(2);
		assert.deepEqual(w.set.at(-1), { ...DEFAULT, effort: "high" }, "the fleet's effort stands on the environment's model");
		await w.applyLimits(2);
		assert.equal(w.set.at(-1), undefined, "nothing above the environment is left: the runtime goes back to its configured model");
		assert.deepEqual(w.setup.model(), DEFAULT);
	});

	it("starts a new conversation when provider or model change, and keeps it when only the effort does", async () => {
		const w = rig();
		await w.applyLimits(1, { model: { effort: "low" } });
		const withEffort = w.setup.conversationSuffix();
		assert.equal(withEffort, "", "an effort alone does not shape a conversation: it is put into it at every run");
		await w.applyLimits(2, { model: { effort: "high" } });
		assert.equal(w.setup.conversationSuffix(), withEffort);
		await w.applyLimits(3, { model: SOL });
		const sol = w.setup.conversationSuffix();
		assert.notEqual(sol, "");
		await w.applyOverride(1, { model: { effort: "max" } });
		assert.equal(w.setup.conversationSuffix(), sol, "the same provider and model, another effort");
		await w.applyOverride(2, { model: { modelId: "gpt-5.5", effort: "high" } });
		assert.notEqual(w.setup.conversationSuffix(), sol);
	});

	it("gives a job the same layers with its own choice on top", async () => {
		const w = rig();
		await w.applyLimits(1, { model: { ...SOL, effort: "high" } });
		const job = w.setup.modelForJob({ effort: "low" });
		assert.ok(job.ok);
		assert.deepEqual(job.model, { ...SOL, effort: "low" });
		const other = w.setup.modelForJob({ provider: "opencode-go", modelId: "kimi-k3" });
		assert.ok(!other.ok, "the fleet's effort high is not something kimi-k3 does");
		assert.match(other.reason, /kimi-k3 does not support the effort high \(it supports off\)/);
		const plain = w.setup.modelForJob({ provider: "opencode-go", modelId: "kimi-k3", effort: "off" });
		assert.ok(plain.ok);
	});
});

describe("a document the agent cannot take as a whole is rejected and the previous setup stays", () => {
	it("refuses an override whose model does not take its effort, with the reason", async () => {
		const w = rig();
		await w.applyLimits(1, { model: SOL });
		await assert.rejects(w.applyOverride(1, { model: { effort: "off" } }), (error: unknown) => error instanceof SetupRejected && /gpt-6\.1-sol does not support the effort off \(it supports minimal, low, medium, high, xhigh, max\)/.test(error.message) && /effort from the agent's override/.test(error.message));
		assert.equal(w.setup.status().override, null);
		assert.deepEqual(w.setup.model(), SOL);
		assert.equal(w.set.length, 1, "the runtime was not touched by the refused document");
	});

	it("refuses an override with a provider or model the agent does not allow, even when only one of the two is given", async () => {
		const w = rig();
		await assert.rejects(w.applyOverride(1, { model: { provider: "openai", modelId: "gpt-9" } }), /not one of this agent's allowed models/);
		await assert.rejects(w.applyOverride(2, { model: { provider: "opencode-go" } }), /opencode-go\/gpt-5\.5 is not one of this agent's allowed models/);
		assert.equal(w.setup.status().override, null);
	});

	it("refuses a fleet model that does not fit the agent's own override, and keeps the earlier limits", async () => {
		const w = rig();
		await w.applyLimits(1);
		await w.applyOverride(1, { model: { effort: "off" } });
		await assert.rejects(w.applyLimits(2, { model: SOL }), /gpt-6\.1-sol does not support the effort off.*model from the fleet's document, effort from the agent's override/s);
		assert.equal(w.setup.status().limits!.revision, 1);
		assert.deepEqual(w.setup.model(), { ...DEFAULT, effort: "off" });
	});

	it("refuses a fleet model that is not allowed on this agent", async () => {
		const w = rig();
		await assert.rejects(w.applyLimits(1, { model: { provider: "openai", modelId: "gpt-9" } }), /not one of this agent's allowed models/);
		assert.equal(w.setup.status().limits, null);
	});
});

describe("after a restart", () => {
	it("restores the fleet's model and the override on top of it, with the same conversation suffix", async () => {
		const first = rig();
		await first.applyLimits(1, { model: { ...SOL, effort: "high" } });
		await first.applyOverride(1, { model: { effort: "max" } });
		const second = rig({ dir: first.dir });
		await second.setup.restore();
		assert.deepEqual(second.setup.model(), { ...SOL, effort: "max" });
		assert.equal(second.setup.conversationSuffix(), first.setup.conversationSuffix());
		await second.applyOverride(2);
		assert.deepEqual(second.set.at(-1), { ...SOL, effort: "high" }, "a reset after the restart reaches the runtime even though the restored model was set by the service");
	});

	it("leaves out a stored model that no longer fits (the registry or the allowlist changed) and says so", async () => {
		const first = rig();
		await first.applyLimits(1, { model: SOL });
		await first.applyOverride(1, { instructions: "stay", model: { effort: "max" } });
		const narrowed = rig({ dir: first.dir, env: { ...DEFAULT } });
		const restricted = new Setup({
			agentId: AGENT,
			dir: join(first.dir, "setup"),
			defaults: { approvalPatterns: [], repositorySkills: [], model: DEFAULT, allowedModels: [DEFAULT] },
			hub: new McpHub({ root: join(first.dir, "mcp2"), env: { PATH: process.env.PATH ?? "" } }),
			checkModel: modelCheck({ allowed: [DEFAULT], find: (provider, modelId) => registry[`${provider}/${modelId}`] }),
			setModel: () => undefined,
			applyLimits: () => undefined,
			log: (_level, event) => void narrowed.logged.push({ event }),
		});
		await restricted.restore();
		assert.deepEqual(restricted.model(), DEFAULT);
		assert.deepEqual(narrowed.logged.map((entry) => entry.event), ["setup_model_ignored", "setup_model_ignored"]);
		assert.match(restricted.instructionsAddendum()!, /stay/, "the rest of the override still applies");
	});
});
