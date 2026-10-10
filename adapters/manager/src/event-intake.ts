import type { DomainApi, FeedEvent } from "./domain.ts";
import { WindowedLimiter } from "./rate.ts";
import { clip, defang } from "./redact.ts";
import type { ManagerState, SaveState } from "./state.ts";

export interface EventIntakeConfig {
	/** Topic globs the owner wants to hear about. Everything else on the feed is left alone. */
	topics: string[];
	/** Topics answered with the deterministic digest instead of the event itself. */
	digestTopics: string[];
	perTopicPerHour: number;
	/** `HH:MM-HH:MM` in `timeZone`; events outside `urgentTopics` wait for the end of the window and arrive as one message. */
	quietHours?: string;
	timeZone: string;
	urgentTopics: string[];
}

export const defaultEventIntake: EventIntakeConfig = {
	topics: ["grafana.alert.*", "datadog.monitor.*", "clock.nightly_digest.tick"],
	digestTopics: ["clock.nightly_digest.tick"],
	perTopicPerHour: 6,
	timeZone: "Europe/Stockholm",
	urgentTopics: ["grafana.alert.firing", "datadog.monitor.alert"],
};

/** Agents publish `agent.<slug>.job.finished` when a background job ends; the owner hears about each one. */
export const JOB_FINISHED_TOPIC = "agent.*.job.finished";
const JOB_FINISHED = /^agent\.([a-z0-9_]+)\.job\.finished$/;

export interface EventOwner {
	tell(text: string): Promise<number | undefined>;
}

const SEEN_KEPT = 500;
const QUIET_KEPT = 100;
const HEADLINE_KEYS = ["title", "summary", "alertname", "name", "subject", "message"];
const FIELD_KEYS = ["status", "severity", "state", "priority", "service", "host", "environment", "project", "key", "issue", "link", "url"];

