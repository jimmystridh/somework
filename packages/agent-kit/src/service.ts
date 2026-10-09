import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, type Models } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Identity, SomeWorkClient, Worker, type Handler } from "@somework/sdk";
import { runChatResponder } from "./chat.ts";
import { ChatArtifacts } from "./chat-artifacts.ts";
import { askToolNames, buildState, ChatApprovals, createStatusTool, instructToolNames, KIT_CHAT_RULES, KIT_OPEN_CHAT_RULES, ModelChatResponder, resolveChatMode, resolveChatModel } from "./chat-model.ts";
import { loadConfig, type Config } from "./config.ts";
import { FileCredentialStore } from "./credentials.ts";
import { createEventsComponent } from "./events/component.ts";
import { resolveEvents } from "./events/config.ts";
import { JobGate } from "./gate.ts";
import { GitHubAppCredentials } from "./github-app.ts";
import { prepareWorkspace, startMirrorRefresh, type GitSession } from "./git.ts";
import { GitHubHost, noPullRequests } from "./githost.ts";
import { createHandler, type HandlerDeps } from "./handler.ts";
import { describeAgent, isoDateOrUndefined, withChangeMarker } from "./describe.ts";
import { createHealthServer } from "./health.ts";
import { JobJournal } from "./journal.ts";
import { createBudgetIntercept } from "./budget-control.ts";
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
import { createObserve } from "./observe/index.ts";
import { llmUsageCounters } from "./usage-metrics.ts";
import { createTimers } from "./timers/index.ts";

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
			metrics.constantLabels({ agent: identity.agentId });
			const client = new SomeWorkClient({ baseUrl: config.somework.url, identity, caFile: config.somework.caFile, requireTls: config.somework.requireTls });

			const gitApp = config.git.app
				? new GitHubAppCredentials({ appId: config.git.app.appId, privateKeyPem: read(config.git.app.keyFile), installationId: config.git.app.installationId, repositories: config.git.app.repositories, apiBase: config.git.githubApi })
				: undefined;
			const gitTokenSource = gitApp ? () => gitApp.token() : undefined;
			// minted once at start so a wrong key or installation stops the service here and not in the middle of a task
			const gitToken = gitApp ? await gitApp.token() : config.git.tokenFile ? read(config.git.tokenFile) : undefined;
			const ownerTokens = Object.fromEntries(Object.entries(config.git.ownerTokenFiles).map(([owner, file]) => [owner, read(file)]));
			const hasOwnerTokens = Object.keys(ownerTokens).length > 0;
			let gitIdentity = { name: config.git.authorName, email: config.git.authorEmail };
			if (gitApp && config.git.authorFromApp) {
				try {
					gitIdentity = await gitApp.identity();
				} catch (error) {
					log("warn", "git_app_identity_failed", { error: error instanceof Error ? error.message : String(error) });
				}
			}
			const chatSettings = resolveChatMode(profile.chat, env) === "model" ? resolveChatModel(profile.chat, env) : undefined;
			// the client the role's code and the task handler use: an instruction given in chat is a job the domain has no task for, so its uploads are kept on this host instead
			const chatArtifacts = chatSettings ? new ChatArtifacts({ dir: join(config.state.dir, "chat-artifacts"), log }) : undefined;
			const taskClient = chatArtifacts ? chatArtifacts.wrap(client) : client;
			const timers = createTimers({ env, agentId: identity.agentId, log });
			const hooks: RoleHooks = typeof options.hooks === "function" ? await options.hooks({ env, config, log, client: taskClient, gitToken, ...(hasOwnerTokens ? { ownerTokens } : {}), gitTokenSource, ...(timers ? { timers: timers.client } : {}) }) : (options.hooks ?? {});
			const envFor: (cwd: string | undefined) => ExecutionEnv = hooks.envFactory ?? remoteEnvFactory(config);

			const { models, model } = await buildModels(config, env);
			const eventsConfig = resolveEvents(profile.events, env);
			const ledger = new DailyLedger(
				join(config.state.dir, "ledger.json"),
				config.limits.dailyTokenLimit,
				undefined,
				eventsConfig.enabled ? { share: eventsConfig.tokenShare, weeklyTokens: eventsConfig.weeklyTokens, throttleAt: eventsConfig.throttleAt } : undefined,
				chatSettings ? { share: chatSettings.share, throttleAt: chatSettings.throttleAt } : undefined,
			);
			const journal = new JobJournal(join(config.state.dir, "jobs.json"));
			// the event component needs the runtime for woken runs and the runtime needs the component's tools: the runtime is looked up late
			let runtimeRef: PiDurableRuntime | undefined;
			const events = eventsConfig.enabled
				? createEventsComponent({
						config: eventsConfig,
						stateDir: config.state.dir,
						client,
						runtime: { execute: (request, runHooks) => runtimeRef!.execute(request, runHooks) },
						envFor,
						workspaceRoot: config.sandbox.workspaceRoot,
						ledger,
						agent: { id: identity.agentId, role: profile.id, capabilities: profile.capabilities },
						log,
						metrics,
					})
				: undefined;
			const skillAllow = config.skills.allow ?? profile.skills.allow;
			const chatState = (): Promise<string> =>
				buildState({ agentId: identity.agentId, role: profile.id, capabilities: profile.capabilities, ledger, journal, health: () => runtimeRef?.health() ?? { ready: false, reason: "starting" }, events: events ? () => events.status() : undefined, roleContext: hooks.chat?.context });
			const chatTools = chatSettings ? createStatusTool(chatState) : undefined;
			const observe = createObserve({ profile: profile.observe, env, log, metrics, agentId: identity.agentId });
			const extensions = [
				...(hooks.extensions ?? []),
				...(events ? [events.extension] : []),
				...(chatTools ? [chatTools.extension] : []),
				...(observe ? [observe.extension] : []),
				...(timers ? [timers.extension] : []),
				...(chatSettings && hooks.chat?.extension ? [hooks.chat.extension] : []),
				...(skillAllow.length > 0 ? [skillsExtension({ allow: skillAllow, overlayDir: config.skills.overlayDir ?? profile.skills.overlayDir, log })] : []),
			];
			// the chat's own tools are registered with the runtime but offered only to chat sessions: a role that lists no tools gets the coding tools spelled out
			const normalTools = profile.allowedTools ? [...profile.allowedTools, ...(events?.toolNames ?? []), ...(observe?.toolNames ?? []), ...(timers?.toolNames ?? [])] : chatTools ? ["read", "write", "edit", "bash", ...(events?.toolNames ?? []), ...(observe?.toolNames ?? []), ...(timers?.toolNames ?? [])] : undefined;
			const llmUsage = llmUsageCounters(metrics, { agent: identity.agentId, role: profile.id });
			llmUsage.start(model);
			const runtime = new PiDurableRuntime({
				storagePath: join(config.state.dir, "pi.sqlite"),
				models,
				model,
				env: envFor,
				policy: approvalPolicy(config.approvalPatterns, profile.approvalPatterns, profile.toolApprovals),
				instructions: profile.systemPrompt,
				allowedTools: normalTools,
				extensions,
				log,
				metrics,
				onUsage: llmUsage.record,
			});
			runtimeRef = runtime;
			await runtime.start();

			const session: GitSession = {
				env: envFor(config.sandbox.workspaceRoot),
				token: gitToken,
				...(hasOwnerTokens ? { ownerTokens } : {}),
				...(gitTokenSource ? { tokenSource: gitTokenSource } : {}),
				tokenHosts: config.git.tokenHosts,
				identity: gitIdentity,
				...(config.git.mirror ? { mirrorDir: config.git.mirror.dir } : {}),
			};
			const taskRuntime = hooks.wrapRuntime ? hooks.wrapRuntime(runtime) : runtime;
			const baseDeps: HandlerDeps = {
				runtime: taskRuntime,
				envFor,
				session,
				host: gitToken || hasOwnerTokens ? new GitHubHost({ ...(gitToken ? { token: gitTokenSource ?? gitToken } : {}), ownerTokens, apiBase: config.git.githubApi, draft: config.git.draftPullRequests }) : noPullRequests,
				workspaceRoot: config.sandbox.workspaceRoot,
				client: taskClient,
				limits: config.limits,
				allowedModels: config.allowedModels,
				metrics,
				log,
				profile,
				hooks,
				journal,
			};
			const taskHandler = createHandler({ ...baseDeps, ledger, shards: config.shards ? { table: config.shards, agentId: identity.agentId } : undefined });
			// requester tasks and chat instructions share the job slots: tasks first, nothing preempted
			const gate = new JobGate(config.concurrency);
			const handler: Handler = (job, control) => gate.run("task", () => taskHandler(job, control), control.signal);
			const root = config.sandbox.workspaceRoot.replace(/\/$/, "");
			// the open tier gives every role a shell and the file tools, whatever its job profile lists: the owner asked for agents that can run code
			const OPEN_BASE_TOOLS = ["read", "write", "edit", "bash"];
			let chatResponder: ModelChatResponder | undefined;
			if (chatSettings) {
				const known = new Set(runtime.knownTools());
				// the observe tools only read (logs and alert states, in the role's own scope) and are allowed in both chat tiers
				const ask = [...new Set([...askToolNames(profile.chat, hooks.chat), ...(observe?.toolNames ?? [])])];
				const instruct = [...new Set([...instructToolNames(profile.chat, profile.allowedTools), ...(observe?.toolNames ?? []), ...(timers?.toolNames ?? [])])];
				for (const name of [...ask, ...instruct]) if (!known.has(name)) throw new Error(`chat: the tool ${name} does not exist (known: ${[...known].join(", ")})`);
				const instructHandler = hooks.chat?.instructInput
					? createHandler({ ...baseDeps, source: "chat", requestTools: instruct, ledger: { remaining: () => ledger.chatRemaining(), record: (tokens) => ledger.record(tokens, "chat") } })
					: undefined;
				const approvals = new ChatApprovals({ client, log, timeoutMinutes: chatSettings.approvalMinutes });
				const askWorkspace = async (): Promise<string> => {
					const fallback = `${root}/.chat`;
					await envFor(root).createDir(fallback, { recursive: true }, BACKGROUND_CONTEXT);
					const target = hooks.chat?.checkout?.();
					if (!target) return fallback;
					const checkout = `${fallback}/checkout`;
					await prepareWorkspace(session, { repoUrl: target.repoUrl, ref: target.ref ?? "HEAD", taskId: "chat", workspace: checkout, detach: true });
					return checkout;
				};
				chatResponder = new ModelChatResponder({
					client,
					agentId: identity.agentId,
					role: profile.id,
					settings: chatSettings,
					ledger,
					ask: {
						runtime,
						tools: ask,
						instructions: [hooks.chat?.instructions ?? `You are ${identity.agentId}, the ${profile.id} agent of this platform. You offer these capabilities: ${profile.capabilities.map((c) => `${c.id}@${c.version}`).join(", ")}.`, KIT_CHAT_RULES].join("\n\n"),
						state: chatState,
						checkout: askWorkspace,
						fallbackWorkspace: `${root}/.chat`,
					},
					...(chatSettings.open
						? {
								open: {
									runtime,
									tools: [...new Set([...instruct, ...ask, ...OPEN_BASE_TOOLS])].filter((name) => known.has(name)),
									instructions: [hooks.chat?.openInstructions ?? `You are ${identity.agentId}, the ${profile.id} agent of this platform. You offer these capabilities: ${profile.capabilities.map((c) => `${c.id}@${c.version}`).join(", ")}. In a conversation with your owner's manager you do whatever is asked with your tools.`, KIT_OPEN_CHAT_RULES].join("\n\n"),
									workspace: askWorkspace,
									approvals,
									gate,
								},
							}
						: {}),
					...(instructHandler && hooks.chat?.instructInput ? { instruct: { handler: instructHandler, input: hooks.chat.instructInput, ...(hooks.chat.plainInstruct ? { plain: hooks.chat.plainInstruct } : {}), describe: hooks.chat.describeResult, gate, approvals, ...(chatArtifacts ? { artifacts: chatArtifacts } : {}) } } : {}),
					log,
					metrics,
				});
			}

			const description = withChangeMarker(
				describeAgent({
					profile,
					agentId: identity.agentId,
					version: env.AGENT_VERSION,
					model: config.model,
					allowedModels: config.allowedModels,
					limits: config.limits,
					concurrency: config.concurrency,
					approvalPatterns: config.approvalPatterns,
					git: {
						app: Boolean(gitApp),
						token: Boolean(gitToken) && !gitApp,
						tokenHosts: config.git.tokenHosts,
						tokenExpires: isoDateOrUndefined(env.GIT_TOKEN_EXPIRES),
						draft: Boolean(config.git.draftPullRequests),
						identity: gitApp ? gitIdentity.name : undefined,
						mirror: config.git.mirror ? { repositories: config.git.mirror.repositories, refreshMinutes: config.git.mirror.refreshMinutes } : undefined,
					},
					chat: chatSettings ? { mode: "model", askers: chatSettings.askers, instructors: chatSettings.instructors } : { mode: "notice" },
					events: { enabled: eventsConfig.enabled, notifyTo: eventsConfig.notifyTo },
					observe: { enabled: Boolean(observe), ...(observe ? { scope: env.OBSERVE_SCOPE || "own" } : {}) },
					timers: { enabled: Boolean(timers) },
					includePrompt: env.PROFILE_PROMPT !== "0",
				}),
				join(config.state.dir, "profile-hash.json"),
			);
			const health = createHealthServer({
				runtime,
				metrics,
				profile: () => description,
				history: (limit) => journal.recent(limit),
				status: () => ({ ...(events ? events.status() : { handlers: [], tokenPools: ledger.usage() }), ...(chatResponder ? { chat: { mode: "model", askers: chatSettings!.askers, instructors: chatSettings!.instructors } } : {}), ...(observe ? { observe: observe.status() } : {}) }),
				checks: { ...(hooks.envFactory ? {} : { sandbox: async () => (await fetch(`${config.sandbox.url}/healthz`, { signal: AbortSignal.timeout(2000) })).ok }), ...hooks.readinessChecks },
			});
			health.listen(config.healthPort, hooks.healthBind ?? "0.0.0.0");

			const stop = new AbortController();
			if (config.git.mirror && config.git.mirror.repositories.length > 0) {
				startMirrorRefresh({ session, repositories: config.git.mirror.repositories, everyMinutes: config.git.mirror.refreshMinutes, signal: stop.signal, log: (level, event, fields) => log(level, event, fields) });
			}
			for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.once(signal, () => stop.abort());
			const worker = new Worker(client, { handler, concurrency: config.concurrency, leaseSeconds: config.leaseSeconds, shutdownGraceMs: 20_000, logger: (level, message, fields) => log(level, message, fields) });
			const chat = env.CHAT_AUTOREPLY === "0" ? false : profile.chat?.autoReply !== false;
			const budgetIntercept = createBudgetIntercept({
				ledger,
				controllers: config.limits.budgetControllers ?? eventsConfig.controllers,
				ceiling: config.limits.budgetRaiseCeiling,
				reply: async (message, text) => {
					await client.post("/v1/messages", { type: "chat.notice", recipients: [{ kind: message.sender.kind, id: message.sender.id }], ...(message.conversationId ? { conversationId: message.conversationId } : {}), replyTo: message.messageId, causationId: message.messageId, triggerMode: "never", content: { mediaType: "text/plain", data: text } }, { idempotencyKey: `budget:${message.messageId}` });
				},
				log,
			});
			// answers to chat messages, the kill switch for event handlers and budget raises; it can never fail or delay the claim loop below
			void runChatResponder({ client, agentId: identity.agentId, role: profile.id, capabilities: profile.capabilities, signal: stop.signal, log, metrics, config: chat ? profile.chat : { ...profile.chat, autoReply: false }, intercept: async (message) => (await budgetIntercept(message)) || (events ? await events.intercept(message) : false), ...(chatResponder ? { model: chatResponder } : {}) });
			if (events) void events.run(stop.signal).catch((error) => log("error", "events_stopped", { error: error instanceof Error ? error.message : String(error) }));
			log("info", "service_started", { role: profile.id, agentId: identity.agentId, provider: model.provider, concurrency: config.concurrency, skills: skillAllow.length, chat, chatMode: chatSettings ? "model" : "notice", events: eventsConfig.enabled });
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
