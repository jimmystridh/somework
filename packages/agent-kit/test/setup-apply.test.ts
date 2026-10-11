import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createBudgetIntercept } from "../src/budget-control.ts";
import { createHandler } from "../src/handler.ts";
import { DailyLedger } from "../src/ledger.ts";
import { McpHub } from "../src/mcp/hub.ts";
import { createMcpTools, MCP_CALL_TOOL, MCP_TOOL_NAMES } from "../src/mcp/tools.ts";
import { PiDurableRuntime } from "../src/pi-runtime.ts";
import { approvalPolicy, DEFAULT_APPROVAL_PATTERNS } from "../src/policy.ts";
import { scriptedModels } from "../src/providers/faux.ts";
import { libraryExtension, SKILL_LIBRARY_TOOL } from "../src/setup/library.ts";
import { parseLimits, parseOverride, sha256Hex, type SetupOverride } from "../src/setup/contract.ts";
import { Setup } from "../src/setup/setup.ts";
import { overlayFromDirectory, skillsExtension } from "../src/skills.ts";
import { emptyUsage, type AgentRequest, type AgentRuntime, type RunHooks } from "../src/runtime.ts";
import { FakeHost, makeRemote } from "../src/testing.ts";
import type { Job, JobControl } from "../src/job-types.ts";
import type { InboundMessage } from "../src/threads/message.ts";

const AGENT = "qa";
const tmp = (): string => mkdtempSync(join(tmpdir(), "kit-apply-"));
const MODELS = [{ provider: "faux", modelId: "a" }];

const openRuntimes: PiDurableRuntime[] = [];
const hubs: McpHub[] = [];
afterEach(async () => {
	for (const runtime of openRuntimes.splice(0)) await runtime.close();
	for (const hub of hubs.splice(0)) await hub.close();
});

const skill = (name: string, content: string, description = `about ${name}`) => ({ name, version: 1, description, content, sha256: sha256Hex(content) });
const document = (revision: number, over: Record<string, unknown> = {}) => ({ schema: 1, kind: "override", agent: AGENT, revision, savedBy: "ada", savedAt: "2026-10-10T10:00:00Z", ...over });

function makeSetup(options: { known?: { provider: string; modelId: string }[]; setModel?: (model: { provider: string; modelId: string } | undefined) => void; applyLimits?: ConstructorParameters<typeof Setup>[0]["applyLimits"] } = {}) {
	const dir = tmp();
	const hub = new McpHub({ root: join(dir, "mcp"), env: { PATH: process.env.PATH ?? "" } });
	hubs.push(hub);
	const known = options.known ?? MODELS;
	const setup = new Setup({
		agentId: AGENT,
		dir: join(dir, "setup"),
		defaults: { approvalPatterns: DEFAULT_APPROVAL_PATTERNS.map(([pattern, reason]) => ({ pattern: pattern.source, reason })), repositorySkills: ["verify-skill"], model: known[0]!, allowedModels: known },
		hub,
		checkModel: (ref) => (known.some((entry) => entry.provider === ref.provider && entry.modelId === ref.modelId) ? undefined : `the model ${ref.provider}/${ref.modelId} is not one of this agent's allowed models`),
		setModel: options.setModel ?? (() => undefined),
		applyLimits: options.applyLimits ?? (() => undefined),
	});
	const apply = async (revision: number, over: Record<string, unknown> = {}): Promise<SetupOverride> => {
		const raw = document(revision, over);
		const parsed = parseOverride(raw, AGENT);
		await setup.applyOverride(parsed, sha256Hex(JSON.stringify(raw)));
		return parsed;
	};
	return { setup, hub, apply, dir };
}