export function globMatch(pattern: string, value: string): boolean {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`).test(value);
}

const anyGlob = (patterns: readonly string[], value: string): boolean => patterns.some((pattern) => globMatch(pattern, value));

const plain = (value: unknown, max: number): string | undefined => {
	if (typeof value === "string") return value ? clip(defang(value), max) : undefined;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
};

/** One compact line group for an event. Only a fixed set of fields is read, every value is cut and defanged; nothing here is ever interpreted. */
export function formatEvent(event: FeedEvent): string {
	const payload = event.payload ?? {};
	const topic = String(payload.topic ?? event.type);
	const data = payload.data && typeof payload.data === "object" ? (payload.data as Record<string, unknown>) : {};
	const headline = HEADLINE_KEYS.map((key) => plain(data[key], 160)).find(Boolean);
	const fields = FIELD_KEYS.map((key) => {
		const value = plain(data[key], 120);
		return value === undefined ? undefined : `${key}: ${value}`;
	}).filter(Boolean);
	const unverified = payload.verified === true ? "" : " (unverified)";
	return clip([`[${defang(topic)}]${unverified} ${headline ?? ""}`.trim(), ...(fields.length ? [fields.join(", ")] : [])].join("\n"), 500);
}

/** The owner's one line about a finished job: which agent, which job, how it ended, what it says. */
export function formatJobFinished(event: FeedEvent): string {
	const payload = event.payload ?? {};
	const agent = JOB_FINISHED.exec(String(payload.topic ?? ""))?.[1] ?? "an agent";
	const data = payload.data && typeof payload.data === "object" ? (payload.data as Record<string, unknown>) : {};
	const label = plain(data.label, 120) ?? plain(data.capability, 80) ?? "a job";
	const result = plain(data.result, 20) ?? "finished";
	const summary = plain(data.summary, 240);
	return clip(`${defang(agent)} ${result === "completed" ? "completed" : result === "failed" ? "could not finish" : result === "cancelled" ? "cancelled" : "finished"}: ${label}${summary ? ` - ${summary}` : ""}`, 500);
}

export interface EventIntakeDeps {
	domain: DomainApi;
	owner: EventOwner;
	state: ManagerState;
	save: SaveState;
	config?: Partial<EventIntakeConfig>;
	/** Builds the digest message (questions, rules, sources, handlers). */
	digest?: () => Promise<string>;
	now?: () => number;
	log?: (event: string, fields?: Record<string, unknown>) => void;
}

/**
 * Turns events on the domain feed into short owner messages without a model: an allow-list of topics, per-topic rate limits with a
 * "N more suppressed" summary, optional quiet hours, a digest for the schedule topic, and one delivery per event id. Event text is
 * data: the fixed fields are shown and nothing is executed, parsed as a command or passed on to the model.
 */
export class EventIntake {
	readonly #deps: EventIntakeDeps;
	readonly #config: EventIntakeConfig;
	readonly #limiter: WindowedLimiter;
	readonly #now: () => number;
	#running = false;

	constructor(deps: EventIntakeDeps) {
		this.#deps = deps;
		const config = { ...defaultEventIntake, ...deps.config };
		this.#config = { ...config, topics: config.topics.includes(JOB_FINISHED_TOPIC) ? config.topics : [...config.topics, JOB_FINISHED_TOPIC] };
		this.#now = deps.now ?? Date.now;
		this.#limiter = new WindowedLimiter(this.#config.perTopicPerHour, 3_600_000, this.#now);
	}

	async poll(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		try {
			await this.#flushSummaries();
			await this.#flushQuiet();
			const { state } = this.#deps;
			const feed = await this.#deps.domain.events(state.eventCursor);
			let cursor = state.eventCursor ?? 0;
			for (const event of feed.events) {
				await this.#handle(event);
				cursor = Math.max(cursor, event.seq);
				state.eventCursor = cursor;
			}
			if (feed.events.length > 0 || state.eventCursor === undefined) {
				state.eventCursor = Math.max(cursor, feed.cursor);
				await this.#deps.save(state);
				await this.#deps.domain.ackEvents(state.eventCursor).catch(() => {});
			}
		} finally {
			this.#running = false;
		}
	}

	async #handle(event: FeedEvent): Promise<void> {
		const topic = event.payload?.topic;
		if (typeof topic !== "string" || !anyGlob(this.#config.topics, topic)) return;
		const seen = (this.#deps.state.seenEvents ??= []);
		if (seen.includes(event.eventId)) return;
		if (anyGlob(this.#config.digestTopics, topic)) {
			if (this.#deps.digest) await this.#deliver(topic, await this.#deps.digest(), true);
			this.#remember(event.eventId);
			return;
		}
		if (JOB_FINISHED.test(topic)) {
			if (!this.#inOwnersChat(event)) await this.#deliver(topic, formatJobFinished(event), false, false);
			this.#remember(event.eventId);
			return;
		}
		await this.#deliver(topic, formatEvent(event), anyGlob(this.#config.urgentTopics, topic));
		this.#remember(event.eventId);
	}

	/** A job started in a conversation the owner has with the agent already shows its result message there. */
	#inOwnersChat(event: FeedEvent): boolean {
		const conversationId = event.payload?.data?.conversationId;
		return typeof conversationId === "string" && this.#deps.state.chats?.[conversationId] !== undefined;
	}

	#remember(eventId: string): void {
		const seen = (this.#deps.state.seenEvents ??= []);
		seen.push(eventId);
		if (seen.length > SEEN_KEPT) seen.splice(0, seen.length - SEEN_KEPT);
	}

	/** `limited` false: the rate limit of the topic does not apply (a batch of finished jobs is what the owner asked for). */
	async #deliver(topic: string, text: string, urgent: boolean, limited = true): Promise<void> {
		if (!urgent && this.#quiet()) {
			const queue = (this.#deps.state.quietQueue ??= []);
			queue.push(text);
			if (queue.length > QUIET_KEPT) queue.splice(0, queue.length - QUIET_KEPT);
			return;
		}
		const { pass, carried } = limited ? this.#limiter.take(topic) : { pass: true, carried: 0 };
		if (carried > 0) await this.#deps.owner.tell(`${carried} more ${defang(topic)} events were suppressed in the last hour.`);
		if (pass) await this.#deps.owner.tell(text);
	}

	async #flushSummaries(): Promise<void> {
		for (const { key, suppressed } of this.#limiter.finished()) {
			await this.#deps.owner.tell(`${suppressed} more ${defang(key)} events were suppressed in the last hour.`).catch(() => {});
		}
	}

	async #flushQuiet(): Promise<void> {
		const queue = this.#deps.state.quietQueue;
		if (!queue?.length || this.#quiet()) return;
		await this.#deps.owner.tell(`While you were away (${queue.length}):\n${queue.join("\n")}`);
		this.#deps.state.quietQueue = [];
		await this.#deps.save(this.#deps.state);
	}

	#quiet(): boolean {
		const window = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(this.#config.quietHours ?? "");
		if (!window) return false;
		const parts = new Intl.DateTimeFormat("en-GB", { timeZone: this.#config.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(this.#now()));
		const minute = Number(parts.find((p) => p.type === "hour")!.value) * 60 + Number(parts.find((p) => p.type === "minute")!.value);
		const from = Number(window[1]) * 60 + Number(window[2]);
		const to = Number(window[3]) * 60 + Number(window[4]);
		return from <= to ? minute >= from && minute < to : minute >= from || minute < to;
	}
}

/**
 * Asks the domain to feed the Manager the job-finished events of every agent, once (the domain keeps a subscription until it is deleted).
 * A failure is only logged: the next start tries again.
 */
export async function ensureJobSubscription(domain: Pick<DomainApi, "listSubscriptions" | "subscribeToTopic">, state: ManagerState, save: SaveState, log: (event: string, fields?: Record<string, unknown>) => void = () => {}): Promise<void> {
	if (state.jobSubscription) return;
	try {
		const known = (await domain.listSubscriptions()).some((subscription) => subscription.kind === "topic" && subscription.selector === JOB_FINISHED_TOPIC);
		if (!known) await domain.subscribeToTopic(JOB_FINISHED_TOPIC, true);
		state.jobSubscription = true;
		await save(state);
	} catch (error) {
		log("job_subscription_failed", { error: error instanceof Error ? error.message.slice(0, 160) : "error" });
	}
}
