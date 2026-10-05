import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, type Context, type Provider } from "@earendil-works/pi-ai";
import type { Job, JobControl } from "@somework/sdk";
import { loadConfig } from "../src/config.ts";
import { FileCredentialStore } from "../src/credentials.ts";
import { allowlist, isAllowed, parseModelList } from "../src/providers/allowlist.ts";
import { antigravityProvider, loadAntigravity, type AntigravityImplementation } from "../src/providers/antigravity.ts";
import { loadProvider, registerProviders } from "../src/providers/index.ts";
import { emptyUsage, type AgentRequest, type AgentRuntime } from "../src/runtime.ts";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createHandler } from "../src/service.ts";
import { FakeHost, makeRemote } from "./fakes.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pi-prov-"));
const authFile = (content: unknown): string => {
	const path = join(tmp(), "auth.json");
	writeFileSync(path, JSON.stringify(content));
	chmodSync(path, 0o600);
	return path;
};
const baseEnv = { SOMEWORK_URL: "https://x.test", SOMEWORK_KEY_FILE: "/k", SANDBOX_URL: "http://s" };

describe("model allowlist", () => {
	it("parses provider/model-id lists, keeps slashes in ids, and rejects malformed entries", () => {
		assert.deepEqual(parseModelList(" opencode-go/deepseek-v4-flash , antigravity/gemini-3.8-flash,openrouter/a/b"), [
			{ provider: "opencode-go", modelId: "deepseek-v4-flash" },
			{ provider: "antigravity", modelId: "gemini-3.8-flash" },
			{ provider: "openrouter", modelId: "a/b" },
		]);
		assert.deepEqual(parseModelList(undefined), []);
		for (const bad of ["nomodel", "/id", "provider/"]) assert.throws(() => parseModelList(bad), /provider\/model-id/);
	});

	it("always allows the configured default first, without duplicating it", () => {
		const config = loadConfig({ ...baseEnv, PI_ALLOWED_MODELS: "openai-codex/gpt-5.5,opencode-go/kimi-k3" });
		assert.deepEqual(config.allowedModels, [
			{ provider: "openai-codex", modelId: "gpt-5.5" },
			{ provider: "opencode-go", modelId: "kimi-k3" },
		]);
		assert.deepEqual(loadConfig(baseEnv).allowedModels, [{ provider: "openai-codex", modelId: "gpt-5.5" }]);
		assert.ok(isAllowed(allowlist({ provider: "a", modelId: "b" }, []), { provider: "a", modelId: "b" }));
		assert.ok(!isAllowed(allowlist({ provider: "a", modelId: "b" }, []), { provider: "a", modelId: "c" }));
	});
});

describe("opencode-go", () => {
	it("registers from the service's own api-key credential and resolves it for requests", async () => {
		const models = createModels({ credentials: new FileCredentialStore(authFile({ "opencode-go": { type: "api_key", key: "oc-test-key" } })) });
		await registerProviders(models, [{ provider: "opencode-go", modelId: "deepseek-v4-flash" }], { stateDir: tmp() });
		const model = models.getModel("opencode-go", "deepseek-v4-flash");
		assert.ok(model);
		const auth = await models.getAuth(model!);
		assert.equal(auth?.apiKey ?? (auth as any)?.auth?.apiKey, "oc-test-key");
	});

	it("fails at startup, not mid-job, for a model the provider does not offer or a provider that is not wired", async () => {
		const models = createModels({ credentials: new FileCredentialStore(authFile({})) });
		await assert.rejects(registerProviders(models, [{ provider: "opencode-go", modelId: "no-such-model" }], { stateDir: tmp() }), /not offered/);
		await assert.rejects(loadProvider("mystery", { stateDir: tmp() }), /not wired yet/);
	});
});

const stored = (over: Record<string, unknown> = {}) => ({ type: "oauth", access: "access-1", refresh: "refresh-1", expires: Date.now() + 3_600_000, projectId: "proj-1", email: "me@example.test", ...over });