describe("the approval patterns", () => {
	it("are replaced by the override and come back with the next revision, through one policy object", async () => {
		const { setup, apply } = makeSetup();
		const policy = approvalPolicy(["\\bkubectl\\b"], DEFAULT_APPROVAL_PATTERNS, {}, { patterns: () => setup.approvalPatterns() });
		assert.match(policy.needsApproval("bash", { command: "sudo ls" }) ?? "", /run a command as root/);

		await apply(1, { approvalPatterns: [{ pattern: "^make deploy", reason: "deploys to production" }] });
		assert.equal(policy.needsApproval("bash", { command: "sudo ls" }), undefined, "the role's own list is replaced");
		assert.match(policy.needsApproval("bash", { command: "make deploy prod" }) ?? "", /^deploys to production: make deploy prod/);
		assert.match(policy.needsApproval("bash", { command: "kubectl get pods" }) ?? "", /kubectl/, "the deployment's own additions stay");

		await apply(2, { approvalPatterns: [] });
		assert.equal(policy.needsApproval("bash", { command: "make deploy prod" }), undefined, "an empty list asks about nothing of the role's");

		await apply(3);
		assert.match(policy.needsApproval("bash", { command: "sudo ls" }) ?? "", /run a command as root/, "an override without patterns keeps the role's list");
	});

	it("also asks about MCP calls according to the entry, and leaves other tools alone", async () => {
		const { setup, hub, apply } = makeSetup();
		const policy = approvalPolicy([], DEFAULT_APPROVAL_PATTERNS, {}, { patterns: () => setup.approvalPatterns(), tool: (tool, args) => (tool === MCP_CALL_TOOL ? hub.approvalSummary(String(args.server), String(args.tool), args.arguments) : undefined) });
		await apply(1, { mcp: [{ name: "tickets", transport: "http", url: "https://tickets.example.test/mcp", approval: "ask" }, { name: "wiki", transport: "http", url: "https://wiki.example.test/mcp", approval: "never" }] });
		assert.match(policy.needsApproval(MCP_CALL_TOOL, { server: "tickets", tool: "close", arguments: { id: 4 } }) ?? "", /close of the MCP server tickets/);
		assert.equal(policy.needsApproval(MCP_CALL_TOOL, { server: "wiki", tool: "read", arguments: {} }), undefined);
		assert.equal(policy.needsApproval("read", { path: "x" }), undefined);
		await apply(2);
		assert.equal(policy.needsApproval(MCP_CALL_TOOL, { server: "tickets", tool: "close", arguments: {} }), undefined, "the server is gone with its entry");
	});
});

describe("the model", () => {
	async function twoModels() {
		const dir = tmp();
		const fake = scriptedModels(["final:from the default model"]);
		const other = fauxProvider({ provider: "other", models: [{ id: "other-model" }] });
		other.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage([fauxText("from the other model")])));
		(fake.models as any).setProvider(other.provider);
		const runtime = new PiDurableRuntime({ storagePath: join(dir, "state.sqlite"), models: fake.models, model: fake.model, env: (cwd) => new NodeExecutionEnv({ cwd: cwd ?? dir }) });
		await runtime.start();
		openRuntimes.push(runtime);
		const workspace = join(dir, "w");
		mkdirSync(workspace, { recursive: true });
		const run = async (key: string): Promise<string> => {
			const outcome = await runtime.execute({ requestId: `r-${key}`, agentKey: key, instruction: "go", workspace, budget: { maxTokens: 1_000_000, maxMinutes: 5 } }, hooks());
			return outcome.status === "done" ? outcome.answer : outcome.status;
		};
		return { runtime, run, fake };
	}
	const hooks = (): RunHooks => ({ signal: new AbortController().signal, onProgress: () => undefined, requestApproval: async () => ({ approved: true }) });
	const OTHER = { provider: "other", modelId: "other-model" };

	it("is switched for new conversations only: a conversation keeps the model it started with", async () => {
		const { runtime, run } = await twoModels();
		assert.equal(await run("k1"), "from the default model");
		runtime.setModel(OTHER);
		assert.deepEqual(runtime.model, OTHER);
		assert.equal(await run("k1"), "from the default model", "the running conversation keeps its model");
		assert.equal(await run("k2"), "from the other model");
		runtime.setModel(undefined);
		assert.equal(await run("k3"), "from the default model", "the configured model is back");
	});

	it("refuses a model its provider does not offer, and keeps the one it had", async () => {
		const { runtime } = await twoModels();
		assert.throws(() => runtime.setModel({ provider: "other", modelId: "ghost" }), /not offered by its provider/);
		assert.throws(() => runtime.setModel({ provider: "nobody", modelId: "x" }), /not offered by its provider/);
		assert.equal(runtime.model.provider, "faux");
	});

	it("is refused by the setup when it is not one the agent allows, so the document is rejected", async () => {
		const chosen: unknown[] = [];
		const { setup, apply } = makeSetup({ setModel: (model) => void chosen.push(model) });
		await assert.rejects(apply(1, { model: { provider: "openai", modelId: "gpt-9" } }), /not one of this agent's allowed models/);
		assert.equal(setup.status().override, null);
		assert.deepEqual(chosen, []);
		await apply(2, { model: MODELS[0] });
		assert.deepEqual(chosen, [MODELS[0]]);
	});
});

