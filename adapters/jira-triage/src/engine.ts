import { silent, type Log } from "@somework/agent-kit";
import { applyChanges, type Change, type ChangeJournal, type JiraWriter } from "./changes.ts";
import { definitionOf, evaluate, type Evaluation, type Evidence } from "./checklist.ts";
import type { DeveloperPort } from "./developer.ts";
import { isUnreachable, JiraError, type Comment, type Issue, type JiraUser } from "./jira/client.ts";
import { developerRequest, environmentLine, jiraQuestion, jiraSummary, notesText, parseFindings, slackQuestion, slackSummary, text, type Language } from "./questions.ts";
import type { SlackPort } from "./slack.ts";
import { changedSince, coversChecklist, fingerprintOf, projectOf, snapshotOf, type Snapshot } from "./snapshot.ts";
import { newRecord, type Outbox, type Reply, type TicketRecord, type TriageStore } from "./store.ts";
import { botComment, commentToken, hasEntry, isBotComment, tokenOfComment, wikiEscape, withNotes } from "./wiki.ts";

export interface JiraPort extends JiraWriter {
	getIssue(key: string): Promise<Issue>;
	comments(key: string): Promise<Comment[]>;
	addComment(key: string, body: string): Promise<{ id: string }>;
	user(name: string): Promise<JiraUser | undefined>;
}

export interface EngineSettings {
	projects: readonly string[];
	/** The label that says a ticket was triaged (or created) by the bot: a ticket that carries it is not triaged again. */
	markerLabel: string;
	/** Added while the reporter is being asked, taken away when the triage ends. */
	needsInfoLabel: string;
	language: Language;
	/** Ask the developer agent to look at a ticket whose technical context is missing, before the reporter is asked. */
	enrichment: boolean;
	developerWaitMs: number;
	developerPollMs: number;
	reporterWaitMs: number;
	reporterPollMs: number;
	maxRounds: number;
	/** Pauses between the failed passes over one ticket, in milliseconds; the last one repeats. */
	retrySchedule: readonly number[];
	/** Failed passes of a first triage after which it is given up (a person is told). */
	maxAttempts: number;
	/** Decide and record, but write nothing to Jira, message nobody and ask nobody. */
	dryRun: boolean;
}

export type Trigger =
	| { kind: "created"; eventKey?: string }
	| { kind: "updated"; eventKey?: string; changed?: readonly string[] }
	| { kind: "comment"; eventKey?: string; commentId?: string; author?: string; excerpt?: string }
	| { kind: "manual"; force?: boolean; eventKey?: string };

export type OutcomeStatus = "ignored" | "complete" | "asked_developer" | "asked_reporter" | "waiting" | "incomplete" | "no_answer" | "unreachable" | "retry" | "gave_up" | "dry_run";

export interface TriageOutcome {
	ticket: string;
	status: OutcomeStatus;
	summary: string;
	via?: "slack" | "jira";
	missing?: string[];
}

export interface EngineDeps {
	settings: EngineSettings;
	jira: JiraPort;
	store: TriageStore;
	journal: ChangeJournal;
	developer?: DeveloperPort;
	slack?: SlackPort;
	/** Tells the owner (the manager) about something that needs a person. */
	notify?: (message: string) => Promise<void>;
	browseUrl: (key: string) => string;
	log?: Log;
	now?: () => number;
	random?: () => number;
}

/** Jira's clock and this agent's need not agree: an answer within this much before the question was sent still counts. */
const CLOCK_SKEW_MS = 120_000;

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 3)}...` : value);
const ago = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))} minutes`;

/**
 * The triage of tickets, as a state machine over a durable record per ticket. A pass fetches the ticket, judges it against the checklist of its type, and
 * moves it on: complete (a label), a question to the developer agent (read-only, with a timeout), a question to the reporter (on Slack, else a comment) or
 * the end. The record is saved before anything is written to Jira, and what is to be written sits in the record until it is done, so that a crash or an
 * outage in the middle never loses a step and never repeats one. A failed pass is retried with a growing pause; waiting phases are looked at on a timer.
 */
export class TriageEngine {
	readonly #d: EngineDeps;
	readonly #log: Log;
	readonly #now: () => number;
	readonly #locks = new Map<string, Promise<unknown>>();
	readonly #recent: { at: number; ticket: string; summary: string }[] = [];

