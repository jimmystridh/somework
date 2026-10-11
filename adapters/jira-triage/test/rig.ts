import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeJournal } from "../src/changes.ts";
import type { DeveloperAnswer, DeveloperAsked, DeveloperPort, DeveloperRequest, DeveloperRequestSent } from "../src/developer.ts";
import { TriageEngine, type EngineSettings } from "../src/engine.ts";
import type { SlackPort } from "../src/slack.ts";
import { TriageStore } from "../src/store.ts";
import { issueOf, MemoryJira, type MemoryIssue } from "./memory-jira.ts";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export class FakeSlack implements SlackPort {
	/** Slack member by e-mail address. */
	members = new Map<string, string>([["dana@example.test", "U0123ABCD"]]);
	names = new Map<string, string>([["U0123ABCD", "dana"]]);
	posted: { channel: string; text: string; ts: string }[] = [];
	/** What people wrote into the direct message, by channel. */
	incoming: { channel: string; user: string; text: string; ts: string }[] = [];
	lookupError: Error | undefined;
	postError: Error | undefined;
	repliesError: Error | undefined;
	opened = 0;
	#ts = 1_760_000_000;

	async findUserByEmail(email: string): Promise<string | undefined> {
		if (this.lookupError) throw this.lookupError;
		return this.members.get(email);
	}
	async openDirectMessage(userId: string): Promise<string> {
		this.opened += 1;
		return `D${userId.slice(1)}`;
	}
	async post(channel: string, text: string): Promise<{ ts: string }> {
		if (this.postError) throw this.postError;
		const ts = `${this.#ts++}.000100`;
		this.posted.push({ channel, text, ts });
		return { ts };
	}
	async replies(channel: string, afterTs: string, userId: string): Promise<{ ts: string; text: string }[]> {
		if (this.repliesError) throw this.repliesError;
		return this.incoming.filter((message) => message.channel === channel && message.user === userId && Number(message.ts) > Number(afterTs)).map(({ ts, text }) => ({ ts, text }));
	}
	async displayName(userId: string): Promise<string | undefined> {
		return this.names.get(userId);
	}
	/** A person answers in the direct message: after everything posted so far. */
	answer(channel: string, user: string, text: string): void {
		const last = Math.max(...this.posted.map((post) => Number(post.ts)), this.#ts);
		this.incoming.push({ channel, user, text, ts: `${Math.floor(last) + 1}.000200` });
	}
}

export class FakeDeveloper implements DeveloperPort {
	asked: DeveloperRequest[] = [];
	askError: Error | undefined;
	reply: string | undefined;
	answerError: Error | undefined;
	async ask(request: DeveloperRequest): Promise<DeveloperRequestSent> {
		if (this.askError) throw this.askError;
		this.asked.push(request);
		return { conversationId: `conv_${this.asked.length}`, messageId: `msg_${this.asked.length}`, sentAt: "2026-10-11T09:00:00.000Z" };
	}
	looked: DeveloperAsked[] = [];
	async answer(asked: DeveloperAsked): Promise<DeveloperAnswer | undefined> {
		this.looked.push(asked);
		if (this.answerError) throw this.answerError;
		return this.reply === undefined ? undefined : { text: this.reply, at: "2026-10-11T09:03:00.000Z" };
	}
}

export const defaults: EngineSettings = {
	projects: ["SAD"],
	markerLabel: "triaged-by-bot",
	needsInfoLabel: "needs-info",
	language: "en",
	enrichment: true,
	developerWaitMs: 10 * MINUTE,
	developerPollMs: 20_000,
	reporterWaitMs: 48 * HOUR,
	reporterPollMs: 5 * MINUTE,
	maxRounds: 2,
	retrySchedule: [2 * MINUTE, 5 * MINUTE, 15 * MINUTE],
	maxAttempts: 4,
	dryRun: false,
};

export interface RigOptions {
	issues?: MemoryIssue[];
	settings?: Partial<EngineSettings>;
	slack?: boolean;
	developer?: boolean;
}

/** An engine over a ticket system in memory, a Slack and a developer agent that are told what to say, and a clock the test moves. */
export function rig(options: RigOptions = {}) {
	const dir = mkdtempSync(join(tmpdir(), "triage-engine-"));
	const jira = new MemoryJira(options.issues ?? [issueOf("SAD-1")]);
	const store = new TriageStore(dir);
	const journal = new ChangeJournal(join(dir, "changes.jsonl"));
	const slack = options.slack === false ? undefined : new FakeSlack();
	const developer = options.developer === false ? undefined : new FakeDeveloper();
	const notices: string[] = [];
	const logs: { level: string; event: string; fields: any }[] = [];
	let now = Date.parse("2026-10-11T09:00:00.000Z");
	const settings = { ...defaults, ...options.settings };
	const build = () =>
		new TriageEngine({
			settings,
			jira,
			store,
			journal,
			...(developer ? { developer } : {}),
			...(slack ? { slack } : {}),
			notify: async (message) => void notices.push(message),
			browseUrl: (key) => jira.browseUrl(key),
			log: (level, event, fields) => void logs.push({ level, event, fields }),
			now: () => now,
			random: () => 0.5,
		});
	jira.clock = () => new Date(now).toISOString();
	const engine = build();
	return {
		dir,
		jira,
		store,
		journal,
		slack,
		developer,
		notices,
		logs,
		engine,
		build,
		settings,
		advance: (ms: number) => void (now += ms),
		now: () => now,
		/** The `ticket` as the bot sees it after its own writes. */
		ticket: (key = "SAD-1") => jira.get(key),
		record: (key = "SAD-1") => store.get(key)!,
		/** Everything the bot wrote, by kind, so a test can say what it did and never did. */
		ops: () => jira.writes.map((write) => write.op),
	};
}

/** A bug that lacks the steps, the expected result and the environment, from a reporter Slack knows. */
export const thinBug = (key = "SAD-1", over: Partial<MemoryIssue> = {}): MemoryIssue => issueOf(key, { description: "The total is wrong. Customer Acme AB.", summary: "Invoice total", ...over });

export const COMPLETE_TEXT = "1. Open the invoice for Acme AB customer\n2. Add two rows and save\nExpected 250 but got 200.\nVersion 2025.11 in production.";
