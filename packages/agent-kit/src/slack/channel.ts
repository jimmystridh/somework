import { silent, type Log } from "../log.ts";
import type { Metrics } from "../metrics.ts";
import type { ApprovalChannel, Approvals } from "../threads/approvals.ts";
import type { JobManager, Party } from "../threads/jobs.ts";
import { finishReply, type InboundMessage } from "../threads/message.ts";
import { describeJob } from "../threads/tools.ts";
import { parseSlackAction, parseSlackEvent, slackChunks, slackConversationId, type SlackApi, type SlackTarget } from "./api.ts";
import { slackMessage, type SlackSender } from "./sender.ts";
import { SLACK_PREFIX, type SlackStore } from "./store.ts";

/** The principal a person on Slack is, as far as the agent's conversations go. */
export const SLACK_SENDER_PREFIX = "slack/";

/** Slack swallows what starts with a slash, so the commands start with this. */
export const SLACK_COMMAND_PREFIX = "!";

/** Approval questions to a person on Slack are asked and answered in the conversation. */
export function slackApprovals(store: Pick<SlackStore, "owns">, sender: Pick<SlackSender, "say" | "ask">): ApprovalChannel {
	return {
		owns: (conversationId) => store.owns(conversationId),
		reaches: (approver) => approver.id.startsWith(SLACK_SENDER_PREFIX),
		say: (conversationId, text) => sender.say(conversationId, text),
		ask: (conversationId, text, id) => sender.ask(conversationId, text, id),
		commandPrefix: SLACK_COMMAND_PREFIX,
	};
}

/** The part of a WebSocket that the channel uses (the global `WebSocket` of Node has it); tests bring their own. */
export interface SlackSocket {
	send(data: string): void;
	close(): void;
	addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
}

export interface SlackChannelDeps {
	api: SlackApi;
	/** A fresh address for one Socket Mode connection (`apps.connections.open`). */
	openConnection(signal: AbortSignal): Promise<string>;
	socket?: (url: string) => SlackSocket;
	store: SlackStore;
	allowedUsers: ReadonlySet<string>;
	allowedChannels: ReadonlySet<string>;
	agentId: string;
	/** Hands a message to the engine (`ThreadEngine.acceptLocal`); resolves when it is safely taken in. */
	accept(message: InboundMessage): Promise<void>;
	/** What this agent is, for !help. */
	about(): string;
	/** The agent's facts, for !status. */
	status(): Promise<string>;
	jobs: Pick<JobManager, "active" | "recent" | "stop">;
	approvals: Pick<Approvals, "decide">;
	messagesPerHour?: number;
	/** How long a new connection may take to say hello before it is dropped. */
	helloTimeoutMs?: number;
	log?: Log;
	metrics?: Metrics;
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const HOUR = 3_600_000;
const COMMANDS = ["help", "status", "jobs", "stop", "approve", "deny"];
const ACCEPT_ATTEMPTS = 3;

const sleepUnlessAborted = (ms: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
	});

const cut = (error: unknown): string => (error instanceof Error ? error.message.slice(0, 160) : "unknown");

type ConnectionEnd = "disconnect" | "closed" | "aborted";

/**
 * The agent's own Slack app in Socket Mode: the agent opens a WebSocket to Slack, so nothing listens and nothing is exposed. A DM from an
 * allowed person, or a mention by one in an allowed channel, becomes a message of a conversation (`slack:<channel>` for a DM,
 * `slack:<channel>:<thread>` for a thread, where the answer goes) that the thread engine handles like any other from a human; the answer, and the
 * end of a job started there, come back to the same place. The domain never sees these conversations. A few `!` commands are answered here
 * without a model run. Every envelope is acknowledged at once; an event that Slack delivers again is recognised by the store and answered once.
 */
export class SlackChannel {
	readonly #deps: SlackChannelDeps;
	readonly #log: Log;
	readonly #now: () => number;
	readonly #recent = new Map<string, number[]>();
	readonly #warned = new Set<string>();
	#queue: Promise<void> = Promise.resolve();
	#signal: AbortSignal = new AbortController().signal;

	constructor(deps: SlackChannelDeps) {
		this.#deps = deps;
		this.#log = deps.log ?? silent;
		this.#now = deps.now ?? Date.now;
	}

	async run(signal: AbortSignal): Promise<void> {
		const sleep = this.#deps.sleep ?? sleepUnlessAborted;
		this.#signal = signal;
		let backoff = 1000;
		this.#log("info", "slack_started", { allowedUsers: this.#deps.allowedUsers.size, channels: this.#deps.allowedChannels.size });
		while (!signal.aborted) {
			try {
				const url = await this.#deps.openConnection(signal);
				const end = await this.#connect(url, signal, () => void (backoff = 1000));
				if (end === "disconnect") continue;
			} catch (error) {
				if (signal.aborted) break;
				this.#log("warn", "slack_connection_failed", { error: cut(error) });
			}
			if (signal.aborted) break;
			await sleep(backoff, signal);
			backoff = Math.min(backoff * 2, 30_000);
		}
		await this.#queue;
		this.#log("info", "slack_stopped");
	}