	constructor(deps: EngineDeps) {
		this.#d = deps;
		this.#log = deps.log ?? silent;
		this.#now = deps.now ?? Date.now;
	}

	get settings(): EngineSettings {
		return this.#d.settings;
	}

	projectAllowed(key: string): boolean {
		return this.#d.settings.projects.includes(projectOf(key));
	}

	/** An event or a request for one ticket. Returns what became of it; a failure inside is scheduled for a retry, not thrown. */
	async handle(key: string, trigger: Trigger): Promise<TriageOutcome> {
		if (!/^[A-Z][A-Z0-9_]*-[0-9]{1,9}$/.test(key)) return this.#ignored(key, "that is not a ticket key");
		if (!this.projectAllowed(key)) return this.#ignored(key, `${projectOf(key)} is not one of the projects this agent triages`);
		const claimed = trigger.eventKey !== undefined && trigger.kind !== "created";
		if (claimed && !this.#d.store.claimEvent(trigger.eventKey!)) return this.#ignored(key, "this event was already handled");
		try {
			return await this.#locked(key, () => this.#handle(key, trigger));
		} catch (error) {
			if (claimed) this.#d.store.releaseEvent(trigger.eventKey!);
			throw error;
		}
	}

	/** One look at every ticket whose time has come: retries that are due, answers that may have arrived, deadlines. */
	async tick(): Promise<TriageOutcome[]> {
		const now = this.#now();
		const due = this.#d.store.all().filter((record) => record.nextAttemptAt !== undefined && record.nextAttemptAt <= now);
		const outcomes: TriageOutcome[] = [];
		for (const record of due) outcomes.push(await this.#locked(record.id, async () => this.#wake(this.#d.store.get(record.id) ?? record)));
		return outcomes;
	}

	/** After a start: tickets that were mid-pass have no time set; they are due now. */
	recover(): number {
		let revived = 0;
		for (const record of this.#d.store.open()) {
			if (record.nextAttemptAt === undefined) {
				this.#save({ ...record, nextAttemptAt: this.#now() });
				revived += 1;
			}
		}
		return revived;
	}

	/** What the agent may say about its own queue. */
	facts(): string {
		const counts = this.#d.store.counts();
		const lines = [
			`Triage queue: ${counts.queued} waiting for a pass, ${counts.awaiting_developer} waiting for the developer agent, ${counts.awaiting_reporter} waiting for a reporter; ${counts.done} finished, ${counts.gave_up} given up.`,
			`Projects: ${this.#d.settings.projects.join(", ")}. Marker label: ${this.#d.settings.markerLabel}.${this.#d.settings.dryRun ? " DRY RUN: nothing is written to Jira, nobody is messaged." : ""}`,
			`Changes recorded for revert by hand: ${this.#d.journal.count()}.`,
		];
		if (this.#recent.length > 0) lines.push("Recent triages, newest first:", ...this.#recent.slice(-8).reverse().map((entry) => `- ${entry.ticket}: ${entry.summary}`));
		return lines.join("\n");
	}

	// ---- one ticket ------------------------------------------------------------------------------------------------

	async #locked<T>(key: string, work: () => Promise<T>): Promise<T> {
		const before = this.#locks.get(key) ?? Promise.resolve();
		const run = before.catch(() => undefined).then(work);
		this.#locks.set(key, run);
		try {
			return await run;
		} finally {
			if (this.#locks.get(key) === run) this.#locks.delete(key);
		}
	}

	#save(record: TicketRecord): TicketRecord {
		return this.#d.store.put(record, this.#now());
	}

	#outcome(ticket: string, status: OutcomeStatus, summary: string, extra: Partial<TriageOutcome> = {}): TriageOutcome {
		if (status !== "ignored") {
			this.#recent.push({ at: this.#now(), ticket, summary: clip(summary, 200) });
			if (this.#recent.length > 50) this.#recent.shift();
		}
		this.#log("info", "jira_triage_outcome", { ticket, status, summary: clip(summary, 200), ...(extra.via ? { via: extra.via } : {}), ...(extra.missing ? { missing: extra.missing } : {}) });
		return { ticket, status, summary, ...extra };
	}

	#ignored(ticket: string, reason: string): TriageOutcome {
		return this.#outcome(ticket, "ignored", reason);
	}

	async #handle(key: string, trigger: Trigger): Promise<TriageOutcome> {
		const now = this.#now();
		let record = this.#d.store.get(key);
		switch (trigger.kind) {
			case "created":
				if (record) return this.#ignored(key, "this ticket is already known");
				record = this.#save({ ...newRecord(key, "event", now), nextAttemptAt: now });
				break;
			case "manual":
				if (!record || (trigger.force === true && (record.phase === "done" || record.phase === "gave_up"))) record = this.#save({ ...newRecord(key, "manual", now), nextAttemptAt: now, retriage: true });
				else if (record.phase === "done") return this.#ignored(key, "this ticket was triaged already (ask again with force to run it again)");
				break;
			case "updated":
				if (!record) return this.#ignored(key, "this agent did not triage this ticket");
				if (trigger.changed && !coversChecklist(trigger.changed)) return this.#ignored(key, "only fields the checklist does not read changed");
				return this.#wake(this.#save({ ...record, recheck: true }));
			case "comment":
				if (!record || record.phase !== "awaiting_reporter") return this.#ignored(key, "nobody was asked about this ticket");
				if ((trigger.excerpt !== undefined && isBotComment(trigger.excerpt)) || (trigger.commentId !== undefined && record.botComments.includes(trigger.commentId))) return this.#ignored(key, "that comment is one the bot wrote");
				if (trigger.author !== undefined && record.reporter?.name !== undefined && trigger.author !== record.reporter.name) return this.#ignored(key, "that comment is not from the reporter");
				break;
		}
		return this.#wake(record);
	}