describe("what a new conversation gets from the override", () => {
	const hooks = (): RunHooks => ({ signal: new AbortController().signal, onProgress: () => undefined, requestApproval: async () => ({ approved: true }) });
	const system = (context: any): string => (context.messages ?? []).filter((message: { role: string }) => message.role === "system").map((message: any) => JSON.stringify(message)).join("\n");
	const offered = (context: any): string[] => (context.messages ?? []).filter((message: { role: string }) => message.role === "system").flatMap((message: any) => (message.toolsAdded ?? []).map((tool: { name: string }) => tool.name));

	async function rig(plan: string[] = ["final:ok"], extraExtensions: any[] = []) {
		const made = makeSetup();
		const contexts: any[] = [];
		const fake = scriptedModels(plan, (context) => contexts.push(context));
		const dir = tmp();
		const runtime = new PiDurableRuntime({
			storagePath: join(dir, "state.sqlite"),
			models: fake.models,
			model: fake.model,
			env: (cwd) => new NodeExecutionEnv({ cwd: cwd ?? dir }),
			instructions: "You are the QA agent.",
			allowedTools: ["read", "bash"],
			operator: { instructions: () => made.setup.instructionsAddendum(), tools: () => made.setup.operatorTools(), toolNames: [SKILL_LIBRARY_TOOL, ...MCP_TOOL_NAMES] },
			extensions: [libraryExtension(() => made.setup.librarySkills()).extension, createMcpTools(made.hub).extension, ...extraExtensions],
		});
		await runtime.start();
		openRuntimes.push(runtime);
		const workspace = join(dir, "w");
		mkdirSync(workspace, { recursive: true });
		const run = async (key: string, over: Partial<AgentRequest> = {}) => {
			const before = contexts.length;
			const outcome = await runtime.execute({ requestId: `r-${key}-${before}`, agentKey: key, instruction: "go", workspace, budget: { maxTokens: 1_000_000, maxMinutes: 5 }, ...over }, hooks());
			return { outcome, contexts: contexts.slice(before) };
		};
		return { ...made, runtime, run, contexts };
	}

	it("appends the operator instructions to the role's prompt for new conversations, and a running one keeps what it started with", async () => {
		const w = await rig();
		const before = await w.run("job-1");
		assert.match(system(before.contexts[0]), /You are the QA agent\./);
		assert.doesNotMatch(system(before.contexts[0]), /Operator instructions/);

		await w.apply(1, { instructions: "Always answer in Swedish." });
		const same = await w.run("job-1");
		assert.doesNotMatch(system(same.contexts[0]), /Swedish/, "a conversation in progress is not rewritten");
		const fresh = await w.run("job-2");
		const prompt = system(fresh.contexts[0]);
		assert.match(prompt, /You are the QA agent\./);
		assert.match(prompt, /Operator instructions\./);
		assert.match(prompt, /Always answer in Swedish\./);
		assert.ok(prompt.indexOf("You are the QA agent") < prompt.indexOf("Always answer in Swedish"), "the addendum comes after the built-in prompt");
	});

	it("starts a fresh chat conversation for a new revision through the key suffix, and continues one under the same suffix", async () => {
		const w = await rig();
		const key = () => `thread:conv${w.setup.conversationSuffix()}`;
		assert.equal(key(), "thread:conv", "keys are unchanged while no override shapes the conversation");
		const first = await w.run(key());
		assert.doesNotMatch(system(first.contexts[0]), /Operator instructions/);

		await w.apply(1, { instructions: "Revision one." });
		const second = await w.run(key());
		assert.match(system(second.contexts[0]), /Revision one\./);
		const third = await w.run(key());
		assert.equal((system(third.contexts[0]).match(/Revision one\./g) ?? []).length, 1, "the same conversation, not a second copy of the addendum");

		await w.apply(2, { instructions: "Revision two." });
		assert.notEqual(key(), "thread:conv");
		const fourth = await w.run(key());
		assert.match(system(fourth.contexts[0]), /Revision two\./);
		assert.doesNotMatch(system(fourth.contexts[0]), /Revision one\./);

		await w.apply(3, { approvalPatterns: [{ pattern: "x", reason: "y" }] });
		assert.equal(key(), "thread:conv", "an override that changes nothing a conversation keeps leaves the key alone");
	});

	it("offers the library and MCP tools to new conversations only once the override has something behind them", async () => {
		const w = await rig();
		assert.deepEqual(offered((await w.run("a")).contexts[0]).sort(), ["bash", "read"]);
		await w.apply(1, { skills: { library: [skill("notes", "# Notes\nWrite release notes.")] } });
		assert.deepEqual(offered((await w.run("b")).contexts[0]).sort(), ["bash", "read", "skill_library"]);
		await w.apply(2, { mcp: [{ name: "wiki", transport: "http", url: "https://wiki.example.test/mcp", approval: "never" }], skills: { library: [skill("notes", "# Notes")] } });
		assert.deepEqual(offered((await w.run("c")).contexts[0]).sort(), ["bash", "mcp_call", "mcp_tools", "read", "skill_library"]);
		assert.deepEqual(offered((await w.run("d", { tools: ["read"] })).contexts[0]).sort(), ["mcp_call", "mcp_tools", "read", "skill_library"], "a request that lists its own tools gets the setup's on top");
	});

	it("shows the library as an index under library/ names and returns a skill's text on request, through one fixed tool", async () => {
		const w = await rig(['call:skill_library:{"name":"library/notes"}', "call:skill_library:{}", "final:done"]);
		await w.apply(1, { skills: { library: [skill("notes", "# Notes\nWrite release notes in the past tense.", "Writing release notes")] } });
		const { outcome, contexts } = await w.run("job");
		assert.equal(outcome.status, "done");
		assert.match(system(contexts[0]), /library\/notes: Writing release notes/);
		assert.match(JSON.stringify(contexts.at(-1)), /Write release notes in the past tense\./, "the tool returned the skill");
		assert.match(JSON.stringify(contexts.at(-1)), /- library\/notes: Writing release notes/, "listing it without a name works too");
	});

	it("lets the model call the MCP tools in a job whose own tool list does not name them", async () => {
		const w = await rig(["call:mcp_tools:{}", "final:done"]);
		await w.apply(1, { mcp: [{ name: "wiki", transport: "http", url: "http://127.0.0.1:1/mcp", approval: "never", timeoutSeconds: 1 }] });
		const { outcome, contexts } = await w.run("job");
		assert.equal(outcome.status, "done");
		assert.match(JSON.stringify(contexts.at(-1)), /server wiki/, "the call was not blocked as unavailable");
		assert.doesNotMatch(JSON.stringify(contexts.at(-1)), /not available to this agent/);
	});
});

