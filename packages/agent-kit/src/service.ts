import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, type Models } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Identity, SomeWorkClient, Worker } from "@somework/sdk";
import { loadConfig, type Config } from "./config.ts";
import { FileCredentialStore } from "./credentials.ts";
import { GitHubHost, noPullRequests } from "./githost.ts";
import { createHandler } from "./handler.ts";
import { createHealthServer } from "./health.ts";
import { DailyLedger } from "./ledger.ts";
import { jsonLogger } from "./log.ts";
import { Metrics } from "./metrics.ts";
import { PiDurableRuntime } from "./pi-runtime.ts";
import { approvalPolicy } from "./policy.ts";
import { validateProfile, type AgentProfile, type RoleHooks, type ServiceContext } from "./profile.ts";
import { scriptedModels } from "./providers/faux.ts";
import { registerProviders } from "./providers/index.ts";
import { RemoteExecutionEnv } from "./sandbox/remote-env.ts";
import { skillsExtension } from "./skills.ts";

const read = (path: string): string => readFileSync(path, "utf8").trim();

/** The container sandbox over HTTP; the token and CA are read when the first environment is made. */
function remoteEnvFactory(config: Config): (cwd: string | undefined) => ExecutionEnv {
	const sandboxToken = read(config.sandbox.tokenFile);
	const sandboxCa = config.sandbox.caFile ? readFileSync(config.sandbox.caFile, "utf8") : undefined;
	return (cwd) => new RemoteExecutionEnv({ baseUrl: config.sandbox.url, token: sandboxToken, cwd: cwd ?? config.sandbox.workspaceRoot, id: `sandbox:${new URL(config.sandbox.url).host}`, caPem: sandboxCa });
}

export interface AgentServiceOptions {
	profile: AgentProfile;
	/** The role's code. A function receives the service being composed (settings, log, client, git token) and returns the hooks. */
	hooks?: RoleHooks | ((context: ServiceContext) => RoleHooks | Promise<RoleHooks>);
	/** Settings come from here (default: the process environment). */
	env?: NodeJS.ProcessEnv;
}

/** Registers the providers of every allowed model (see `PI_ALLOWED_MODELS`); the default model is `PI_PROVIDER`/`PI_MODEL`. */
async function buildModels(config: Config, env: NodeJS.ProcessEnv): Promise<{ models: Models; model: { provider: string; modelId: string } }> {
	if (config.model.provider === "faux") {
		// credential-free smoke/crash drills only; never a default
		const fake = scriptedModels(JSON.parse(env.PI_FAUX_PLAN ?? '["final:ok"]'));
		return { models: fake.models, model: fake.model };
	}
	const models = createModels({ credentials: new FileCredentialStore(config.state.authFile) });
	await registerProviders(models, config.allowedModels, { stateDir: join(config.state.dir, "antigravity") });
	return { models, model: { provider: config.model.provider, modelId: config.model.modelId } };
}

/**
 * Composes a role into a running service: SomeWork identity and claim loop, the sandboxed Pi Durable runtime, the git workflow, budgets,
 * approvals, skills and health endpoints, all shaped by the role's profile. A role's `main.ts` is `await runAgentService({ profile })`.
 */
export function createAgentService(options: AgentServiceOptions): { run(): Promise<void> } {
	const profile = validateProfile(options.profile);
	const env = options.env ?? process.env;

	return {
		async run() {
			const config = loadConfig(env);
			const log = jsonLogger();
			const metrics = new Metrics();
			const identity = Identity.fromFile(config.somework.keyFile);
			const client = new SomeWorkClient({ baseUrl: config.somework.url, identity, caFile: config.somework.caFile, requireTls: config.somework.requireTls });

			const gitToken = config.git.tokenFile ? read(config.git.tokenFile) : undefined;
			const hooks: RoleHooks = typeof options.hooks === "function" ? await options.hooks({ env, config, log, client, gitToken }) : (options.hooks ?? {});
			const envFor: (cwd: string | undefined) => ExecutionEnv = hooks.envFactory ?? remoteEnvFactory(config);

			const { models, model } = await buildModels(config, env);
			const skillAllow = config.skills.allow ?? profile.skills.allow;
			const extensions = [...(hooks.extensions ?? []), ...(skillAllow.length > 0 ? [skillsExtension({ allow: skillAllow, overlayDir: config.skills.overlayDir ?? profile.skills.overlayDir, log })] : [])];
			const runtime = new PiDurableRuntime({
				storagePath: join(config.state.dir, "pi.sqlite"),
				models,
				model,
				env: envFor,
				policy: approvalPolicy(config.approvalPatterns, profile.approvalPatterns, profile.toolApprovals),
				instructions: profile.systemPrompt,
				allowedTools: profile.allowedTools,
				extensions,
				log,
				metrics,
			});
			await runtime.start();

			const handler = createHandler({
				runtime: hooks.wrapRuntime ? hooks.wrapRuntime(runtime) : runtime,
				envFor,
				session: { env: envFor(config.sandbox.workspaceRoot), token: gitToken, tokenHosts: config.git.tokenHosts, identity: { name: config.git.authorName, email: config.git.authorEmail } },
				host: gitToken ? new GitHubHost({ token: gitToken, apiBase: config.git.githubApi, draft: config.git.draftPullRequests }) : noPullRequests,
				workspaceRoot: config.sandbox.workspaceRoot,
				client,
				limits: config.limits,
				allowedModels: config.allowedModels,
				ledger: new DailyLedger(join(config.state.dir, "ledger.json"), config.limits.dailyTokenLimit),
				shards: config.shards ? { table: config.shards, agentId: identity.agentId } : undefined,
				metrics,
				log,
				profile,
				hooks,
			});

			const health = createHealthServer({
				runtime,
				metrics,
				checks: { ...(hooks.envFactory ? {} : { sandbox: async () => (await fetch(`${config.sandbox.url}/healthz`, { signal: AbortSignal.timeout(2000) })).ok }), ...hooks.readinessChecks },
			});
			health.listen(config.healthPort, hooks.healthBind ?? "0.0.0.0");

			const stop = new AbortController();
			for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.once(signal, () => stop.abort());
			const worker = new Worker(client, { handler, concurrency: config.concurrency, leaseSeconds: config.leaseSeconds, shutdownGraceMs: 20_000, logger: (level, message, fields) => log(level, message, fields) });
			log("info", "service_started", { role: profile.id, agentId: identity.agentId, provider: model.provider, concurrency: config.concurrency, skills: skillAllow.length });
			await worker.run(stop.signal);
			health.close();
			await runtime.close();
			log("info", "service_stopped");
			// Everything durable is committed. A tool call still in flight (an open connection to the sandbox) must not keep the process
			// alive: exiting closes it, the sandbox kills that command's process tree, and the run resumes from its checkpoint on restart.
			process.exit(0);
		},
	};
}

/** For a role's `main.ts`: runs the service and turns a startup failure into a logged exit code 1. */
export function runAgentService(options: AgentServiceOptions): void {
	createAgentService(options)
		.run()
		.catch((error) => {
			jsonLogger()("error", "fatal", { error: error instanceof Error ? error.message : String(error) });
			process.exit(1);
		});
}
