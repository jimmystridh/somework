import { PolicyError } from "./policy.ts";
import type { InboundMessage } from "./domain.ts";
import type { Notifications, TaskEvent, TaskTracker } from "./notifier.ts";
import { scrub } from "./redact.ts";
import type { PiRpc } from "./rpc.ts";
import type { ManagerService, Owner } from "./service.ts";
import type { ManagerState, SaveState } from "./state.ts";
import { isPrivateUserMessage, textChunks, validPairing, type TelegramApi } from "./telegram.ts";

const HELP = [
	"Ordinary messages go to the Manager (Pi in /workspace). It can find and use the other agents, and asks you before anything that writes.",
	"Commands: /agents, /tasks, /pending, /approve <id>, /deny <id>, /answer <taskId> <text>, /cancel <taskId>, /status, /stop, /workspace, /help.",
	"A reply to a question message answers that task: yes/no approves or denies, anything else is passed as the answer. Text only.",
].join("\n");

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}...` : text);

export function describeResult(view: any): string {
	const result = view.result;
	const lines: string[] = [];
	if (result && typeof result === "object") {
		if (result.prUrl) lines.push(`PR: ${result.prUrl}`);
		else if (result.branch) lines.push(`Branch: ${result.branch}`);
		if (typeof result.summary === "string") lines.push(clip(result.summary, 700));
		else if (!result.prUrl) lines.push(clip(JSON.stringify(result), 700));
		const usage = result.usage;
		if (usage?.totalTokens) lines.push(`Used ${usage.totalTokens} tokens${usage.costUsd ? `, $${usage.costUsd}` : ""}`);
	} else if (result !== undefined) {
		lines.push(clip(String(result), 700));
	}
	return lines.join("\n");
}

export function describeQuestion(view: any): string {
	const question = view.blocker?.question ?? view.pendingInput ?? view.question;
	if (question === undefined) return "The agent is waiting for your input.";
	const text = typeof question === "string" ? question : (question.question ?? question.prompt ?? JSON.stringify(question));
	return clip(typeof text === "string" ? text : JSON.stringify(text), 900);
}

/** Free text answers: yes/no variants approve or deny, anything else goes through as an answer. */
export function answerFrom(text: string): Record<string, unknown> {
	const trimmed = text.trim();
	if (/^(y|yes|approve|approved|ok|okay)\b/i.test(trimmed)) return { approved: true };
	const denied = /^(n|no|deny|denied|reject)\b[\s,:-]*(.*)$/i.exec(trimmed);
	if (denied) return { approved: false, ...(denied[2] ? { reason: denied[2] } : {}) };
	return { answer: trimmed };
}

export interface BridgeDeps {
	state: ManagerState;
	api: TelegramApi;
	rpc: PiRpc;
	save: SaveState;
	service?: ManagerService;
	tracker?: TaskTracker;
	notifications?: Notifications;
}

interface ActiveTurn {
	chatId: number;
	message?: any;
}

export class TelegramBridge implements Owner {
	active: ActiveTurn | undefined = undefined;
	typingTimer: NodeJS.Timeout | undefined = undefined;
	delivery: Promise<void> = Promise.resolve();
	readonly state: ManagerState;
	readonly api: TelegramApi;
	readonly rpc: PiRpc;
	readonly save: SaveState;
	service: ManagerService | undefined;
	tracker: TaskTracker | undefined;

	constructor(deps: BridgeDeps) {
		this.state = deps.state;
		this.api = deps.api;
		this.rpc = deps.rpc;
		this.save = deps.save;
		this.service = deps.service;
		this.tracker = deps.tracker;
		deps.rpc.onEvent = (event) => this.onPiEvent(event);
		deps.notifications?.onTaskEvent((event) => this.announceTask(event));
		deps.notifications?.onMessage((message) => this.forwardMessage(message));
	}

	async reply(chatId: number, text: string): Promise<number | undefined> {
		let last: number | undefined;
		for (const chunk of textChunks(text)) last = (await this.api("sendMessage", { chat_id: chatId, text: chunk }))?.message_id ?? last;
		return last;
	}

	/** Owner channel for the service: refuses while nobody is paired, so nothing waits for an approval that cannot arrive. */
	async tell(text: string): Promise<number | undefined> {
		if (!this.state.chatId || !this.state.allowedUserId) throw new Error("owner not paired");
		return this.reply(this.state.chatId, text);
	}

	async announceTask(event: TaskEvent): Promise<number | undefined> {
		const { task, view } = event;
		if (event.kind === "input_required") {
			return this.tell(`Task ${task.taskId} (${task.capability}) asks:\n${describeQuestion(view)}\nReply to this message, or /answer ${task.taskId} <text>.`);
		}
		const head = `Task ${task.taskId} (${task.capability}) ${view.state}`;
		const detail = view.state === "succeeded" ? describeResult(view) : view.failure ? `${view.failure.code ?? "failed"}: ${clip(String(view.failure.message ?? ""), 500)}` : "";
		return this.tell(scrub([head, detail].filter(Boolean).join("\n")));
	}

	async forwardMessage(message: InboundMessage): Promise<void> {
		await this.tell(scrub(`[${message.from}] ${clip(message.text, 3500)}`));
	}

	onPiEvent(event: any): void {
		if (!this.active) return;
		if (event.type === "message_end" && event.message?.role === "assistant") this.active.message = event.message;
		if (event.type !== "agent_settled") return;
		const active = this.active;
		this.active = undefined;
		clearInterval(this.typingTimer);
		this.typingTimer = undefined;
		const message = active.message;
		const text =
			message?.stopReason === "error"
				? "Pi could not complete that request. Try again or check its provider login."
				: message?.stopReason === "aborted"
					? "Stopped."
					: message?.content
							?.filter((block: any) => block.type === "text")
							.map((block: any) => block.text)
							.join("\n") || "Done.";
		this.delivery = this.delivery.then(() => this.reply(active.chatId, text)).then(() => {}).catch(() => console.error("Telegram reply delivery failed"));
	}

	async handleUpdate(update: any): Promise<void> {
		const message = update.message;
		if (!isPrivateUserMessage(message)) return;
		if (!this.state.allowedUserId) {
			if (!validPairing(message, this.state)) return;
			this.state.allowedUserId = message.from.id;
			this.state.chatId = message.chat.id;
			delete this.state.pairingHash;
			delete this.state.pairingExpiresAt;
			delete this.state.pairingCreatedAt;
			await this.save(this.state);
			await this.reply(message.chat.id, "Paired. Only this Telegram account can control the Manager. Send a message, or /help.");
			console.log("Telegram owner paired");
			return;
		}
		if (message.from.id !== this.state.allowedUserId || message.chat.id !== this.state.chatId) return;
		const text = message.text?.trim();
		if (!text) {
			await this.reply(message.chat.id, "This small bridge supports text messages only.");
			return;
		}
		const chatId: number = message.chat.id;
		if (text.startsWith("/")) return this.command(chatId, text);
		const repliedTo = message.reply_to_message?.message_id;
		const asked = repliedTo === undefined ? undefined : this.tracker?.tasks.find((task) => task.questionMessageId === repliedTo && task.state === "input_required");
		if (asked) return this.answer(chatId, asked.taskId, text);
		return this.prompt(chatId, text);
	}

	async command(chatId: number, text: string): Promise<void> {
		const [name = "", ...rest] = text.split(/\s+/);
		const argument = rest.join(" ").trim();
		const say = (reply: string) => this.reply(chatId, reply).then(() => {});
		switch (name.toLowerCase()) {
			case "/start":
			case "/help":
				return say(HELP);
			case "/workspace":
				return say("Current workspace: /workspace\nThe Manager is already in this directory; there is no need to switch. Send an ordinary message such as \"Which agents can review code?\".");
			case "/status": {
				const status = await this.rpc.command("get_state");
				const waiting = this.service?.pending().length ?? 0;
				const open = this.tracker?.activeIds().length ?? 0;
				return say(`Manager ${status.isStreaming ? "working" : "idle"}\nModel: ${status.model?.provider}/${status.model?.id}\nThinking: ${status.thinkingLevel}\nWorkspace: /workspace\nTasks in flight: ${open}, approvals waiting: ${waiting}`);
			}
			case "/stop":
				await this.rpc.command("clear_queue");
				await this.rpc.command("abort", {}, 60_000);
				return say("Stop requested.");
			case "/agents":
				return this.needService(say, async (service) => {
					const agents = await service.agents();
					return say(agents.length ? agents.map((a) => `${a.agentId} [${a.availability ?? "?"}]: ${a.capabilities.join(", ") || "-"}`).join("\n") : "No agents in the catalog.");
				});
			case "/tasks":
				return say(
					this.tracker?.tasks.length
						? this.tracker.tasks.slice(0, 10).map((t) => `${t.taskId} ${t.state} ${t.capability} (${t.submittedAt.slice(11, 16)}Z)`).join("\n")
						: "No tasks submitted yet.",
				);
			case "/pending":
				return this.needService(say, (service) => {
					const pending = service.pending();
					return say(pending.length ? pending.map((a) => `${a.id} ${a.capability.id}@${a.capability.version} (${a.sideEffects}) until ${new Date(a.expiresAt).toISOString().slice(11, 16)}Z`).join("\n") : "Nothing waits for approval.");
				});
			case "/approve":
				return this.needService(say, async (service) => {
					if (!argument) return say("Usage: /approve <id>");
					try {
						return say((await service.approve(argument)).message);
					} catch (error) {
						return say(`Approved, but submitting failed: ${error instanceof Error ? clip(error.message, 300) : "error"}`);
					}
				});
			case "/deny":
				return this.needService(say, (service) => (argument ? say(service.deny(argument).message) : say("Usage: /deny <id>")));
			case "/answer": {
				const [taskId, ...words] = rest;
				if (!taskId || words.length === 0) return say("Usage: /answer <taskId> <text>");
				return this.answer(chatId, taskId, words.join(" "));
			}
			case "/cancel":
				return this.needService(say, async (service) => {
					if (!argument) return say("Usage: /cancel <taskId>");
					try {
						await service.cancel(argument, "canceled by the owner");
						return say(`Cancel requested for ${argument}.`);
					} catch (error) {
						return say(error instanceof PolicyError ? error.message : "Cancel failed.");
					}
				});
			default:
				return say("Unknown command. Use /help.");
		}
	}

	async needService(say: (text: string) => Promise<void>, run: (service: ManagerService) => Promise<void> | void): Promise<void> {
		if (!this.service) return say("The SomeWork gateway is not configured.");
		try {
			await run(this.service);
		} catch (error) {
			await say(`SomeWork request failed: ${error instanceof Error ? clip(scrub(error.message), 300) : "error"}`);
		}
	}

	async answer(chatId: number, taskId: string, text: string): Promise<void> {
		if (!this.service) return void (await this.reply(chatId, "The SomeWork gateway is not configured."));
		try {
			await this.service.answer(taskId, answerFrom(text));
			await this.reply(chatId, `Answer sent to ${taskId}.`);
		} catch (error) {
			await this.reply(chatId, error instanceof PolicyError ? error.message : `Could not send the answer: ${error instanceof Error ? clip(scrub(error.message), 200) : "error"}`);
		}
	}

	async prompt(chatId: number, text: string): Promise<void> {
		if (this.active || (await this.rpc.command("get_state")).isStreaming) {
			await this.reply(chatId, "The Manager is busy. Wait for its reply, or send /stop first.");
			return;
		}
		this.active = { chatId };
		const typing = () => this.api("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
		void typing();
		this.typingTimer = setInterval(typing, 4500);
		try {
			await this.rpc.command("prompt", { message: `[telegram] ${text}` });
		} catch {
			this.active = undefined;
			clearInterval(this.typingTimer);
			this.typingTimer = undefined;
			await this.reply(chatId, "The Manager did not accept that task. Check /status before retrying.");
		}
	}
}