describe("the repository skills", () => {
	const QA = "---\nname: verify-skill\ndescription: Verify frontend tickets.\n---\n# QA\n";
	const REVIEW = "---\nname: review-skill\ndescription: Review pull requests.\n---\n# Review\n";
	const write = (root: string, path: string, text: string): void => {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), text);
	};
	const hooks = (): RunHooks => ({ signal: new AbortController().signal, onProgress: () => undefined, requestApproval: async () => ({ approved: true }) });

	it("use the override's allow list and overlays from the next request on, falling back to the role's list and the overlay directory", async () => {
		const repo = tmp();
		write(repo, ".agents/skills/verify-skill/SKILL.md", QA);
		write(repo, ".agents/skills/review-skill/SKILL.md", REVIEW);
		const overlays = tmp();
		write(overlays, "verify-skill.md", "From the overlay directory.\n");
		const { setup, apply } = makeSetup();
		const fileOverlay = overlayFromDirectory(overlays);
		const contexts: string[] = [];
		const fake = scriptedModels(["final:ok"], (context) => contexts.push(JSON.stringify(context)));
		const dir = tmp();
		const runtime = new PiDurableRuntime({
			storagePath: join(dir, "state.sqlite"),
			models: fake.models,
			model: fake.model,
			env: (cwd) => new NodeExecutionEnv({ cwd: cwd ?? dir }),
			extensions: [skillsExtension({ allow: () => setup.repositorySkills(["verify-skill"]), version: () => setup.version(), readOverlay: (name) => setup.overlay(name) ?? fileOverlay(name) })],
		});
		await runtime.start();
		openRuntimes.push(runtime);
		const run = async (key: string): Promise<string> => {
			const before = contexts.length;
			await runtime.execute({ requestId: `r-${key}`, agentKey: key, instruction: "go", workspace: repo, budget: { maxTokens: 1_000_000, maxMinutes: 5 } }, hooks());
			return contexts[before]!;
		};

		let prompt = await run("one");
		assert.match(prompt, /verify-skill: Verify frontend tickets\./);
		assert.doesNotMatch(prompt, /review-skill/);
		assert.match(prompt, /From the overlay directory\./);

		await apply(1, { skills: { repository: ["review-skill"], overlays: { "review-skill": "Check the tests first." } } });
		prompt = await run("two");
		assert.match(prompt, /review-skill: Review pull requests\./);
		assert.doesNotMatch(prompt, /verify-skill: Verify/, "the override's list replaces the role's");
		assert.match(prompt, /Check the tests first\./);

		await apply(2, { skills: { repository: ["verify-skill", "review-skill"], overlays: { "verify-skill": "From the override." } } });
		prompt = await run("three");
		assert.match(prompt, /From the override\./, "an overlay in the override wins over the file");
		assert.doesNotMatch(prompt, /From the overlay directory\./);

		await apply(3);
		prompt = await run("four");
		assert.match(prompt, /verify-skill: Verify/);
		assert.doesNotMatch(prompt, /review-skill: Review/);
		assert.match(prompt, /From the overlay directory\./, "reset: the role's list and the file overlay are back");
	});

	it("never let a library skill take the place of a repository skill", async () => {
		const { setup, apply } = makeSetup();
		await apply(1, { skills: { repository: ["verify-skill"], library: [skill("verify-skill", "# Library version")] } });
		assert.deepEqual(setup.repositorySkills(["x"]), ["verify-skill"]);
		assert.equal(setup.librarySkills()[0]!.name, "verify-skill", "kept under its own name, which the model sees as library/verify-skill");
	});
});

