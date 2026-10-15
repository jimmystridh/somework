import { join } from "node:path";
import { InvalidInput, resolveSlack, silent, type Log, type ResultPatch, type RoleHooks, type ServiceContext } from "@somework/agent-kit";
import { ChangeJournal } from "./changes.ts";
import { triageChat } from "./chat.ts";
import { developerOverDomain } from "./developer.ts";
import { TriageEngine, type Trigger, type TriageOutcome } from "./engine.ts";
import { JiraClient } from "./jira/client.ts";
import { seedHandler } from "./seed.ts";
import { loadSettings, readJiraSecrets, type TriageSettings } from "./settings.ts";
import { slackWebApi, type SlackPort } from "./slack.ts";
import { TriageStore } from "./store.ts";
import { RefusingRuntime, startWorker } from "./worker.ts";

const TICKET = /^[A-Z][A-Z0-9_]*-[0-9]{1,9}$/;
const AUTHOR = /^[A-Za-z0-9._@-]{1,100}$/;
const KINDS = ["created", "updated", "comment", "manual"] as const;

/** What a job asks for: one ticket and what prompted it. Event text reaches here only as a key, a few field names and the author and id of a comment. */
export function parseTriageInput(input: any): { ticket: string; trigger: Trigger } {
	const ticket = typeof input?.ticket === "string" ? input.ticket.trim() : "";
	if (!TICKET.test(ticket)) throw new InvalidInput("ticket must be a Jira ticket key such as SAD-123 (jira.ticket.create is served in conversation, not as a job)");
	const raw = input?.trigger;
	const kind = raw?.kind;
	if (!(KINDS as readonly string[]).includes(kind)) throw new InvalidInput(`trigger.kind must be one of ${KINDS.join(", ")}`);
	const eventKey = typeof raw.eventKey === "string" && raw.eventKey !== "" ? raw.eventKey.slice(0, 120) : undefined;
	const base = eventKey ? { eventKey } : {};
	switch (kind as (typeof KINDS)[number]) {
		case "created":
			return { ticket, trigger: { kind: "created", ...base } };
		case "updated":
			return { ticket, trigger: { kind: "updated", ...base, ...(Array.isArray(raw.changed) ? { changed: raw.changed.filter((name: unknown): name is string => typeof name === "string").map((name: string) => name.slice(0, 60)).slice(0, 30) } : {}) } };
		case "comment":
			return { ticket, trigger: { kind: "comment", ...base, ...(typeof raw.commentId === "string" && raw.commentId !== "" ? { commentId: raw.commentId.slice(0, 20) } : {}), ...(typeof raw.author === "string" && AUTHOR.test(raw.author) ? { author: raw.author } : {}) } };
		case "manual":
			return { ticket, trigger: { kind: "manual", ...base, ...(raw.force === true ? { force: true } : {}) } };
	}
}

/**
 * The role's code on top of the kit's job handler (which works without a repository here): the job is the way an event reaches the engine.
 *  - `prepareInput` checks the job's input and names the instruction;
 *  - `beforeWorkspace` runs the engine's pass over the ticket and always ends the job there as blocked: no clone, no model call, no token spent (the
 *    metrics count such a job as blocked; the result says what really happened);
 *  - `result` reports where the triage stands: the engine keeps the ticket going on its own after the job is done.
 */
export function createTriageHooks(options: { engine: TriageEngine; log?: Log }): RoleHooks {
	const log = options.log ?? silent;
	return {
		prepareInput(input) {
			const parsed = parseTriageInput(input);
			return { ...input, ticket: parsed.ticket, trigger: parsed.trigger };
		},
		instruction(input) {
			return `Triage ${String(input.ticket)} (${String(input.trigger.kind)}).`;
		},
		async beforeWorkspace(input) {
			const outcome = await options.engine.handle(input.ticket, input.trigger);
			log("info", "jira_triage_job", { ticket: outcome.ticket, status: outcome.status });
			return { blocked: { reason: outcome.summary, details: outcome } };
		},
		result(_base, context): ResultPatch {
			const outcome = context.blocked?.details as TriageOutcome | undefined;
			if (!outcome) return { failure: { code: "job_error", message: "the triage ended without an outcome", retryable: true } };
			return { result: { status: outcome.status, ticket: outcome.ticket, summary: outcome.summary, ...(outcome.via ? { via: outcome.via } : {}), ...(outcome.missing ? { missing: outcome.missing } : {}) } };
		},
		wrapRuntime: (inner) => new RefusingRuntime(inner),
	};
}

