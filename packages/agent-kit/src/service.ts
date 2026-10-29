import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, type Models } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Identity, runWakes, SomeWorkClient } from "@somework/sdk";
import type { Handler } from "./job-types.ts";
import { AGENT_STATUS_TOOL, buildState, createStatusTool } from "./threads/state.ts";
import type { InboundMessage } from "./threads/message.ts";
import { loadConfig, type Config } from "./config.ts";
import { FileCredentialStore } from "./credentials.ts";
import { createEventsComponent } from "./events/component.ts";
import { resolveEvents } from "./events/config.ts";
import { JobGate } from "./gate.ts";
import { Approvals } from "./threads/approvals.ts";
import { JobArtifacts } from "./threads/artifacts.ts";
import { KIT_THREAD_RULES, ThreadEngine } from "./threads/engine.ts";
import { JobManager, requestIdOf, type JobEntry } from "./threads/jobs.ts";
import { RunRecall } from "./recall.ts";
import { RunTrace } from "./trace.ts";
import { AgentDirectory } from "./threads/directory.ts";
import { MessageSender, type Sender } from "./threads/message.ts";
import { createJobReporter, topicSlug } from "./threads/reporter.ts";
import { ResourceRegistry } from "./threads/resources.ts";
import { resolveThreadSettings } from "./threads/settings.ts";
import { DurableInbox, DurableTable } from "./threads/store.ts";
import { createThreadTools, describeJob, threadKey, type RunContext } from "./threads/tools.ts";
import { GitHubAppCredentials } from "./github-app.ts";
import { branchesNaming as branchesNamingIn, mergeRefsInto, prepareWorkspace, startMirrorRefresh, type GitSession } from "./git.ts";
import { GitHubHost, noPullRequests } from "./githost.ts";
import { createHandler, type HandlerDeps } from "./handler.ts";
import { describeAgent, isoDateOrUndefined, withChangeMarker } from "./describe.ts";
import { createHealthServer } from "./health.ts";
import { JobJournal } from "./journal.ts";
import { createBudgetIntercept } from "./budget-control.ts";
import { Drain, drainFileIn } from "./drain.ts";
import { DailyLedger } from "./ledger.ts";
import { jsonLogger } from "./log.ts";
import { Metrics } from "./metrics.ts";
import { PiDurableRuntime } from "./pi-runtime.ts";
import { approvalPolicy } from "./policy.ts";
import { Preflight } from "./preflight.ts";
import { McpHub } from "./mcp/hub.ts";
import { createMcpTools, MCP_CALL_TOOL, MCP_TOOL_NAMES } from "./mcp/tools.ts";
import { libraryExtension, SKILL_LIBRARY_TOOL } from "./setup/library.ts";
import { createSetupIntercept } from "./setup/intake.ts";
import { Setup } from "./setup/setup.ts";
import { validateProfile, type AgentProfile, type RoleHooks, type ServiceContext } from "./profile.ts";
import { scriptedModels } from "./providers/faux.ts";
import { allowlist, type ModelRef } from "./providers/allowlist.ts";
import { modelCheck } from "./providers/effective-model.ts";
import { codexProxyFrom } from "./providers/codex-proxy.ts";
import { registerProviders } from "./providers/index.ts";
import { RemoteExecutionEnv } from "./sandbox/remote-env.ts";
import { keepRuntimeAlive } from "./runtime-lifecycle.ts";
import { overlayFromDirectory, skillsExtension } from "./skills.ts";
import { createObserve } from "./observe/index.ts";
import { llmUsageCounters } from "./usage-metrics.ts";
import { createTimers } from "./timers/index.ts";
import { createPlane } from "./plane/index.ts";
import { createWatches } from "./watches/index.ts";
import { resolveSlack, SlackChannel, slackApi, slackApprovals, SlackSender, slackSocketUrl, SlackStore, type SlackStart } from "./slack/index.ts";
import { resolveTelegram, TelegramChannel, telegramApi, telegramApprovals, telegramFiles, TelegramSender, TelegramStore, type TelegramStart } from "./telegram/index.ts";
import { combinedLocal, RoutedSender } from "./threads/channels.ts";

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