describe("the fleet limits", () => {
	const limits = (revision: number, over: Record<string, unknown> = {}) => parseLimits({ schema: 1, kind: "limits", revision, savedBy: "admin", savedAt: "2026-10-10T10:00:00Z", maxTokensCap: 2000, maxMinutesCap: 2, dailyTokenLimit: 500, budgetRaiseCeiling: 900, ...over });

	it("reach the handler, the ledger and the budget control on their next call, with the environment's values until a document arrives", async () => {
		const live = { maxTokensCap: 10_000, maxMinutesCap: 5, dailyTokenLimit: 1000, budgetRaiseCeiling: 1000 };
		const ledger = new DailyLedger(join(tmp(), "ledger.json"), live.dailyTokenLimit, () => "2026-10-10");
		const { setup } = makeSetup({
			applyLimits: (document) => {
				Object.assign(live, { maxTokensCap: document.maxTokensCap, maxMinutesCap: document.maxMinutesCap, dailyTokenLimit: document.dailyTokenLimit, budgetRaiseCeiling: document.budgetRaiseCeiling });
				ledger.setDailyTokenLimit(document.dailyTokenLimit);
			},
		});

		const requests: AgentRequest[] = [];
		const runtime: AgentRuntime = {
			start: async () => {},
			health: () => ({ ready: true }),
			close: async () => {},
			execute: async (request) => (requests.push(request), writeFileSync(join(request.workspace, "change.txt"), `${requests.length}\n`), { status: "done", answer: "did it", usage: emptyUsage() }),
		};
		const { remote } = makeRemote();
		const root = join(tmp(), "workspaces");
		const handler = createHandler({
			runtime,
			session: { env: new NodeExecutionEnv({ cwd: root }), identity: { name: "Kit", email: "kit@test.invalid" } },
			host: new FakeHost(),
			workspaceRoot: root,
			client: { uploadArtifact: async () => ({ artifactId: "art_1" }) } as never,
			limits: live,
		});
		const start = (taskId: string) => handler({ taskId, task: {}, input: { repository: { url: remote, ref: "main" }, instruction: "x", budget: { maxTokens: 50_000, maxMinutes: 30 } }, capability: { id: "code.agent", version: "1" } } as unknown as Job, { signal: new AbortController().signal, progress() {} } as unknown as JobControl);

		await start("t1");
		assert.deepEqual(requests[0]!.budget, { maxTokens: 10_000, maxMinutes: 5 }, "the environment's caps apply first");
		assert.equal(ledger.dailyLimit, 1000);

		const raises: string[] = [];
		const budget = createBudgetIntercept({
			ledger,
			controllers: ["agent/manager"],
			ceiling: () => live.budgetRaiseCeiling,
			reply: async (_message, text) => void raises.push(text),
			log: () => undefined,
		});
		const raise = (tokens: number): Promise<boolean> => budget({ messageId: "m", type: "chat.message", sender: { kind: "agent", id: "agent/manager" }, recipients: [], labels: { budgetControl: "raise", budgetPool: "tasks", budgetTokens: String(tokens) } } as InboundMessage);

		await setup.applyLimits(limits(1), sha256Hex("limits-1"));
		await start("t2");
		assert.deepEqual(requests[1]!.budget, { maxTokens: 2000, maxMinutes: 2 }, "the handler reads the caps on every call");
		assert.equal(ledger.dailyLimit, 500, "the ledger's daily limit follows");
		await raise(901);
		assert.match(raises.at(-1)!, /Budget not changed.*at most 900 tokens/, "the raise ceiling follows the limits too");
		await raise(800);
		assert.match(raises.at(-1)!, /Budget raised/);
		assert.equal(ledger.dailyLimit, 1300);
		await raise(200);
		assert.match(raises.at(-1)!, /Budget not changed/, "800 are raised already, so 200 more is over the ceiling of 900");
		await setup.applyLimits(limits(2, { budgetRaiseCeiling: 5000, dailyTokenLimit: 3000 }), sha256Hex("limits-2"));
		await raise(1500);
		assert.match(raises.at(-1)!, /Budget raised/);
		assert.equal(ledger.dailyLimit, 5300, "3000 and what was raised today (800 and 1500)");
	});
});
