import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { Identity, SomeWorkClient, Worker } from "@somework/sdk";
import { loadConfig, type Config } from "./config.ts";
import { FileCredentialStore } from "./credentials.ts";
import { scriptedModels } from "./fake-model.ts";
import { GitHubHost, noPullRequests } from "./githost.ts";
import { DailyLedger } from "./ledger.ts";
import { jsonLogger } from "./log.ts";
import { Metrics } from "./metrics.ts";
import { PiDurableRuntime } from "./pi-runtime.ts";
import { approvalPolicy } from "./policy.ts";
import { registerProviders } from "./providers/index.ts";
import { RemoteExecutionEnv } from "./sandbox/remote-env.ts";
import { createHandler, createHealthServer } from "./service.ts";

const read = (path: string): string => readFileSync(path, "utf8").trim();

/** Registers the providers of every allowed model (see `PI_ALLOWED_MODELS`); the default model is `PI_PROVIDER`/`PI_MODEL`. */
async function buildModels(config: Config): Promise<{ models: Models; model: { provider: string; modelId: string } }> {
	if (config.model.provider === "faux") {
		// credential-free smoke/crash drills only; never a default
		const fake = scriptedModels(JSON.parse(process.env.PI_FAUX_PLAN ?? '["final:ok"]'));
		return { models: fake.models, model: fake.model };
	}
	const models = createModels({ credentials: new FileCredentialStore(config.state.authFile) });
	await registerProviders(models, config.allowedModels, { stateDir: join(config.state.dir, "antigravity") });
	return { models, model: { provider: config.model.provider, modelId: config.model.modelId } };
}

async function main(): Promise<void> {
	const config = loadConfig();
	const log = jsonLogger();
	const metrics = new Metrics();
	const identity = Identity.fromFile(config.somework.keyFile);
	const client = new SomeWorkClient({ baseUrl: config.somework.url, identity, caFile: config.somework.caFile, requireTls: config.somework.requireTls });

	const sandboxToken = read(config.sandbox.tokenFile);
	const sandboxCa = config.sandbox.caFile ? readFileSync(config.sandbox.caFile, "utf8") : undefined;
	const envFor = (cwd: string | undefined) => new RemoteExecutionEnv({ baseUrl: config.sandbox.url, token: sandboxToken, cwd: cwd ?? config.sandbox.workspaceRoot, id: `sandbox:${new URL(config.sandbox.url).host}`, caPem: sandboxCa });

	const { models, model } = await buildModels(config);
	const runtime = new PiDurableRuntime({ storagePath: join(config.state.dir, "pi.sqlite"), models, model, env: envFor, policy: approvalPolicy(config.approvalPatterns), log, metrics });
	await runtime.start();

	const gitToken = config.git.tokenFile ? read(config.git.tokenFile) : undefined;
	const handler = createHandler({
		runtime,
		session: { env: envFor(config.sandbox.workspaceRoot), token: gitToken, identity: { name: config.git.authorName, email: config.git.authorEmail } },
		host: gitToken ? new GitHubHost({ token: gitToken, apiBase: config.git.githubApi, draft: config.git.draftPullRequests }) : noPullRequests,
		workspaceRoot: config.sandbox.workspaceRoot,
		client,
		limits: config.limits,
		allowedModels: config.allowedModels,
		ledger: new DailyLedger(join(config.state.dir, "ledger.json"), config.limits.dailyTokenLimit),
		shards: config.shards ? { table: config.shards, agentId: identity.agentId } : undefined,
		metrics,
		log,
	});

	const health = createHealthServer({
		runtime,
		metrics,
		checks: { sandbox: async () => (await fetch(`${config.sandbox.url}/healthz`, { signal: AbortSignal.timeout(2000) })).ok },
	});
	health.listen(config.healthPort, "0.0.0.0");

	const stop = new AbortController();
	for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort());
	const worker = new Worker(client, { handler, concurrency: config.concurrency, leaseSeconds: config.leaseSeconds, shutdownGraceMs: 20_000, logger: (level, message, fields) => log(level, message, fields) });
	log("info", "service_started", { agentId: identity.agentId, provider: model.provider, concurrency: config.concurrency });
	await worker.run(stop.signal);
	health.close();
	await runtime.close();
	log("info", "service_stopped");
	// Everything durable is committed. A tool call still in flight (an open connection to the sandbox) must not keep the process
	// alive: exiting closes it, the sandbox kills that command's process tree, and the run resumes from its checkpoint on restart.
	process.exit(0);
}

main().catch((error) => {
	jsonLogger()("error", "fatal", { error: error instanceof Error ? error.message : String(error) });
	process.exit(1);
});
