import { randomBytes } from "node:crypto";
import { AGENT_ID, type WatchesConfig } from "./config.ts";
import { silent, type Log } from "./log.ts";
import type { Store, WatchRow } from "./store.ts";
import type { Json, MappedEvent } from "./types.ts";

const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const MAX_NUMBER = 1_000_000_000;
const DAY_MS = 86_400_000;
const INACTIVE_AFTER_MS = 30 * DAY_MS;
const KEEP_CLOSED_MS = 7 * DAY_MS;
const KEEP_ENDED_MS = 7 * DAY_MS;

export interface WatchRequest {
	/** `owner/name`; give this and `number`, or `url`. */
	repository?: unknown;
	number?: unknown;
	/** The address of the pull request, for example https://github.com/owner/name/pull/1234. */
	url?: unknown;
}

export interface WatchView {
	id: string;
	repository: string;
	number: number;
	/** The topic the events arrive on; a rule in git must subscribe the agent to it. */
	topic: string;
	status: "active" | "closed" | "ended";
	endReason?: string;
	headSha?: string;
	createdAt: string;
	lastActivityAt: string;
	closedAt?: string;
	endedAt?: string;
	/** When an active or closed watch ends unless something happens first. */
	expiresAt?: string;
}

export class WatchError extends Error {
	override readonly name = "WatchError";
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** The topic slug of an agent: its id without the prefix, other characters as `_` (topics may not contain hyphens). */
export const watchSlug = (agent: string): string => agent.slice("agent/".length).replace(/[^a-z0-9]/g, "_");

export const watchTopic = (source: string, agent: string): string => `${source}.watch.${watchSlug(agent)}.event`;

interface Target {
	repository: string;
	numbers: number[];
	headSha?: string;
}

const record = (value: Json | undefined): Record<string, Json> | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined);

const wholeNumber = (value: Json | undefined): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);

/** Which pull request a mapped event is about: the repository and the numbers (a check run may name several, or none and only its commit). Pushes are about no pull request. */
function targetOf(event: MappedEvent, source: string): Target | undefined {
	const data = record(event.data);
	const fullName = record(data?.repository)?.fullName;
	if (!data || typeof fullName !== "string") return undefined;
	const repository = fullName.toLowerCase();
	const kind = event.topic.slice(source.length + 1);
	if (kind.startsWith("pull_request.") || kind.startsWith("pull_request_review.") || kind.startsWith("pull_request_review_comment.")) {
		const number = wholeNumber(data.number);
		return number === undefined ? undefined : { repository, numbers: [number] };
	}
	if (kind === "issue_comment.created") {
		const number = wholeNumber(data.number);
		return data.isPullRequest === true && number !== undefined ? { repository, numbers: [number] } : undefined;
	}
	if (kind === "check_run.completed") {
		const numbers = Array.isArray(data.pullRequests) ? data.pullRequests.map(wholeNumber).filter((n): n is number => n !== undefined) : [];
		return { repository, numbers, ...(typeof data.headSha === "string" ? { headSha: data.headSha } : {}) };
	}
	return undefined;
}

export interface WatchesDeps {
	config: WatchesConfig;
	store: Store;
	now?: () => number;
	log?: Log;
	/** One call per watch event published, by agent. */
	onDelivery?(agent: string): void;
}

/**
 * Watches on pull requests (ADR 0005). An agent asks the hub for one pull request; every GitHub event about it is then re-published as
 * `github.watch.<agent>.event` with the key `github:watch:<watch id>:<delivery id>`, so a redelivery is a duplicate. The hub creates no subscription:
 * a rule in git wakes the agent on its watch topic. A watch ends when its pull request is merged, 7 days after it was closed, after 30 days without a
 * renewal or an event, or when the agent cancels it; ended watches are listed for 7 days with their reason.
 */
export class Watches {
	readonly #deps: WatchesDeps;
	readonly #now: () => number;
	readonly #log: Log;
	readonly source: string;

	constructor(deps: WatchesDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#log = deps.log ?? silent;
		this.source = deps.config.source;
	}