	/**
	 * One connection, from opening to its end. Resolves with why it ended; a `disconnect` request of Slack after a good connection is the only end
	 * that is followed by a new connection without waiting.
	 */
	#connect(url: string, signal: AbortSignal, connected: () => void): Promise<ConnectionEnd> {
		const socket = (this.#deps.socket ?? ((address: string) => new WebSocket(address) as unknown as SlackSocket))(url);
		return new Promise<ConnectionEnd>((resolve) => {
			let hello = false;
			const finish = (end: ConnectionEnd, why: string): void => {
				if (finished) return;
				finished = true;
				clearTimeout(helloTimer);
				signal.removeEventListener("abort", aborted);
				try {
					socket.close();
				} catch {
					// already closed
				}
				if (hello) this.#log("info", "slack_disconnected", { why });
				resolve(end === "disconnect" && !hello ? "closed" : end);
			};
			let finished = false;
			const aborted = (): void => finish("aborted", "stopped");
			const helloTimer = setTimeout(() => (this.#log("warn", "slack_connection_failed", { error: "no hello from Slack" }), finish("closed", "no hello")), this.#deps.helloTimeoutMs ?? 30_000);
			signal.addEventListener("abort", aborted, { once: true });
			if (signal.aborted) return aborted();
			socket.addEventListener("close", () => finish("closed", "closed"));
			socket.addEventListener("error", () => finish("closed", "error"));
			socket.addEventListener("message", (event) => {
				let envelope: any;
				try {
					envelope = JSON.parse(String(event?.data));
				} catch {
					return;
				}
				if (!envelope || typeof envelope !== "object") return;
				if (typeof envelope.envelope_id === "string") this.#acknowledge(socket, envelope.envelope_id);
				switch (envelope.type) {
					case "hello":
						hello = true;
						clearTimeout(helloTimer);
						connected();
						this.#log("info", "slack_connected");
						return;
					case "disconnect":
						return finish("disconnect", typeof envelope.reason === "string" ? envelope.reason.slice(0, 40) : "requested");
					case "ping":
						return this.#send(socket, { type: "pong", ...(envelope.num === undefined ? {} : { num: envelope.num }) });
					case "events_api":
						this.#queue = this.#queue.then(() => this.handleEvent(envelope.payload)).catch((error) => this.#log("error", "slack_event_failed", { error: cut(error) }));
						return;
					case "interactive":
						this.#queue = this.#queue.then(() => this.handleAction(envelope.payload)).catch((error) => this.#log("error", "slack_event_failed", { error: cut(error) }));
				}
			});
		});
	}

	#acknowledge(socket: SlackSocket, envelopeId: string): void {
		this.#send(socket, { envelope_id: envelopeId });
	}

	#send(socket: SlackSocket, body: Record<string, unknown>): void {
		try {
			socket.send(JSON.stringify(body));
		} catch (error) {
			this.#log("warn", "slack_send_failed", { error: cut(error) });
		}
	}