	/** One pass over a ticket in whatever phase it is in. Everything that can fail on Jira's side ends in a scheduled retry; a pass that gets through clears the failures counted against the ticket. */
	async #wake(start: TicketRecord): Promise<TriageOutcome> {
		const outcome = await this.#pass(start);
		if (outcome.status !== "retry" && outcome.status !== "gave_up") {
			const current = this.#d.store.get(start.id);
			if (current && current.attempts > 0) this.#save({ ...current, attempts: 0, lastError: undefined });
		}
		return outcome;
	}

	async #pass(start: TicketRecord): Promise<TriageOutcome> {
		let record = start;
		try {
			const issue = await this.#d.jira.getIssue(record.id);
			const snapshot = snapshotOf(issue);
			if (record.pending) record = await this.#flush(record, snapshot);
			if (record.recheck) return await this.#afterEdit(record, snapshot);
			switch (record.phase) {
				case "queued":
					return await this.#first(record, snapshot);
				case "awaiting_developer":
					return await this.#developerStep(record, snapshot);
				case "awaiting_reporter":
					return await this.#reporterStep(record, snapshot);
				default:
					this.#save({ ...record, nextAttemptAt: undefined });
					return this.#ignored(record.id, "nothing to do for this ticket");
			}
		} catch (error) {
			return this.#failed(this.#d.store.get(record.id) ?? record, error);
		}
	}

	async #first(record: TicketRecord, snapshot: Snapshot): Promise<TriageOutcome> {
		if (!record.retriage && snapshot.labels.includes(this.#d.settings.markerLabel)) {
			this.#save({ ...record, phase: "done", doneAt: this.#now(), nextAttemptAt: undefined, attempts: 0, baseline: fingerprintOf(snapshot), summary: `already carries ${this.#d.settings.markerLabel}` });
			return this.#ignored(record.id, `the ticket already carries ${this.#d.settings.markerLabel}: it was triaged or created by the bot`);
		}
		return this.#evaluateAndAct({ ...record, attempts: 0 }, snapshot);
	}

	/** A person may have changed what the checklist reads since the bot last looked: the fingerprint says, whoever's token wrote the change. */
	async #afterEdit(record: TicketRecord, snapshot: Snapshot): Promise<TriageOutcome> {
		const now = fingerprintOf(snapshot);
		const settled = { ...record, recheck: undefined, nextAttemptAt: record.phase === "done" || record.phase === "gave_up" ? undefined : record.nextAttemptAt };
		if (!record.baseline) {
			this.#save({ ...settled, baseline: now });
			return this.#ignored(record.id, "there was nothing to compare with yet");
		}
		const changed = changedSince(record.baseline, now);
		if (changed.length === 0) {
			this.#save(settled);
			return this.#ignored(record.id, "no field the checklist reads was changed by a person");
		}
		this.#log("info", "jira_triage_human_edit", { ticket: record.id, fields: changed });
		if (record.phase === "awaiting_developer") {
			this.#save({ ...settled, baseline: now });
			return this.#outcome(record.id, "waiting", `${changed.join(", ")} changed while the developer agent is looking: it is judged again afterwards`);
		}
		const reopened: TicketRecord = record.phase === "done" || record.phase === "gave_up" ? { ...settled, phase: "queued", rounds: 0, attempts: 0, retriage: true, asked: undefined, developer: undefined } : settled;
		return this.#evaluateAndAct({ ...reopened, baseline: now }, snapshot);
	}

	#evidence(record: TicketRecord): Evidence {
		return { replies: record.replies.map((reply) => reply.text), findings: record.developer?.findings ?? {} };
	}

	async #evaluateAndAct(record: TicketRecord, snapshot: Snapshot): Promise<TriageOutcome> {
		const verdict = evaluate(snapshot, this.#evidence(record));
		const ids = verdict.missing.map((item) => item.id);
		const withBaseline = { ...record, baseline: fingerprintOf(snapshot) };
		if (this.#d.settings.dryRun) {
			this.#save({ ...withBaseline, phase: "done", doneAt: this.#now(), nextAttemptAt: undefined, summary: `dry run: ${verdict.complete ? "complete" : `missing ${ids.join(", ")}`}` });
			return this.#outcome(record.id, "dry_run", verdict.complete ? "dry run: the ticket is complete, nothing was written" : `dry run: missing ${ids.join(", ")}; nobody was asked and nothing was written`, { missing: ids });
		}
		if (verdict.complete) return this.#finish(withBaseline, snapshot, "complete", []);
		const technical = verdict.missing.filter((item) => item.technical);
		if (this.#d.settings.enrichment && this.#d.developer && technical.length > 0 && !record.developer) return this.#askDeveloper(withBaseline, snapshot, verdict);
		return this.#askReporter(withBaseline, snapshot, verdict);
	}

	// ---- the developer agent ---------------------------------------------------------------------------------------

	async #askDeveloper(record: TicketRecord, snapshot: Snapshot, verdict: Evaluation): Promise<TriageOutcome> {
		const now = this.#now();
		const missing = verdict.missing.map((item) => ({ id: item.id, label: item.label }));
		try {
			const sent = await this.#d.developer!.ask({
				ticket: record.id,
				key: `${record.id}:${record.createdAt}:${record.rounds}`,
				text: developerRequest({ ticket: record.id, url: this.#d.browseUrl(record.id), type: snapshot.type, summary: snapshot.summary, description: snapshot.description, environment: snapshot.environment, missing }),
			});
			const saved = this.#save({ ...record, phase: "awaiting_developer", developer: { ...sent, deadline: now + this.#d.settings.developerWaitMs, status: "waiting" }, nextAttemptAt: now + this.#d.settings.developerPollMs, summary: "waiting for the developer agent" });
			this.#log("info", "jira_triage_developer_asked", { ticket: saved.id, conversationId: sent.conversationId, missing: missing.map((item) => item.id) });
			return this.#outcome(record.id, "asked_developer", `asked the developer agent for a read-only look (answer within ${ago(this.#d.settings.developerWaitMs)}); missing ${missing.map((item) => item.id).join(", ")}`, { missing: missing.map((item) => item.id) });
		} catch (error) {
			this.#log("warn", "jira_triage_developer_unavailable", { ticket: record.id, error: String(error).slice(0, 200) });
			return this.#askReporter({ ...record, developer: { conversationId: "", messageId: "", sentAt: new Date(now).toISOString(), deadline: now, status: "unavailable" } }, snapshot, verdict);
		}
	}

	async #developerStep(record: TicketRecord, snapshot: Snapshot): Promise<TriageOutcome> {
		const developer = record.developer;
		const now = this.#now();
		if (!developer || !this.#d.developer) return this.#evaluateAndAct({ ...record, phase: "queued", developer: developer ?? { conversationId: "", messageId: "", sentAt: "", deadline: now, status: "unavailable" } }, snapshot);
		let answer: Awaited<ReturnType<DeveloperPort["answer"]>>;
		try {
			answer = await this.#d.developer.answer({ conversationId: developer.conversationId, messageId: developer.messageId, sentAt: developer.sentAt, ticket: record.id });
		} catch (error) {
			this.#log("warn", "jira_triage_developer_unreadable", { ticket: record.id, error: String(error).slice(0, 160) });
		}
		if (!answer && now < developer.deadline) {
			this.#save({ ...record, nextAttemptAt: now + this.#d.settings.developerPollMs });
			return this.#outcome(record.id, "waiting", "still waiting for the developer agent");
		}
		const resolvable = evaluate(snapshot, { replies: record.replies.map((reply) => reply.text), findings: {} }).missing.filter((item) => definitionOf(item.id)?.resolvableByDeveloper).map((item) => item.id);
		const findings = parseFindings(answer?.text, resolvable);
		const notes = answer ? notesText(answer.text) : "";
		const pending: Outbox = { ...record.pending, ...(notes ? { notes: [...(record.pending?.notes ?? []), { title: text(this.#d.settings.language, "notesDeveloper"), text: notes }] } : {}) };
		this.#log("info", "jira_triage_developer_done", { ticket: record.id, answered: Boolean(answer), findings: Object.keys(findings) });
		const next = this.#save({ ...record, phase: "queued", developer: { ...developer, status: answer ? "answered" : "timed_out", findings }, pending: notes ? pending : record.pending, nextAttemptAt: now });
		const flushed = next.pending ? await this.#flush(next, snapshot) : next;
		return this.#evaluateAndAct(flushed, snapshot);
	}

	// ---- the reporter ----------------------------------------------------------------------------------------------

	/** The address Jira holds for the reporter. A Jira failure here is a failed pass, not a reason to ask somewhere else. */
	async #reporterEmail(snapshot: Snapshot, record: TicketRecord): Promise<string | undefined> {
		if (!this.#d.slack || record.reporter?.slackUserId || !snapshot.reporter) return undefined;
		return snapshot.reporter.email ?? (await this.#d.jira.user(snapshot.reporter.name))?.emailAddress;
	}

	async #askReporter(record: TicketRecord, snapshot: Snapshot, verdict: Evaluation): Promise<TriageOutcome> {
		const settings = this.#d.settings;
		const ids = verdict.missing.map((item) => item.id);
		if (record.rounds >= settings.maxRounds) return this.#finish(record, snapshot, "incomplete", ids);
		const reporter = snapshot.reporter;
		if (!reporter || !reporter.active) return this.#finish(record, snapshot, "unreachable", ids);
		const now = this.#now();
		const round = record.rounds + 1;
		const context = { language: settings.language, ticket: record.id, summary: snapshot.summary, url: this.#d.browseUrl(record.id), reporterName: reporter.name, ...(reporter.displayName ? { displayName: reporter.displayName } : {}), ids };
		let via: "slack" | "jira" | undefined;
		let slackState: TicketRecord["reporter"] = { name: reporter.name, ...(reporter.displayName ? { displayName: reporter.displayName } : {}), ...(record.reporter?.slackUserId ? { slackUserId: record.reporter.slackUserId } : {}), ...(record.reporter?.slackChannel ? { slackChannel: record.reporter.slackChannel } : {}) };
		let ts: string | undefined;
		if (this.#d.slack) {
			const email = await this.#reporterEmail(snapshot, record);
			try {
				const member = record.reporter?.slackUserId ?? (email ? await this.#d.slack.findUserByEmail(email) : undefined);
				if (!member) throw new Error(email ? "the reporter was not found on Slack" : "Jira holds no e-mail address for the reporter");
				const channel = slackState.slackChannel ?? (await this.#d.slack.openDirectMessage(member));
				const name = slackState.displayName ?? (await this.#d.slack.displayName(member));
				const posted = await this.#d.slack.post(channel, slackQuestion({ ...context, ...(name ? { displayName: name } : {}) }));
				slackState = { ...slackState, slackUserId: member, slackChannel: channel };
				ts = posted.ts;
				via = "slack";
			} catch (error) {
				this.#log("info", "jira_triage_slack_fallback", { ticket: record.id, reason: String(error instanceof Error ? error.message : error).slice(0, 120) });
			}
		}
		let comments = record.pending?.comments;
		let token: string | undefined;
		if (via === undefined) {
			token = commentToken(record.id, "ask", round);
			comments = [...(comments ?? []), { token, body: botComment(token, jiraQuestion(context)) }];
			via = "jira";
		}
		const saved = this.#save({
			...record,
			phase: "awaiting_reporter",
			rounds: round,
			reporter: slackState,
			asked: { round, via, at: now, ...(ts ? { ts } : {}), ...(token ? { token } : {}), items: ids, deadline: now + settings.reporterWaitMs },
			pending: { ...record.pending, ...(comments ? { comments } : {}), labels: this.#labelsToAdd([settings.markerLabel, settings.needsInfoLabel], record.pending?.labels) },
			nextAttemptAt: now,
			summary: `asked the reporter on ${via === "slack" ? "Slack" : "Jira"} about ${ids.join(", ")}`,
		});
		const flushed = await this.#flush(saved, snapshot);
		this.#save({ ...flushed, nextAttemptAt: now + settings.reporterPollMs });
		return this.#outcome(record.id, "asked_reporter", `asked ${reporter.displayName ?? reporter.name} on ${via === "slack" ? "Slack" : "a Jira comment"} about ${ids.map((id) => id).join(", ")} (question ${round} of at most ${settings.maxRounds})`, { via, missing: ids });
	}

	#labelsToAdd(wanted: readonly string[], existing: Outbox["labels"]): NonNullable<Outbox["labels"]> {
		return { add: [...new Set([...(existing?.add ?? []), ...wanted])].filter((label) => label !== ""), remove: existing?.remove ?? [] };
	}

	async #reporterStep(record: TicketRecord, snapshot: Snapshot): Promise<TriageOutcome> {
		const asked = record.asked;
		const now = this.#now();
		if (!asked) return this.#evaluateAndAct({ ...record, phase: "queued" }, snapshot);
		const found: Reply[] = [];
		const known = new Set(record.replies.map((reply) => reply.id));
		if (asked.via === "slack" && this.#d.slack && record.reporter?.slackChannel && record.reporter.slackUserId && asked.ts) {
			try {
				for (const message of await this.#d.slack.replies(record.reporter.slackChannel, asked.ts, record.reporter.slackUserId)) {
					const id = `slack:${message.ts}`;
					if (!known.has(id)) found.push({ id, via: "slack", at: new Date(Number(message.ts) * 1000).toISOString(), text: clip(message.text, 2000) });
				}
			} catch (error) {
				this.#log("warn", "jira_triage_slack_unreadable", { ticket: record.id, error: String(error).slice(0, 120) });
			}
		}
		const comments = await this.#d.jira.comments(record.id);
		for (const comment of comments) {
			const id = `jira:${comment.id}`;
			const created = Date.parse(comment.created ?? "");
			if (known.has(id) || record.botComments.includes(comment.id) || isBotComment(comment.body)) continue;
			if (comment.author?.name !== record.reporter?.name || !(created >= asked.at - CLOCK_SKEW_MS)) continue;
			found.push({ id, via: "jira", at: new Date(created).toISOString(), text: clip(comment.body, 2000) });
		}
		if (found.length > 0) return this.#absorb(record, snapshot, found);
		if (now >= asked.deadline) return this.#finish(record, snapshot, "no_answer", asked.items);
		this.#save({ ...record, lastPollAt: now, nextAttemptAt: now + this.#d.settings.reporterPollMs });
		return this.#outcome(record.id, "waiting", `still waiting for ${record.reporter?.displayName ?? record.reporter?.name ?? "the reporter"} (asked ${ago(now - asked.at)} ago)`);
	}

	/** The reporter answered: the answer goes into the ticket's notes, and the ticket is judged again with it. */
	async #absorb(record: TicketRecord, snapshot: Snapshot, found: Reply[]): Promise<TriageOutcome> {
		const settings = this.#d.settings;
		const before = evaluate(snapshot, this.#evidence(record));
		const replies = [...record.replies, ...found];
		const after = evaluate(snapshot, { ...this.#evidence(record), replies: replies.map((reply) => reply.text) });
		const notes = found.map((reply) => ({ title: `${text(settings.language, "notesAnswer")} (${reply.via === "slack" ? "Slack" : "Jira"})`, text: reply.text }));
		const wantsEnvironment = before.missing.some((item) => item.id === "environment-version") && !after.missing.some((item) => item.id === "environment-version") && snapshot.environment.trim() === "";
		const environmentText = wantsEnvironment ? environmentLine(found.map((reply) => reply.text).join("\n")) : undefined;
		const line = environmentText === undefined ? undefined : wikiEscape(environmentText);
		const planned = fingerprintOf({ ...snapshot, environment: line ?? snapshot.environment });
		// the answer is kept together with the decision to judge the ticket again: whatever fails next, the next pass starts from there and not from "still waiting"
		const saved = this.#save({ ...record, replies, phase: "queued", retriage: true, baseline: planned, pending: { ...record.pending, notes: [...(record.pending?.notes ?? []), ...notes], ...(line ? { environment: line } : {}) }, nextAttemptAt: this.#now() });
		const flushed = await this.#flush(saved, snapshot);
		this.#log("info", "jira_triage_reply", { ticket: record.id, via: found.map((reply) => reply.via), complete: after.complete });
		const next = flushed;
		if (after.complete) return this.#finish(next, snapshot, "complete", []);
		if (flushed.rounds >= settings.maxRounds) return this.#finish(next, snapshot, "incomplete", after.missing.map((item) => item.id));
		return this.#askReporter(next, snapshot, after);
	}

	// ---- the end ---------------------------------------------------------------------------------------------------

	async #finish(record: TicketRecord, snapshot: Snapshot, kind: "complete" | "incomplete" | "no_answer" | "unreachable", ids: readonly string[]): Promise<TriageOutcome> {
		const settings = this.#d.settings;
		const now = this.#now();
		const language = settings.language;
		const comments = [...(record.pending?.comments ?? [])];
		const asked = record.asked;
		if (kind === "complete" ? record.rounds > 0 : true) {
			const token = commentToken(record.id, "end", record.rounds);
			const body = jiraSummary(language, kind === "complete" ? "thanks" : kind === "incomplete" ? "stillMissing" : kind === "no_answer" ? "noAnswer" : "unreachable", ids, kind === "unreachable" ? undefined : record.reporter?.name);
			comments.push({ token, body: botComment(token, body) });
		}
		if (asked?.via === "slack" && record.reporter?.slackChannel && this.#d.slack && !settings.dryRun && kind !== "unreachable") {
			try {
				await this.#d.slack.post(record.reporter.slackChannel, slackSummary(language, kind === "complete" ? "thanks" : kind === "incomplete" ? "stillMissing" : "noAnswer", ids));
			} catch (error) {
				this.#log("warn", "jira_triage_slack_closing_failed", { ticket: record.id, error: String(error).slice(0, 120) });
			}
		}
		const add = [...new Set([...(record.pending?.labels?.add ?? []), settings.markerLabel])].filter((label) => label !== settings.needsInfoLabel);
		const remove = record.addedLabels.includes(settings.needsInfoLabel) ? [settings.needsInfoLabel] : [];
		const summary = kind === "complete" ? (record.rounds > 0 ? "complete after the reporter answered" : "complete: it has what the checklist asks for") : kind === "incomplete" ? `still missing ${ids.join(", ")} after ${record.rounds} round(s) of questions` : kind === "no_answer" ? `no answer from the reporter; still missing ${ids.join(", ")}` : `the reporter cannot be asked; missing ${ids.join(", ")}`;
		const saved = this.#save({ ...record, phase: "done", doneAt: now, nextAttemptAt: undefined, attempts: 0, recheck: undefined, asked: undefined, pending: { ...record.pending, comments, labels: { add, remove: [...new Set([...(record.pending?.labels?.remove ?? []), ...remove])] } }, summary });
		const flushed = await this.#flush(saved, snapshot);
		this.#d.store.prune();
		this.#save({ ...flushed, nextAttemptAt: flushed.pending ? now : undefined });
		return this.#outcome(record.id, kind === "complete" ? "complete" : kind, summary, { missing: [...ids] });
	}

	// ---- writes ----------------------------------------------------------------------------------------------------

	/** Makes the writes the record holds. Each is safe to repeat: a label is a difference against the ticket now, a note carries its own anchor, a comment its own token. */
	async #flush(record: TicketRecord, snapshot: Snapshot): Promise<TicketRecord> {
		const pending = record.pending;
		if (!pending) return record;
		if (this.#d.settings.dryRun) return this.#save({ ...record, pending: undefined });
		const issue = await this.#d.jira.getIssue(record.id);
		const current = snapshotOf(issue);
		const changes: Change[] = [];
		const added: string[] = [];
		if (pending.labels) {
			const after = [...current.labels];
			for (const label of pending.labels.add) if (!after.includes(label)) (after.push(label), added.push(label));
			for (const label of pending.labels.remove) if (record.addedLabels.includes(label) && after.includes(label)) after.splice(after.indexOf(label), 1);
			changes.push({ field: "labels", before: current.labels, after });
		}
		let description = current.rawDescription;
		for (const note of pending.notes ?? []) if (!hasEntry(description, note)) description = withNotes(description, note, new Date(this.#now()));
		if (description !== current.rawDescription) changes.push({ field: "description", before: current.rawDescription, after: description });
		if (pending.environment && current.environment.trim() === "") changes.push({ field: "environment", before: current.environment, after: pending.environment });
		await applyChanges({ jira: this.#d.jira, journal: this.#d.journal, log: this.#log }, record.id, changes, { reason: `triage ${record.phase}`, trigger: record.origin });
		const botComments = [...record.botComments];
		for (const comment of pending.comments ?? []) {
			const id = await this.#commentOnce(record.id, comment.token, comment.body);
			if (id && !botComments.includes(id)) botComments.push(id);
		}
		return this.#save({ ...record, pending: undefined, botComments, addedLabels: [...new Set([...record.addedLabels, ...added])].filter((label) => !(pending.labels?.remove ?? []).includes(label)) });
	}

	/** A comment is sent once by Jira's rules, so after an uncertain failure the ticket is read first: a comment with this token is the one already made. */
	async #commentOnce(key: string, token: string, body: string): Promise<string | undefined> {
		for (const comment of await this.#d.jira.comments(key)) if (tokenOfComment(comment.body) === token) return comment.id;
		return (await this.#d.jira.addComment(key, body)).id;
	}

	// ---- trouble ---------------------------------------------------------------------------------------------------

	#delay(attempts: number): number {
		const schedule = this.#d.settings.retrySchedule;
		const base = schedule[Math.min(attempts - 1, schedule.length - 1)] ?? 60_000;
		return Math.round(base * (0.9 + (this.#d.random ?? Math.random)() * 0.2));
	}

	async #failed(record: TicketRecord, error: unknown): Promise<TriageOutcome> {
		const now = this.#now();
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof JiraError && error.status === 404) {
			this.#save({ ...record, phase: "done", doneAt: now, nextAttemptAt: undefined, pending: undefined, summary: "the ticket does not exist or cannot be read" });
			return this.#outcome(record.id, "ignored", "the ticket does not exist or this agent may not read it");
		}
		const attempts = record.attempts + 1;
		const outage = isUnreachable(error);
		this.#log("warn", "jira_triage_pass_failed", { ticket: record.id, phase: record.phase, attempts, outage, error: clip(message, 200) });
		if (record.phase === "queued" && attempts >= this.#d.settings.maxAttempts) {
			this.#save({ ...record, phase: "gave_up", attempts, nextAttemptAt: undefined, lastError: clip(message, 300), summary: `gave up after ${attempts} failed passes` });
			await this.#d.notify?.(`Jira triage gave up on ${record.id} after ${attempts} failed passes (last error: ${clip(message, 200)}). It needs a person, or ask me to triage it again.`).catch(() => undefined);
			return this.#outcome(record.id, "gave_up", `gave up after ${attempts} failed passes: ${clip(message, 160)}`);
		}
		const wait = this.#delay(attempts);
		this.#save({ ...record, attempts, nextAttemptAt: now + wait, lastError: clip(message, 300) });
		return this.#outcome(record.id, "retry", `${outage ? "the ticket system did not answer" : "a step failed"} (${clip(message, 120)}); trying again in ${ago(wait)}`);
	}
}