function fakeImplementation(calls: { refreshed: string[]; streamed: { apiKey?: string }[] }): AntigravityImplementation {
	return {
		api: "antigravity-api",
		endpoint: "https://antigravity.test",
		models: [{ id: "gemini-test", name: "Gemini Test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
		stream: (model, context, options) => {
			calls.streamed.push({ apiKey: options?.apiKey });
			const faux = fauxProvider();
			faux.setResponses([fauxAssistantMessage([])]);
			return faux.provider.stream(faux.getModel(), context as never, options as never);
		},
		refresh: async (credential) => {
			calls.refreshed.push(credential.refresh);
			return { ...credential, access: "access-2", refresh: credential.refresh, expires: Date.now() + 3_600_000 };
		},
		apiKey: (credential) => JSON.stringify({ token: credential.access, projectId: credential.projectId }),
	};
}

describe("antigravity", () => {
	it("refreshes an expired OAuth credential and writes it back to the service's own auth.json only", async () => {
		const path = authFile({ antigravity: stored({ expires: Date.now() - 1000 }), "opencode-go": { type: "api_key", key: "keep-me" } });
		const calls = { refreshed: [] as string[], streamed: [] as { apiKey?: string }[] };
		const models = createModels({ credentials: new FileCredentialStore(path) });
		models.setProvider(antigravityProvider(fakeImplementation(calls)));
		const model = models.getModel("antigravity", "gemini-test")!;
		assert.ok(model);

		const auth = await models.getAuth(model);
		assert.deepEqual(JSON.parse((auth as any).apiKey ?? (auth as any).auth.apiKey), { token: "access-2", projectId: "proj-1" });
		assert.deepEqual(calls.refreshed, ["refresh-1"]);

		const saved = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(saved.antigravity.access, "access-2");
		assert.equal(saved.antigravity.refresh, "refresh-1");
		assert.equal(saved.antigravity.projectId, "proj-1");
		assert.equal(saved.antigravity.type, "oauth");
		assert.equal(saved["opencode-go"].key, "keep-me");
		assert.equal(statSync(path).mode & 0o777, 0o600);

		await models.getAuth(model); // still valid: no second refresh
		assert.equal(calls.refreshed.length, 1);
	});

	it("never logs in: that happens on a workstation", async () => {
		const provider = antigravityProvider(fakeImplementation({ refreshed: [], streamed: [] }));
		await assert.rejects((provider.auth.oauth as any).login({}), /never logs in/);
	});

	it("loads the real pi-antigravity package (TypeScript sources inside node_modules) with its state kept in the service's directory", async () => {
		const stateDir = tmp();
		process.env.PI_CODING_AGENT_DIR = stateDir;
		const implementation = await loadAntigravity({ stateDir });
		assert.equal(implementation.api, "antigravity-api");
		assert.match(implementation.endpoint, /^https:\/\//);
		assert.ok(implementation.models.length > 0);
		const provider = antigravityProvider(implementation);
		const models = createModels({ credentials: new FileCredentialStore(authFile({})) });
		models.setProvider(provider);
		assert.ok(models.getModel("antigravity", implementation.models[0]!.id));
		const key = JSON.parse(implementation.apiKey(stored() as never));
		assert.deepEqual(key, { token: "access-1", projectId: "proj-1" });
	});

	it("hands the stored (refreshed) token to the stream function when a model runs through the registry", async () => {
		const calls = { refreshed: [] as string[], streamed: [] as { apiKey?: string }[] };
		const models = createModels({ credentials: new FileCredentialStore(authFile({ antigravity: stored({ expires: Date.now() - 1000 }) })) });
		models.setProvider(antigravityProvider(fakeImplementation(calls)));
		const model = models.getModel("antigravity", "gemini-test")!;
		const context: Context = { systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };
		await models.completeSimple(model, context);
		assert.equal(calls.streamed.length, 1);
		assert.deepEqual(JSON.parse(calls.streamed[0]!.apiKey!), { token: "access-2", projectId: "proj-1" });
	});
});

describe("per-job model choice", () => {
	function harness(allowedModels?: { provider: string; modelId: string }[]) {
		const requests: AgentRequest[] = [];
		const { remote } = makeRemote();
		const workspaceRoot = join(tmp(), "workspaces");
		const runtime: AgentRuntime = {
			start: async () => {},
			health: () => ({ ready: true }),
			close: async () => {},
			execute: async (request) => {
				requests.push(request);
				return { status: "done", answer: "nothing to change", usage: emptyUsage() };
			},
		};
		const env = new NodeExecutionEnv({ cwd: workspaceRoot });
		const handler = createHandler({
			runtime,
			session: { env, identity: { name: "Pi", email: "pi@test.invalid" } },
			host: new FakeHost(),
			workspaceRoot,
			client: {} as never,
			limits: { maxTokensCap: 100_000, maxMinutesCap: 10 },
			allowedModels,
		});
		const run = (model: unknown) =>
			handler(
				{ taskId: "task_1", task: {}, input: { repository: { url: remote, ref: "main" }, instruction: "x", budget: { maxTokens: 5000, maxMinutes: 1 }, ...(model === undefined ? {} : { model }) } } as unknown as Job,
				{ signal: new AbortController().signal } as unknown as JobControl,
			);
		return { requests, run };
	}
	const allowed = [{ provider: "openai-codex", modelId: "gpt-5.5" }, { provider: "opencode-go", modelId: "kimi-k3" }];
	const failureCode = (outcome: any) => outcome.failure?.code;

	it("passes an allowed model to the runtime and leaves the default alone when none is asked for", async () => {
		const { requests, run } = harness(allowed);
		await run({ provider: "opencode-go", id: "kimi-k3" });
		await run(undefined);
		assert.deepEqual(requests[0]!.model, { provider: "opencode-go", modelId: "kimi-k3" });
		assert.equal(requests[1]!.model, undefined);
	});

	it("refuses a model that is not on the allowlist, before any work starts", async () => {
		const { requests, run } = harness(allowed);
		assert.equal(failureCode(await run({ provider: "antigravity", id: "gemini-3.8-flash" })), "model_not_allowed");
		assert.equal(failureCode(await run({ provider: "opencode-go", id: "other" })), "model_not_allowed");
		assert.equal(requests.length, 0);
	});

	it("refuses every explicit model when the service has no allowlist, and malformed requests", async () => {
		const { requests, run } = harness(undefined);
		assert.equal(failureCode(await run({ provider: "openai-codex", id: "gpt-5.5" })), "model_not_allowed");
		const withList = harness(allowed);
		for (const bad of ["kimi", {}, { provider: "x" }, { provider: 1, id: 2 }, null]) assert.equal(failureCode(await withList.run(bad)), "invalid_input");
		assert.equal(requests.length + withList.requests.length, 0);
	});
});