	/** The payload of one `events_api` envelope. Settled here: a failure to hand a message to the engine is logged, not thrown, since the envelope is acknowledged already. */
	async handleEvent(payload: unknown): Promise<void> {
		const parsed = parseSlackEvent(payload, { users: this.#deps.allowedUsers, channels: this.#deps.allowedChannels });
		if (!parsed) return;
		const count = this.#deps.metrics?.counter("somework_slack_events_total", "Slack events, by what became of them");
		if (parsed.kind === "ignored") return void count?.({ result: parsed.reason });
		if (!this.#deps.store.claim(parsed.keys)) return void count?.({ result: "duplicate" });
		if (parsed.kind === "unsupported") {
			count?.({ result: "unsupported" });
			return this.#reply(parsed.target, "I read text messages only.");
		}
		const command = new RegExp(`^${SLACK_COMMAND_PREFIX}([a-z]+)(?:\\s+([\\s\\S]*))?$`, "i").exec(parsed.text);
		if (command) {
			count?.({ result: "command" });
			return this.#command(parsed.target, parsed.conversationId, parsed.userId, command[1]!.toLowerCase(), (command[2] ?? "").trim());
		}
		if (!this.#withinLimit(parsed.userId)) {
			count?.({ result: "rate_limited" });
			if (!this.#warned.has(parsed.userId)) {
				this.#warned.add(parsed.userId);
				await this.#reply(parsed.target, `That is more than ${this.#deps.messagesPerHour ?? 30} messages an hour: I leave the rest of them for now.`);
			}
			return;
		}
		this.#warned.delete(parsed.userId);
		const messageId = `${SLACK_PREFIX}${parsed.eventKey}`;
		const sender = { kind: "human", id: `${SLACK_SENDER_PREFIX}${parsed.userId}` };
		this.#deps.store.record({ id: messageId, conversationId: parsed.conversationId, sender, text: parsed.text, at: parsed.sentAt });
		const message = this.#deps.store.message(messageId);
		if (!message) return;
		for (let attempt = 1; ; attempt++) {
			try {
				await this.#deps.accept(message);
				break;
			} catch (error) {
				if (attempt >= ACCEPT_ATTEMPTS) {
					this.#deps.store.release(parsed.keys);
					this.#log("error", "slack_accept_failed", { error: cut(error) });
					return void count?.({ result: "accept_failed" });
				}
				await (this.#deps.sleep ?? sleepUnlessAborted)(250 * 2 ** (attempt - 1), this.#signal);
			}
		}
		count?.({ result: "accepted" });
	}

	/** A tap on Approve or Deny (an `interactive` envelope): decides like the command does and replaces the buttons with the outcome. */
	async handleAction(payload: unknown): Promise<void> {
		const press = parseSlackAction(payload, { users: this.#deps.allowedUsers, channels: this.#deps.allowedChannels });
		const count = this.#deps.metrics?.counter("somework_slack_events_total", "Slack events, by what became of them");
		if (press.kind === "ignored") return void count?.({ result: press.reason });
		count?.({ result: "button" });
		const who: Party = { kind: "human", id: `${SLACK_SENDER_PREFIX}${press.userId}` };
		const result = this.#deps.approvals.decide(press.id, who, slackConversationId({ channel: press.channel, ...(press.threadTs ? { threadTs: press.threadTs } : {}) }), press.approved);
		if (result === "rejected") return;
		const outcome = result === "decided" ? (press.approved ? "Approved." : "Denied.") : "That question is closed (it may have timed out).";
		const text = `${press.text}\n\n${outcome}`.slice(0, 3000);
		try {
			await this.#deps.api("chat.update", { channel: press.channel, ts: press.ts, text, blocks: [{ type: "section", text: { type: "plain_text", text, emoji: false } }] });
		} catch (error) {
			this.#log("warn", "slack_reply_failed", { error: cut(error) });
		}
	}

	#withinLimit(userId: string): boolean {
		const now = this.#now();
		const kept = (this.#recent.get(userId) ?? []).filter((at) => now - at < HOUR);
		if (kept.length >= (this.#deps.messagesPerHour ?? 30)) {
			this.#recent.set(userId, kept);
			return false;
		}
		this.#recent.set(userId, [...kept, now]);
		return true;
	}

	async #command(target: SlackTarget, conversationId: string, userId: string, name: string, argument: string): Promise<void> {
		const who: Party = { kind: "human", id: `${SLACK_SENDER_PREFIX}${userId}` };
		const bang = SLACK_COMMAND_PREFIX;
		switch (name) {
			case "help":
				return this.#reply(target, [this.#deps.about(), "", "Write to me like to a colleague: I answer, or start work in the background and tell you here when it is done.", `Commands: ${bang}status, ${bang}jobs, ${bang}stop <job>, ${bang}approve <id>, ${bang}deny <id>, ${bang}help.`].join("\n"));
			case "status":
				return this.#reply(target, (await this.#deps.status().catch(() => "The status could not be built.")).slice(0, 3500));
			case "jobs": {
				const now = this.#now();
				const active = this.#deps.jobs.active().map((job) => describeJob(job, now));
				const recent = this.#deps.jobs.recent(3).map((job) => describeJob(job, now));
				return this.#reply(target, [`Active (${active.length}):`, ...(active.length > 0 ? active : ["(none)"]), "", "Finished lately:", ...(recent.length > 0 ? recent : ["(none)"])].join("\n"));
			}
			case "stop": {
				if (argument === "") return this.#reply(target, `Say which job: ${bang}stop <job id> (see ${bang}jobs).`);
				const result = await this.#deps.jobs.stop(argument.split(/\s+/)[0]!, who, "asked to stop from Slack");
				return this.#reply(target, result === "unknown" ? "I have no such job." : result === "cancelled" ? "That job had not started: it will not run." : result === "told" ? "The job was told. It decides what to do; its result message says how it ended." : "That job had already finished.");
			}
			case "approve":
			case "deny": {
				if (argument === "") return this.#reply(target, `Say which question: ${bang}${name} <id>.`);
				const result = this.#deps.approvals.decide(argument.split(/\s+/)[0]!, who, conversationId, name === "approve");
				return this.#reply(target, result === "decided" ? (name === "approve" ? "Approved." : "Denied.") : result === "rejected" ? "That question was not put to you here." : "I have no open question with that id (it may have timed out).");
			}
			default:
				return this.#reply(target, `I do not know ${bang}${name}. ${COMMANDS.map((command) => `${bang}${command}`).join(", ")}.`);
		}
	}

	async #reply(target: SlackTarget, text: string): Promise<void> {
		try {
			for (const chunk of slackChunks(finishReply(text, 8192))) await this.#deps.api("chat.postMessage", slackMessage(target, chunk));
		} catch (error) {
			this.#log("warn", "slack_reply_failed", { error: cut(error) });
		}
	}
}
