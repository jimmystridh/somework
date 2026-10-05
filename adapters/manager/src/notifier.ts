import { Backoff, sleep, wakes, type SomeWorkClient, type Wake, type WakeOptions } from "@somework/sdk";
import type { DomainApi, InboundMessage } from "./domain.ts";
import { TERMINAL, type ManagerState, type SaveState, type TrackedTask } from "./state.ts";

export interface TaskEvent {
	kind: "terminal" | "input_required";
	task: TrackedTask;
	view: any;
}

/** Listeners return the Telegram message id of what they sent, so a reply to it can be matched to the task. */
export type TaskListener = (event: TaskEvent) => Promise<number | undefined | void>;
export type MessageListener = (message: InboundMessage) => Promise<void>;

/** What the Manager reacts to. How the events are noticed (polling today, SDK wake-ups later) is the feed's business. */
export interface Notifier {
	onTaskEvent(listener: TaskListener): void;
	onMessage(listener: MessageListener): void;
}

export class Notifications implements Notifier {
	#task: TaskListener[] = [];
	#message: MessageListener[] = [];

	onTaskEvent(listener: TaskListener): void {
		this.#task.push(listener);
	}

	onMessage(listener: MessageListener): void {
		this.#message.push(listener);
	}

	async emitTask(event: TaskEvent): Promise<number | undefined> {
		let messageId: number | undefined;
		for (const listener of this.#task) messageId = (await listener(event)) ?? messageId;
		return messageId;
	}

	async emitMessage(message: InboundMessage): Promise<void> {
		for (const listener of this.#message) await listener(message);
	}
}

const KEEP_FINISHED = 50;

/** Follows the tasks the Manager submitted: notices when one finishes or asks a question. Survives restarts through the state file. */
export class TaskTracker {
	readonly #domain: DomainApi;
	readonly #state: ManagerState;
	readonly #save: SaveState;
	readonly #notifications: Notifications;

	constructor(domain: DomainApi, state: ManagerState, save: SaveState, notifications: Notifications) {
		this.#domain = domain;
		this.#state = state;
		this.#save = save;
		this.#notifications = notifications;
	}

	get tasks(): TrackedTask[] {
		return Object.values(this.#state.tasks ?? {}).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
	}

	get(taskId: string): TrackedTask | undefined {
		return this.#state.tasks?.[taskId];
	}

	activeIds(): string[] {
		return this.tasks.filter((task) => !TERMINAL.has(task.state) || task.announced !== task.state).map((task) => task.taskId);
	}

	async track(task: TrackedTask): Promise<void> {
		this.#state.tasks = { ...this.#state.tasks, [task.taskId]: task };
		this.#prune();
		await this.#save(this.#state);
	}

	/** Looks at one task once. The owner is told about each terminal state and each question exactly once; a failed delivery is retried. */
	async check(taskId: string): Promise<void> {
		const tracked = this.get(taskId);
		if (!tracked) return;
		const view = await this.#domain.getTask(taskId);
		const state: string = view.state;
		const changed = tracked.state !== state;
		tracked.state = state;
		const announceable = TERMINAL.has(state) || state === "input_required";
		if (announceable && tracked.announced !== state) {
			const messageId = await this.#notifications.emitTask({ kind: state === "input_required" ? "input_required" : "terminal", task: tracked, view });
			tracked.announced = state;
			if (state === "input_required") tracked.questionMessageId = messageId;
			await this.#save(this.#state);
		} else if (!announceable && tracked.announced !== undefined) {
			tracked.announced = undefined;
			tracked.questionMessageId = undefined;
			await this.#save(this.#state);
		} else if (changed) {
			await this.#save(this.#state);
		}
	}

	async checkAll(): Promise<void> {
		let failure: unknown;
		for (const taskId of this.activeIds()) {
			try {
				await this.check(taskId);
			} catch (error) {
				failure ??= error;
			}
		}
		if (failure) throw failure;
	}

	#prune(): void {
		const finished = this.tasks.filter((task) => TERMINAL.has(task.state) && task.announced === task.state);
		for (const task of finished.slice(KEEP_FINISHED)) delete this.#state.tasks![task.taskId];
	}
}

/**
 * Messages other agents send to the Manager are forwarded. Task bookkeeping messages (the domain's status messages to a requester)
 * are not shown; they only tell the tracker which tasks to look at, which is how a requester learns of progress over push.
 */
export class InboxReader {
	readonly #domain: DomainApi;
	readonly #notifications: Notifications;

	constructor(domain: DomainApi, notifications: Notifications) {
		this.#domain = domain;
		this.#notifications = notifications;
	}

	/** Forwards what is new and returns the ids of tasks that bookkeeping messages mention. */
	async drain(): Promise<string[]> {
		const messages = await this.#domain.unreadMessages(50);
		const handled: string[] = [];
		const taskIds = new Set<string>();
		try {
			for (const message of messages) {
				const bookkeeping = message.type.startsWith("task.");
				if (bookkeeping && message.taskId) taskIds.add(message.taskId);
				if (!bookkeeping && message.from !== this.#domain.selfId) await this.#notifications.emitMessage(message);
				handled.push(message.messageId);
			}
		} finally {
			await this.#domain.markRead(handled).catch(() => {});
		}
		return [...taskIds];
	}
}

export interface FeedOptions {
	taskIntervalMs: number;
	inboxIntervalMs: number;
	maxBackoffMs: number;
}

export const defaultFeed: FeedOptions = { taskIntervalMs: 4000, inboxIntervalMs: 8000, maxBackoffMs: 60_000 };

/**
 * The interim way of noticing changes: short HTTP lookups on a timer (never held open). The SDK's wake source can replace it:
 * a task wake calls `tracker.check(taskId)`, a message wake calls `inbox.drain()`, and `run` keeps only a slow sweep.
 */
export class PollingFeed {
	readonly #tracker: TaskTracker;
	readonly #inbox: InboxReader;
	readonly #options: FeedOptions;
	readonly #log: (event: string, fields?: Record<string, unknown>) => void;

	constructor(tracker: TaskTracker, inbox: InboxReader, options: Partial<FeedOptions> = {}, log: (event: string, fields?: Record<string, unknown>) => void = () => {}) {
		this.#tracker = tracker;
		this.#inbox = inbox;
		this.#options = { ...defaultFeed, ...options };
		this.#log = log;
	}

	run(signal: AbortSignal): Promise<void> {
		return Promise.all([
			this.#loop(signal, "tasks", this.#options.taskIntervalMs, async () => (this.#tracker.activeIds().length > 0 ? this.#tracker.checkAll() : undefined)),
			this.#loop(signal, "inbox", this.#options.inboxIntervalMs, async () => {
				for (const taskId of await this.#inbox.drain()) await this.#tracker.check(taskId);
			}),
		]).then(() => {});
	}

	async #loop(signal: AbortSignal, name: string, intervalMs: number, step: () => Promise<unknown>): Promise<void> {
		const backoff = new Backoff(intervalMs, this.#options.maxBackoffMs);
		while (!signal.aborted) {
			try {
				await step();
				backoff.reset();
				await sleep(intervalMs, signal);
			} catch (error) {
				if (signal.aborted) break;
				const delay = backoff.nextDelayMs();
				this.#log("feed_failed", { feed: name, error: error instanceof Error ? error.message : String(error), retryInMs: Math.round(delay) });
				await sleep(delay, signal);
			}
		}
	}
}

export interface WakeFeedOptions {
	/** Safety net next to the push transport: how often the inbox is looked at anyway, so a lost wake only costs latency. */
	sweepEveryMs: number;
	/**
	 * How often tasks still in flight are looked at while any exist. The domain pushes a requester nothing for its own tasks
	 * (status messages never wake, and task wakes go to the assignee), so this short lookup is what notices their progress.
	 */
	activeTaskEveryMs: number;
	wake: WakeOptions;
	/** Where wakes come from; the SDK's NATS-with-HTTP-fallback source unless a test supplies its own. */
	source: (client: SomeWorkClient, signal: AbortSignal, options: WakeOptions) => AsyncIterable<Wake>;
}

/** The SDK's wake source (NATS, HTTP fallback, no long polls) deciding *when* to look; the tracker and inbox decide *what* changed. */
export class WakeFeed {
	readonly #client: SomeWorkClient;
	readonly #tracker: TaskTracker;
	readonly #inbox: InboxReader;
	readonly #options: WakeFeedOptions;
	readonly #log: (event: string, fields?: Record<string, unknown>) => void;

	constructor(client: SomeWorkClient, tracker: TaskTracker, inbox: InboxReader, options: Partial<WakeFeedOptions> = {}, log: (event: string, fields?: Record<string, unknown>) => void = () => {}) {
		this.#client = client;
		this.#tracker = tracker;
		this.#inbox = inbox;
		this.#options = { sweepEveryMs: 60_000, activeTaskEveryMs: 4000, wake: {}, source: wakes, ...options };
		this.#log = log;
	}

	async run(signal: AbortSignal): Promise<void> {
		await Promise.all([this.#sweeps(signal), this.#activeTasks(signal), this.#wakes(signal)]);
	}

	async #wakes(signal: AbortSignal): Promise<void> {
		const wake = { ...this.#options.wake, kinds: ["message", "taskEvent"] as const };
		for await (const item of this.#options.source(this.#client, signal, wake)) {
			try {
				if (item.kind === "message") await this.#checkTasks(await this.#inbox.drain());
				else if (item.kind === "taskEvent") await this.#tracker.check(item.taskId);
				await item.ack();
			} catch (error) {
				// not acknowledged: the transport redelivers it, and the sweep covers it meanwhile
				this.#log("wake_failed", { kind: item.kind, error: error instanceof Error ? error.message : String(error) });
			}
		}
	}

	async #checkTasks(taskIds: string[]): Promise<void> {
		for (const taskId of taskIds) await this.#tracker.check(taskId);
	}

	async #sweeps(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			await sleep(this.#options.sweepEveryMs, signal);
			if (signal.aborted) break;
			await this.#inbox.drain().then((taskIds) => this.#checkTasks(taskIds)).catch((error) => this.#log("sweep_failed", { feed: "inbox", error: String(error) }));
		}
	}

	async #activeTasks(signal: AbortSignal): Promise<void> {
		const backoff = new Backoff(this.#options.activeTaskEveryMs, 60_000);
		while (!signal.aborted) {
			try {
				if (this.#tracker.activeIds().length > 0) await this.#tracker.checkAll();
				backoff.reset();
				await sleep(this.#options.activeTaskEveryMs, signal);
			} catch (error) {
				this.#log("sweep_failed", { feed: "tasks", error: error instanceof Error ? error.message : String(error) });
				await sleep(backoff.nextDelayMs(), signal);
			}
		}
	}
}