export interface Composed {
	hooks: RoleHooks;
	engine: TriageEngine;
	stop(): void;
}

/** Everything the service needs that depends on the deployment, in one place; the ports are replaceable for tests. */
export function composeTriage(context: ServiceContext, settings: TriageSettings, ports: { jira: JiraClient; slack?: SlackPort }): Composed {
	const stateDir = join(context.config.state.dir, "jira-triage");
	const store = new TriageStore(stateDir);
	const journal = new ChangeJournal(join(stateDir, "changes.jsonl"));
	const developer = settings.enrichment ? developerOverDomain(context.client, settings.developerAgent) : undefined;
	const notify = async (message: string): Promise<void> => {
		await context.client.post(
			"/v1/messages",
			{ type: "chat.notice", recipients: [{ kind: "agent", id: settings.notifyTo }], triggerMode: "never", content: { mediaType: "text/plain", data: message.slice(0, 3900) }, labels: { eventNotice: "true" } },
			{ idempotencyKey: `jira-triage-notice:${Buffer.from(message).toString("base64url").slice(0, 60)}:${Math.floor(Date.now() / 60_000)}` },
		);
	};
	const engine = new TriageEngine({
		settings: {
			projects: settings.projects,
			markerLabel: settings.markerLabel,
			needsInfoLabel: settings.needsInfoLabel,
			language: settings.language,
			mode: settings.mode,
			quietMs: settings.quietMs,
			quietMaxMs: settings.quietMaxMs,
			areaLabels: settings.areaLabels,
			enrichment: settings.enrichment,
			developerWaitMs: settings.developerWaitMs,
			developerPollMs: settings.developerPollMs,
			reporterWaitMs: settings.reporterWaitMs,
			reporterPollMs: settings.reporterPollMs,
			maxRounds: settings.maxRounds,
			retrySchedule: settings.retrySchedule,
			maxAttempts: settings.maxAttempts,
			dryRun: settings.dryRun,
		},
		jira: ports.jira,
		store,
		journal,
		...(developer ? { developer } : {}),
		...(ports.slack ? { slack: ports.slack } : {}),
		notify,
		browseUrl: (key) => ports.jira.browseUrl(key),
		log: context.log,
	});
	seedHandler({ stateDir: context.config.state.dir, settings, log: context.log, reseed: context.env.JIRA_RESEED_HANDLER === "1" });
	const worker = startWorker({ engine, intervalMs: settings.tickMs, log: context.log });
	const chat = triageChat({
		settings,
		engine,
		journal,
		jira: ports.jira,
		create: { jira: ports.jira, settings, store, ...(ports.slack ? { displayName: (member: string) => ports.slack!.displayName(member) } : {}), log: context.log },
		log: context.log,
	});
	const base = createTriageHooks({ engine, log: context.log });
	return { hooks: { ...base, chat }, engine, stop: worker.stop };
}

/** For `runAgentService`: the hooks of the service being composed. Fails at startup when the deployment cannot work. */
export async function jiraTriageHooksFor(context: ServiceContext): Promise<RoleHooks> {
	const settings = loadSettings(context.env);
	const secrets = readJiraSecrets(settings.jira);
	const jira = new JiraClient({ baseUrl: settings.jira.url, token: secrets.token, ...(secrets.pfx ? { pfx: secrets.pfx } : {}), ...(secrets.passphrase !== undefined ? { passphrase: secrets.passphrase } : {}), ...(secrets.ca ? { ca: secrets.ca } : {}) });
	const slackStart = resolveSlack(context.config.slack);
	const slack = slackStart.enabled ? slackWebApi(slackStart.botToken) : undefined;
	context.log("info", "jira_triage_configured", { mode: settings.mode, quietMinutes: settings.quietMs / 60_000, areaLabels: settings.areaLabels, projects: settings.projects, slackQuestions: Boolean(slack), enrichment: settings.enrichment, dryRun: settings.dryRun, developer: settings.enrichment ? settings.developerAgent : undefined });
	return composeTriage(context, settings, { jira, ...(slack ? { slack } : {}) }).hooks;
}