	#view(row: WatchRow): WatchView {
		const iso = (at: number) => new Date(at).toISOString();
		const status = row.endedAt !== null ? "ended" : row.closedAt !== null ? "closed" : "active";
		const expiresAt = row.endedAt !== null ? undefined : Math.min(row.activeAt + INACTIVE_AFTER_MS, row.closedAt === null ? Infinity : row.closedAt + KEEP_CLOSED_MS);
		return {
			id: row.id,
			repository: row.repository,
			number: row.number,
			topic: watchTopic(this.source, row.agent),
			status,
			...(row.endReason === null ? {} : { endReason: row.endReason }),
			...(row.headSha === null ? {} : { headSha: row.headSha }),
			createdAt: iso(row.createdAt),
			lastActivityAt: iso(row.activeAt),
			...(row.closedAt === null ? {} : { closedAt: iso(row.closedAt) }),
			...(row.endedAt === null ? {} : { endedAt: iso(row.endedAt) }),
			...(expiresAt === undefined ? {} : { expiresAt: iso(expiresAt) }),
		};
	}

	#pullRequest(raw: WatchRequest): { repository: string; number: number } {
		let repository = raw.repository;
		let number = raw.number;
		if (raw.url !== undefined) {
			if (raw.repository !== undefined || raw.number !== undefined) throw new WatchError(400, "give either url or repository and number");
			let match: RegExpExecArray | null = null;
			try {
				const url = new URL(String(raw.url));
				if (url.protocol === "https:") match = /^\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/pull\/(\d{1,10})(?:\/.*)?$/.exec(url.pathname);
			} catch {
				// not a URL: refused below
			}
			if (!match) throw new WatchError(400, "url must be the https address of a pull request (https://github.com/owner/name/pull/123)");
			repository = `${match[1]}/${match[2]}`;
			number = Number(match[3]);
		}
		if (typeof repository !== "string" || !REPOSITORY.test(repository)) throw new WatchError(400, "repository must be owner/name");
		if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > MAX_NUMBER) throw new WatchError(400, "number must be the number of the pull request");
		return { repository: repository.toLowerCase(), number };
	}

	/** Starts watching a pull request, or renews the agent's watch of it (the same watch comes back). */
	request(agent: string, raw: WatchRequest): { watch: WatchView; created: boolean } {
		if (!AGENT_ID.test(agent)) throw new WatchError(400, "the agent id is not valid");
		const { repository, number } = this.#pullRequest(raw);
		const slug = watchSlug(agent);
		const clash = this.#deps.store.slugOwner(slug, agent);
		if (clash) throw new WatchError(409, `another agent id (${clash}) holds watches on the same topic; ids that differ only in - . _ cannot both watch`);
		const { maxPerAgent } = this.#deps.config;
		const put = this.#deps.store.putWatch({ id: `wch_${randomBytes(8).toString("hex")}`, agent, slug, repository, number }, this.#now(), maxPerAgent);
		if (!put) throw new WatchError(429, `${maxPerAgent} watches are active already: cancel one or wait for one to end`);
		this.#log("info", put.created ? "watch_created" : "watch_renewed", { agent, id: put.row.id, repository, number });
		return { watch: this.#view(put.row), created: put.created };
	}

	list(agent: string): WatchView[] {
		return this.#deps.store.watchesOf(agent).map((row) => this.#view(row));
	}

	/** Ends the agent's watch, named by its id or `owner/name#number`; true when one was active. */
	cancel(agent: string, idOrRef: string): boolean {
		const removed = this.#deps.store.cancelWatch(agent, idOrRef, this.#now());
		if (removed) this.#log("info", "watch_cancelled", { agent, ref: idOrRef });
		return removed;
	}

	activeCount(): number {
		return this.#deps.store.activeWatchCount();
	}

	#matches(target: Target): WatchRow[] {
		const found = new Map<string, WatchRow>();
		for (const number of target.numbers) for (const watch of this.#deps.store.activeWatchesOfPullRequest(target.repository, number)) found.set(watch.id, watch);
		if (target.numbers.length === 0 && target.headSha) for (const watch of this.#deps.store.activeWatchesOfCommit(target.repository, target.headSha)) found.set(watch.id, watch);
		return [...found.values()];
	}

	#settle(watch: WatchRow, event: MappedEvent, now: number): void {
		const kind = event.topic.slice(this.source.length + 1);
		if (kind === "pull_request.merged") {
			this.#deps.store.endWatch(watch.id, now, "merged");
			this.#log("info", "watch_ended", { agent: watch.agent, id: watch.id, reason: "merged" });
			return;
		}
		const headSha = kind.startsWith("pull_request.") ? record(event.data)?.headSha : undefined;
		this.#deps.store.touchWatch(watch.id, now, {
			...(typeof headSha === "string" ? { headSha } : {}),
			...(kind === "pull_request.closed" ? { closedAt: now } : kind === "pull_request.reopened" ? { closedAt: null } : {}),
		});
	}

	/**
	 * Publishes one watch event for every active watch that an event is about. The watches change (renewed activity, new head commit, closed or
	 * merged) only after everything was published, so an item tried again after a failure finds them as they were and publishes duplicates at most.
	 */
	async relay(events: MappedEvent[], occurredAt: string, publish: (event: MappedEvent, occurredAt: string) => Promise<unknown>): Promise<number> {
		const now = this.#now();
		const settle: (() => void)[] = [];
		let delivered = 0;
		for (const event of events) {
			const target = targetOf(event, this.source);
			if (!target) continue;
			const data = record(event.data)!;
			const delivery = event.key.replace(new RegExp(`^${this.source}:delivery:`), "");
			for (const watch of this.#matches(target)) {
				await publish(
					{
						topic: watchTopic(this.source, watch.agent),
						key: `${this.source}:watch:${watch.id}:${delivery}`,
						classification: event.classification,
						data: { watchId: watch.id, topic: event.topic, repository: record(data.repository)!.fullName as string, number: watch.number, event: event.data },
					},
					occurredAt,
				);
				delivered++;
				this.#deps.onDelivery?.(watch.agent);
				settle.push(() => this.#settle(watch, event, now));
			}
		}
		for (const apply of settle) apply();
		return delivered;
	}

	/** Ends the watches that went quiet or whose pull request stayed closed, and forgets old ended ones. */
	maintain(now: number = this.#now()): number {
		const ended = this.#deps.store.expireWatches(now, now - INACTIVE_AFTER_MS, now - KEEP_CLOSED_MS);
		this.#deps.store.pruneWatches(now - KEEP_ENDED_MS);
		if (ended > 0) this.#log("info", "watches_expired", { ended });
		return ended;
	}
}
