import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HandlerStore, handlersDir, type ServiceContext } from "@somework/agent-kit";
import { datadogTriageHooksFor } from "../src/hooks.ts";
import { DATADOG_TOOLS } from "../src/datadog/tools.ts";

const setup = (over: { concurrency?: number; keys?: string | null; env?: Record<string, string> } = {}) => {
	const dir = mkdtempSync(join(tmpdir(), "dd-hooks-"));
	const keys = join(dir, "keys.json");
	if (over.keys !== null) writeFileSync(keys, over.keys ?? JSON.stringify({ apiKey: "a".repeat(32), appKey: "b".repeat(40) }), { mode: 0o600 });
	mkdirSync(join(dir, "state"));
	const context = { env: { DD_CREDENTIALS_FILE: keys, ...over.env }, config: { concurrency: over.concurrency ?? 1, state: { dir: join(dir, "state") } }, log: () => undefined, client: { post: async () => ({}) } } as unknown as ServiceContext;
	return { context, dir, keys };
};

describe("the hooks of the service", () => {
	it("composes: the Datadog tools, the chat, the readiness check and the seeded handler", async () => {
		const { context, dir } = setup();
		const hooks = await datadogTriageHooksFor(context);
		assert.equal(hooks.extensions?.length, 1);
		assert.deepEqual((hooks.extensions![0] as any).tools.map((tool: any) => tool.name), [...DATADOG_TOOLS]);
		assert.deepEqual(hooks.chat?.askToolNames, [...DATADOG_TOOLS]);
		assert.equal(await hooks.readinessChecks!.datadog_credentials!(), true);
		assert.ok(hooks.prepareInput && hooks.instruction && hooks.beforeRun && hooks.result && hooks.wrapRuntime && hooks.onSettled);
		assert.equal(hooks.envFactory, undefined, "the model's tools run in the sandbox");
		assert.ok(new HandlerStore(handlersDir(join(dir, "state"))).current("datadog"));
	});

	it("refuses to start when the deployment cannot work", async () => {
		await assert.rejects(() => datadogTriageHooksFor(setup({ concurrency: 2 }).context), /PI_CONCURRENCY must be 1/);
		await assert.rejects(() => datadogTriageHooksFor(setup({ keys: null }).context), /cannot be read: ENOENT/);
		await assert.rejects(() => datadogTriageHooksFor(setup({ keys: '{"apiKey": "x"}' }).context), /needs apiKey and appKey/);
		await assert.rejects(() => datadogTriageHooksFor(setup({ env: { DD_SITE: "example.com" } }).context), /DD_SITE/);
		await assert.rejects(() => datadogTriageHooksFor(setup({ env: { DD_TRIAGE_BUDGET_TOKENS: "900000" } }).context), /at most 300000/);
	});

	it("does not leak the key file's content when it is damaged", async () => {
		const secret = "s3cr3t-key-value-1234567890";
		await assert.rejects(
			() => datadogTriageHooksFor(setup({ keys: `{"apiKey": "${secret}", oops` }).context),
			(error: Error) => /not valid JSON/.test(error.message) && !error.message.includes(secret),
		);
	});

	it("reports the credentials unusable when the file disappears after the start", async () => {
		const { context, keys } = setup();
		const hooks = await datadogTriageHooksFor(context);
		writeFileSync(keys, "{}");
		assert.equal(await hooks.readinessChecks!.datadog_credentials!(), false);
		chmodSync(keys, 0o600);
		assert.ok(existsSync(keys));
	});
});