/** Registers the providers of every allowed model (see `PI_ALLOWED_MODELS`); the default model is `PI_PROVIDER`/`PI_MODEL`, with `PI_EFFORT` when set. */
async function buildModels(config: Config, env: NodeJS.ProcessEnv): Promise<{ models: Models; model: ModelRef }> {
	if (config.model.provider === "faux") {
		// credential-free smoke/crash drills only; never a default
		const fake = scriptedModels(JSON.parse(env.PI_FAUX_PLAN ?? '["final:ok"]'));
		return { models: fake.models, model: { ...fake.model, ...(config.model.effort ? { effort: config.model.effort } : {}) } };
	}
	const models = createModels({ credentials: new FileCredentialStore(config.state.authFile) });
	const codexProxy = codexProxyFrom(env);
	await registerProviders(models, config.allowedModels, { stateDir: join(config.state.dir, "antigravity"), ...(codexProxy ? { codexProxy } : {}) });
	return { models, model: config.model };
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
			const drain = new Drain({ file: drainFileIn(config.state.dir), metrics, log });
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
			const threadSettings = resolveThreadSettings(profile.chat, env);
			// the client the role's code and the job handler use: a job is work the domain has no task for, so what it uploads goes without a source task and its references are kept for the result message
			const jobArtifacts = new JobArtifacts({ log });
			const taskClient = jobArtifacts.wrap(client);
			const timers = createTimers({ env, agentId: identity.agentId, log });
			const watches = createWatches({ env, agentId: identity.agentId, log });
			// the git session is built after the role's hooks (it needs the hooks' environment): a role that asks for branches reaches it through this
			const gitSessionLate: { current?: GitSession } = {};
			const branchesNaming = async (repoUrl: string, ticket: string) => (gitSessionLate.current ? branchesNamingIn(gitSessionLate.current, repoUrl, ticket) : []);
			const mergeRefs = async (workspace: string, refs: string[]) => {
				if (!gitSessionLate.current) throw new Error("the git session is not ready");
				return mergeRefsInto(gitSessionLate.current, workspace, refs);
			};
			const hooks: RoleHooks = typeof options.hooks === "function" ? await options.hooks({ env, config, log, client: taskClient, gitToken, ...(hasOwnerTokens ? { ownerTokens } : {}), gitTokenSource, ...(timers ? { timers: timers.client } : {}), ...(watches ? { watches: watches.client } : {}), branchesNaming, mergeRefs }) : (options.hooks ?? {});
			const envFor: (cwd: string | undefined) => ExecutionEnv = hooks.envFactory ?? remoteEnvFactory(config);

			const { models, model } = await buildModels(config, env);
			const proxy = codexProxyFrom(env);
			if (proxy && config.model.provider !== "faux") log("info", "codex_proxy_enabled", { url: proxy.url, api: proxy.api, provider: "openai-codex" });
			const skillAllow = config.skills.allow ?? profile.skills.allow;
			const setupModels = allowlist(model, config.allowedModels);
			const modelRefusal = modelCheck({ allowed: setupModels, find: (provider, modelId) => models.getModel(provider, modelId) });
			const defaultRefusal = modelRefusal(model);
			if (defaultRefusal) throw new Error(`the configured model cannot be used: ${defaultRefusal}`);
			let ledgerRef: DailyLedger | undefined;
			let runtimeRef: PiDurableRuntime | undefined;
			const plane = createPlane({ env, conversationOf: (api) => (runtimeRef?.contextOf(api.conversationId as number) as RunContext | undefined)?.conversationId, log });
			const mcpHub = new McpHub({ root: join(config.state.dir, "mcp"), env, log });
			// what an operator set is loaded before anything that reads it is built: the limits go into config.limits, the model into the runtime below
			const setup = new Setup({
				agentId: identity.agentId,
				dir: join(config.state.dir, "setup"),
				defaults: { approvalPatterns: profile.approvalPatterns.map(([pattern, reason]) => ({ pattern: pattern.source, reason })), repositorySkills: skillAllow, model, allowedModels: setupModels },
				hub: mcpHub,
				checkModel: modelRefusal,
				setModel: (wanted) => runtimeRef?.setModel(wanted),
				applyLimits: (limits) => {
					Object.assign(config.limits, { maxTokensCap: limits.maxTokensCap, maxMinutesCap: limits.maxMinutesCap, dailyTokenLimit: limits.dailyTokenLimit, budgetRaiseCeiling: limits.budgetRaiseCeiling });
					ledgerRef?.setDailyTokenLimit(limits.dailyTokenLimit);
				},
				log,
			});
			await setup.restore();
			const eventsConfig = resolveEvents(profile.events, env);
			const ledger = new DailyLedger(
				join(config.state.dir, "ledger.json"),
				config.limits.dailyTokenLimit,
				undefined,
				// the daily limit is the one budget: events and chat may use all of it, with no share or weekly cap of their own
				eventsConfig.enabled ? { share: 1, throttleAt: eventsConfig.throttleAt } : undefined,
				{ share: threadSettings.share > 0 ? 1 : 0, throttleAt: threadSettings.throttleAt },
			);
			ledgerRef = ledger;
			// a woken run gets the fleet's caps as well, and follows a change of them while the agent runs
			eventsConfig.wakeBudget = { get maxTokens() { return config.limits.maxTokensCap; }, get maxMinutes() { return config.limits.maxMinutesCap; } };
			const journal = new JobJournal(join(config.state.dir, "jobs.json"));
			let jobsRef: JobManager | undefined;
			let engineRef: ThreadEngine | undefined;
			// the event component needs the runtime for woken runs and the runtime needs the component's tools: the runtime is looked up late
			const events = eventsConfig.enabled
				? createEventsComponent({
						config: eventsConfig,
						stateDir: config.state.dir,
						client,
						startJob: async (event, task) => {
							if (!profile.capabilities.some((capability) => capability.id === task.capability.id && capability.version === String(task.capability.version))) throw new Error(`this agent does not serve ${task.capability.id}@${task.capability.version}`);
							const notify = eventsConfig.notifyTo ? [{ kind: "agent", id: eventsConfig.notifyTo }] : [];
							const entry = jobsRef!.start(
								{ capability: { id: task.capability.id, version: String(task.capability.version) }, input: task.input, label: `${task.capability.id} for ${event.topic}`, requestedBy: { kind: "service", id: `event:${event.topic}` }, audience: notify, source: "event" },
								`job-${createHash("sha256").update(`${event.id}\u0000${identity.agentId}\u0000${task.capability.id}`).digest("hex").slice(0, 12)}`,
							);
							return { jobId: entry.id };
						},
						runtime: { execute: (request, runHooks) => runtimeRef!.execute(request, runHooks) },
						envFor,
						workspaceRoot: config.sandbox.workspaceRoot,
						ledger,
						agent: { id: identity.agentId, role: profile.id, capabilities: profile.capabilities },
						log,
						metrics,
						draining: () => drain.active,
					})
				: undefined;
			const observe = createObserve({ profile: profile.observe, env, log, metrics, agentId: identity.agentId });
			// the thread layer's pieces are made after the runtime and the tools need them: they are looked up late
			const resources = new ResourceRegistry();
			const domainSender = new MessageSender(client, threadSettings.replyMaxBytes);
			// the agent's own Telegram bot, when it has a token and a list of people who may write to it
			const telegramStart: TelegramStart = threadSettings.enabled ? resolveTelegram(config.telegram) : { enabled: false };
			if (!telegramStart.enabled && telegramStart.reason) log("warn", "telegram_disabled", { reason: telegramStart.reason });
			const telegram = telegramStart.enabled ? (() => {
				const store = new TelegramStore(join(config.state.dir, "telegram"), identity.agentId);
				const api = telegramApi(telegramStart.token);
				const telegramSender = new TelegramSender({ api, store, agentId: identity.agentId, maxBytes: 8192, log });
				return { start: telegramStart, store, api, files: telegramFiles(telegramStart.token, api), sender: telegramSender };
			})() : undefined;
			// the agent's own Slack app (Socket Mode), when it has both tokens and a list of people who may write to it
			const slackStart: SlackStart = threadSettings.enabled ? resolveSlack(config.slack) : { enabled: false };
			if (!slackStart.enabled && slackStart.reason) log("warn", "slack_disabled", { reason: slackStart.reason });
			const slack = slackStart.enabled ? (() => {
				const store = new SlackStore(join(config.state.dir, "slack"), identity.agentId);
				const api = slackApi({ botToken: slackStart.botToken, appToken: slackStart.appToken });
				const slackSender = new SlackSender({ api, store, agentId: identity.agentId, maxBytes: 8192, log });
				return { start: slackStart, store, api, sender: slackSender, openConnection: slackSocketUrl(slackStart.appToken) };
			})() : undefined;
			const chatChannels = [telegram, slack].filter((channel) => channel !== undefined);
			const sender: Sender = chatChannels.length > 0 ? new RoutedSender(domainSender, chatChannels) : domainSender;
			const stateBase = (): Promise<string> =>
				buildState({ agentId: identity.agentId, role: profile.id, capabilities: profile.capabilities, ledger, journal, health: () => runtimeRef?.health() ?? { ready: false, reason: "starting" }, draining: () => drain.active, events: events ? () => events.status() : undefined, roleContext: hooks.chat?.context });
			const threadState = async (): Promise<string> => {
				const active = jobsRef?.active() ?? [];
				const held = resources.holders() ?? [];
				return [
					await stateBase(),
					"",
					`jobs running or waiting (${active.length}):`,
					...(active.length > 0 ? active.map((job) => `  ${describeJob(job)}`) : ["  (none)"]),
					...(held.length > 0 ? ["resources held:", ...held.map((hold) => `  ${hold.resource}: ${hold.label}`)] : []),
					`conversations in progress: ${engineRef?.active ?? 0}, waiting: ${engineRef?.queued ?? 0}`,
				].join("\n");
			};
			const statusTool = createStatusTool(threadState);
			const agentDirectory = new AgentDirectory(client, identity.agentId);
			// the record of every model run, and the way back into it: both exist only while the record is kept
			const runTrace = config.trace?.enabled ? new RunTrace({ dir: config.trace.dir, agentId: identity.agentId, role: profile.id, log, keepDays: config.trace.keepDays, maxTotalBytes: config.trace.maxMegabytes * 1024 * 1024 }) : undefined;
			const runRecall = config.trace?.enabled ? new RunRecall({ dir: config.trace.dir }) : undefined;
			const threadTools = createThreadTools(
				{
					context: (id) => runtimeRef?.contextOf(id) as RunContext | undefined,
					saveAttachment: async (context, request) => {
						const bytes = await client.downloadArtifact({ artifactId: request.artifactId, ...(request.version ? { version: request.version } : {}) }, { maxBytes: 50 * 1024 * 1024 });
						const name = (request.name ?? request.artifactId).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 100) || "attachment";
						const directory = `${config.sandbox.workspaceRoot.replace(/\/$/, "")}/.threads/${threadKey(context)}`;
						const target = envFor(config.sandbox.workspaceRoot);
						await target.createDir(directory, { recursive: true }, BACKGROUND_CONTEXT);
						const written = await target.writeFile(`${directory}/${name}`, bytes, BACKGROUND_CONTEXT);
						if (!written.ok) throw new Error("it could not be written to the scratch directory");
						return { path: `${directory}/${name}`, bytes: bytes.length };
					},
					jobs: () => jobsRef!,
					resources: () => resources,
					sender: () => sender,
					directory: () => agentDirectory,
					...(runTrace ? { notes: () => runTrace } : {}),
					...(runRecall ? { recall: () => runRecall } : {}),
				},
				hooks.chat?.jobTools ?? [],
			);
			const fileOverlay = overlayFromDirectory(config.skills.overlayDir ?? profile.skills.overlayDir);
			const extensions = [
				...(hooks.extensions ?? []),
				...(events ? [events.extension] : []),
				statusTool.extension,
				threadTools.extension,
				...(observe ? [observe.extension] : []),
				...(timers ? [timers.extension] : []),
				...(watches ? [watches.extension] : []),
				...(plane ? [plane.extension] : []),
				...(hooks.chat?.extension ? [hooks.chat.extension] : []),
				skillsExtension({ allow: () => setup.repositorySkills(skillAllow), version: () => setup.version(), readOverlay: (name) => setup.overlay(name) ?? fileOverlay(name), log }),
				libraryExtension(() => setup.librarySkills()).extension,
				createMcpTools(mcpHub).extension,
			];
			// the thread tools are registered with the runtime but offered only to conversations: jobs get the role's own tools, with the coding tools spelled out when it lists none
			const normalTools = [...(profile.allowedTools ?? ["read", "write", "edit", "bash"]), ...(events?.toolNames ?? []), ...(observe?.toolNames ?? []), ...(timers?.toolNames ?? []), ...(watches?.toolNames ?? [])];
			const llmUsage = llmUsageCounters(metrics, { agent: identity.agentId, role: profile.id });
			llmUsage.start(setup.model());
			const runtime = new PiDurableRuntime({
				storagePath: join(config.state.dir, "pi.sqlite"),
				models,
				model,
				env: envFor,
				policy: approvalPolicy(config.approvalPatterns, profile.approvalPatterns, profile.toolApprovals, {
					patterns: () => setup.approvalPatterns(),
					tool: (tool, args) => (tool === MCP_CALL_TOOL ? mcpHub.approvalSummary(String(args.server), String(args.tool), args.arguments) : undefined),
				}),
				operator: { instructions: () => setup.instructionsAddendum(), tools: () => setup.operatorTools(), toolNames: [SKILL_LIBRARY_TOOL, ...MCP_TOOL_NAMES] },
				instructions: profile.systemPrompt,
				allowedTools: normalTools,
				extensions,
				log,
				metrics,
				onUsage: llmUsage.record,
				...(runTrace ? { trace: runTrace } : {}),
			});
			runtimeRef = runtime;
			runtime.setModel(setup.model());
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
			gitSessionLate.current = session;
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
				resolveModel: (request) => setup.modelForJob(request),
				metrics,
				log,
				profile,
				hooks,
				journal,
			};
			const jobHandler = createHandler({ ...baseDeps, ledger, source: "job" });
			const root = config.sandbox.workspaceRoot.replace(/\/$/, "");
			const approvals = new Approvals({ client, log, timeoutMinutes: threadSettings.approvalMinutes, approvers: threadSettings.approvers, channel: [...(telegram ? [telegramApprovals(telegram.store, telegram.sender)] : []), ...(slack ? [slackApprovals(slack.store, slack.sender)] : [])] });
			const slug = topicSlug(identity.agentId);
			const stop = new AbortController();
			drain.watch(stop.signal);
			const reporter = createJobReporter({
				sender,
				agentId: identity.agentId,
				publish: async (state, payload) => {
					await client.publishEvent({ topic: `agent.${slug}.job.${state}`, key: `${payload.jobId}:${state}`, source: slug, data: payload as unknown as Record<string, never> });
				},
				describeResult: hooks.chat?.describeResult,
				...(runTrace ? { notes: runTrace } : {}),
				log,
			});
			const jobs = new JobManager({
				handler: jobHandler,
				resources,
				gate: new JobGate(config.concurrency),
				store: new DurableTable<JobEntry>(join(config.state.dir, "threads", "jobs.json")),
				reporter,
				takeArtifacts: (jobId) => jobArtifacts.take(jobId),
				steer: (jobId, text) => runtime.steer(requestIdOf(jobId), text),
				approve: async (entry, request, signal) => {
					const approver = approvals.approverFor(entry.requestedBy);
					if (!approver) return { approved: false, reason: "nobody is set up to approve" };
					return approvals.ask({ approver, ...(entry.conversationId ? { conversationId: entry.conversationId } : {}), ...(entry.replyTo ? { replyTo: entry.replyTo } : {}), agent: identity.agentId, tool: request.tool, summary: request.summary, signal });
				},
				resourcesFor: hooks.chat?.jobResources,
				budget: profile.defaultBudget,
				draining: () => drain.active,
				signal: stop.signal,
				log,
			});
			jobsRef = jobs;
			const knownTools = new Set(runtime.knownTools());
			const conversationTools = [...new Set(["read", "write", "edit", "bash", ...(profile.allowedTools ?? []), AGENT_STATUS_TOOL, ...(hooks.chat?.toolNames ?? []), ...(observe?.toolNames ?? []), ...(timers?.toolNames ?? []), ...(watches?.toolNames ?? []), ...(plane?.toolNames ?? []), ...threadTools.toolNames])].filter((name) => knownTools.has(name));
			const threadWorkspace = async (key: string): Promise<string> => {
				const directory = `${root}/.threads/${key}`;
				await envFor(root).createDir(directory, { recursive: true }, BACKGROUND_CONTEXT);
				const target = hooks.chat?.checkout?.();
				if (target) await prepareWorkspace(session, { repoUrl: target.repoUrl, ref: target.ref ?? "HEAD", taskId: "threads", workspace: `${root}/.threads/checkout`, detach: true }).catch((error) => log("warn", "checkout_failed", { error: String(error).slice(0, 200) }));
				return directory;
			};
			const intercepts: ((message: InboundMessage) => Promise<boolean>)[] = [];
			const engine = new ThreadEngine({
				client,
				agentId: identity.agentId,
				runtime: taskRuntime,
				jobs,
				inbox: new DurableInbox(join(config.state.dir, "threads", "inbox.json")),
				approvals,
				sender,
				settings: threadSettings,
				tools: conversationTools,
				instructions: [hooks.chat?.instructions ?? `You are ${identity.agentId}, the ${profile.id} agent of this platform. You offer these capabilities: ${profile.capabilities.map((c) => `${c.id}@${c.version}`).join(", ")}.`, KIT_THREAD_RULES].join("\n\n"),
				state: threadState,
				...(chatChannels.length > 0 ? { local: combinedLocal(chatChannels.map((channel) => channel.store)) } : {}),
				...(runTrace ? { notes: runTrace } : {}),
				...(runRecall ? { recall: runRecall } : {}),
				workspace: threadWorkspace,
				ledger,
				caps: () => config.limits,
				setupKey: () => setup.conversationSuffix(),
				intercept: async (message) => {
					for (const intercept of intercepts) if (await intercept(message).catch(() => false)) return true;
					return false;
				},
				signal: stop.signal,
				log,
				metrics,
			});
			engineRef = engine;


			const preflight = hooks.preflight
				? new Preflight({ checks: (checkContext) => hooks.preflight!(checkContext), log, metrics, secrets: [gitToken, ...Object.values(ownerTokens)].filter((value): value is string => Boolean(value)), everyMs: config.preflight.minutes * 60_000 })
				: undefined;
			const describe = () => withChangeMarker(
				describeAgent({
					profile,
					agentId: identity.agentId,
					version: env.AGENT_VERSION,
					model: runtime.model,
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
					chat: { mode: threadSettings.enabled ? "threads" : "off", approvers: threadSettings.approvers },
					events: { enabled: eventsConfig.enabled, notifyTo: eventsConfig.notifyTo },
					observe: { enabled: Boolean(observe), ...(observe ? { scope: env.OBSERVE_SCOPE || "own" } : {}) },
					timers: { enabled: Boolean(timers) },
					watches: { enabled: Boolean(watches) },
					plane: { enabled: Boolean(plane) },
					telegram: { enabled: Boolean(telegram), allowedUsers: telegram?.start.allowed.size ?? 0 },
					slack: { enabled: Boolean(slack), allowedUsers: slack?.start.allowedUsers.size ?? 0, channels: slack?.start.allowedChannels.size ?? 0 },
					setup: setup.report({ model: runtime.model }),
					...(preflight ? { preflight: { everyMinutes: config.preflight.minutes, checks: preflight.results() } } : {}),
					includePrompt: env.PROFILE_PROMPT !== "0",
				}),
				join(config.state.dir, "profile-hash.json"),
			);
			const health = createHealthServer({
				runtime,
				metrics,
				draining: () => drain.active,
				profile: describe,
				history: (limit) => journal.recent(limit),
				...(preflight ? { preflight } : {}),
				status: () => ({ ...(events ? events.status() : { handlers: [], tokenPools: ledger.usage() }), chat: { mode: threadSettings.enabled ? "threads" : "off", approvers: threadSettings.approvers, jobs: jobs.active().length, conversations: engine.active, queued: engine.queued }, ...(observe ? { observe: observe.status() } : {}) }),
				checks: { ...(hooks.envFactory ? {} : { sandbox: async () => (await fetch(`${config.sandbox.url}/healthz`, { signal: AbortSignal.timeout(2000) })).ok }), ...hooks.readinessChecks },
			});
			health.listen(config.healthPort, hooks.healthBind ?? "0.0.0.0");
			preflight?.start(stop.signal);

			if (config.git.mirror && config.git.mirror.repositories.length > 0) {
				startMirrorRefresh({ session, repositories: config.git.mirror.repositories, everyMinutes: config.git.mirror.refreshMinutes, signal: stop.signal, log: (level, event, fields) => log(level, event, fields) });
			}
			for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.once(signal, () => stop.abort());
			const budgetIntercept = createBudgetIntercept({
				ledger,
				controllers: config.limits.budgetControllers ?? eventsConfig.controllers,
				ceiling: () => config.limits.budgetRaiseCeiling,
				reply: async (message, text) => {
					await client.post("/v1/messages", { type: "chat.notice", recipients: [{ kind: message.sender.kind, id: message.sender.id }], ...(message.conversationId ? { conversationId: message.conversationId } : {}), replyTo: message.messageId, causationId: message.messageId, triggerMode: "never", content: { mediaType: "text/plain", data: text } }, { idempotencyKey: `budget:${message.messageId}` });
				},
				log,
			});
			// the kill switch for event handlers and budget raises are looked at before a message becomes a conversation
			intercepts.push(createSetupIntercept({ agentId: identity.agentId, domainId: identity.audience.replace(/^somework:/, ""), client, setup, log }));
			intercepts.push(async (message) => (await budgetIntercept(message)) || (events ? await events.intercept(message) : false));
			if (events) void events.run(stop.signal).catch((error) => log("error", "events_stopped", { error: error instanceof Error ? error.message : String(error) }));
			if (threadSettings.enabled) {
				const conversationsGauge = metrics.gauge("somework_conversations", "Conversations the agent is in, by state");
				const jobsGauge = metrics.gauge("somework_jobs", "Jobs of the agent that have not finished, by state");
				const measure = (): void => {
					conversationsGauge.set(engine.active, { state: "running" });
					conversationsGauge.set(engine.queued, { state: "waiting" });
					const open = jobs.active();
					for (const state of ["waiting", "running"] as const) jobsGauge.set(open.filter((job) => job.state === state).length, { state });
				};
				measure();
				const measuring = setInterval(measure, 10_000);
				stop.signal.addEventListener("abort", () => clearInterval(measuring), { once: true });
				const recovered = engine.start();
				const resumed = jobs.recover();
				if (telegram) {
					const channel = new TelegramChannel({
						api: telegram.api,
						files: telegram.files,
						store: telegram.store,
						allowed: telegram.start.allowed,
						agentId: identity.agentId,
						accept: (message) => engine.acceptLocal(message),
						about: () => `I am ${identity.agentId}, the ${profile.id} agent of this platform. I offer: ${profile.capabilities.map((capability) => `${capability.id}@${capability.version}`).join(", ")}.`,
						status: threadState,
						jobs,
						approvals,
						messagesPerHour: config.telegram.messagesPerHour,
						pollSeconds: config.telegram.pollSeconds,
						log,
						metrics,
					});
					void channel.run(stop.signal).catch((error) => log("error", "telegram_stopped", { error: String(error).slice(0, 160) }));
				}
				if (slack) {
					const channel = new SlackChannel({
						api: slack.api,
						openConnection: slack.openConnection,
						store: slack.store,
						allowedUsers: slack.start.allowedUsers,
						allowedChannels: slack.start.allowedChannels,
						agentId: identity.agentId,
						accept: (message) => engine.acceptLocal(message),
						about: () => `I am ${identity.agentId}, the ${profile.id} agent of this platform. I offer: ${profile.capabilities.map((capability) => `${capability.id}@${capability.version}`).join(", ")}.`,
						status: threadState,
						jobs,
						approvals,
						messagesPerHour: config.slack.messagesPerHour,
						log,
						metrics,
					});
					void channel.run(stop.signal).catch((error) => log("error", "slack_stopped", { error: String(error).slice(0, 160) }));
				}
				log("info", "threads_recovered", { messages: recovered, jobs: resumed.length });
				// the domain's inbox is the safety net under the wakes: what came while the agent was down, or whose wake was lost, is taken in here
				const sweep = (): void => void engine.sweep().then((taken) => (taken > 0 ? log("info", "inbox_swept", { messages: taken }) : undefined)).catch((error) => log("warn", "inbox_sweep_failed", { error: String(error).slice(0, 160) }));
				sweep();
				const sweeping = setInterval(sweep, 60_000);
				stop.signal.addEventListener("abort", () => clearInterval(sweeping), { once: true });
				void runWakes(
					client,
					stop.signal,
					(wake) => {
						if (wake.kind !== "message") return void wake.ack().catch(() => {});
						// acknowledged only once the message is safely in the inbox: an announcement that failed is made again
						engine
							.accept(wake.messageId)
							.then(() => wake.ack())
							.catch((error) => log("warn", "message_not_accepted", { messageId: wake.messageId, error: String(error).slice(0, 160) }));
					},
					{ logger: (level, message, fields) => log(level, `message_wake: ${message}`, fields) },
				).catch((error) => {
					if (!stop.signal.aborted) log("error", "message_wakes_stopped", { error: String(error).slice(0, 160) });
				});
			}
			const runtimeLife = keepRuntimeAlive({ client, meta: { role: profile.id, ...(env.AGENT_VERSION ? { version: env.AGENT_VERSION } : {}) }, signal: stop.signal, log });
			await runtimeLife.registered;
			log("info", "service_started", { role: profile.id, agentId: identity.agentId, provider: model.provider, concurrency: config.concurrency, skills: skillAllow.length, threads: threadSettings.enabled, events: eventsConfig.enabled, telegram: Boolean(telegram), slack: Boolean(slack) });
			await new Promise<void>((resolve) => stop.signal.addEventListener("abort", () => resolve(), { once: true }));
			// running jobs are left as they are (they are written to disk and taken up again at the next start); give them a moment to stop cleanly
			await Promise.race([jobs.idle(), new Promise<void>((resolve) => setTimeout(resolve, 20_000))]);
			health.close();
			await runtimeLife.ended();
			await runtime.close();
			await mcpHub.close();
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
