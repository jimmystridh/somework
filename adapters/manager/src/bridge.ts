import { PolicyError } from "./policy.ts";
import type { InboundMessage } from "./domain.ts";
import type { Notifications } from "./notifier.ts";
import { CONTROL_REQUEST_ID, describeAction, parseAction, type ControlAction, type Controls } from "./controls.ts";
import { WindowedLimiter } from "./rate.ts";
import { defang, scrub } from "./redact.ts";
import type { PiRpc } from "./rpc.ts";
import type { ManagerService, Owner } from "./service.ts";
import type { ManagerState, SaveState } from "./state.ts";
import { isPrivateUserMessage, textChunks, validPairing, type TelegramApi } from "./telegram.ts";

const HELP = [
	"Ordinary messages go to the Manager (Pi in /workspace). It can find the other agents and talk to them for you, like a colleague would.",
	"Chat with an agent: /ask <agent> <text> (the name may be short, like reviewer). The agent decides what to do with it: answer, or start work in the background. Its answer arrives here, and you are told if none comes in 3 minutes. 30 messages per hour, 2000 characters each.",
	"Commands: /agents, /pending, /approve <id>, /deny <id>, /status, /stop, /workspace, /help.",
	"Approvals: when an agent needs your approval for a step you get a question here and answer with /chatapprove <id> or /chatdeny <id>. Switches the Manager asks for (pause a rule, raise a budget) wait for the Confirm button or /approve <id>.",
	"Jobs: agents run long work in the background and tell you here when a job finishes (one line: the agent, the job, how it ended).",
	"Everything at once: /suspend [reason] pauses every rule and event source and switches off every agent's handlers and the Manager's own work; approvals are refused until /unsuspend, which puts back exactly what /suspend changed.",
	"Events: /rules, /pause <rule>, /resume <rule>, /sources, /pausesource <source>, /resumesource <source>, /handlers <agent>, /kill <agent> <handler|all> [reason], /unkill <agent> <handler|all>.",
	"Text only.",
].join("\n");

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}...` : text);

export interface BridgeDeps {
	state: ManagerState;
	api: TelegramApi;
	rpc: PiRpc;
	save: SaveState;
	service?: ManagerService;
	notifications?: Notifications;
	/** Notices and messages other agents send, per sender and hour, before the rest are only counted (default 10). */
	noticesPerHour?: number;
	now?: () => number;
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
	readonly #notices: WindowedLimiter;

	constructor(deps: BridgeDeps) {
		this.#notices = new WindowedLimiter(deps.noticesPerHour ?? 10, 3_600_000, deps.now);
		this.state = deps.state;
		this.api = deps.api;
		this.rpc = deps.rpc;
		this.save = deps.save;
		this.service = deps.service;
		deps.rpc.onEvent = (event) => this.onPiEvent(event);
		deps.notifications?.onMessage((message) => this.forwardMessage(message));
	}

	async reply(chatId: number, text: string, markup?: unknown): Promise<number | undefined> {
		let last: number | undefined;
		const chunks = textChunks(text);
		for (const [index, chunk] of chunks.entries()) {
			const buttons = markup !== undefined && index === chunks.length - 1 ? { reply_markup: markup } : {};
			last = (await this.api("sendMessage", { chat_id: chatId, text: chunk, ...buttons }))?.message_id ?? last;
		}
		return last;
	}

	/** Owner channel for the service: refuses while nobody is paired, so nothing waits for an approval that cannot arrive. */
	async tell(text: string, markup?: unknown): Promise<number | undefined> {
		if (!this.state.chatId || !this.state.allowedUserId) throw new Error("owner not paired");
		return this.reply(this.state.chatId, text, markup);
	}

	/**
	 * What other agents write to the Manager, including the event notices of the agents' handlers (handler decisions to notify, auto-disabled
	 * handlers, used-up token pools). Shown as plain text after `defang`, limited per sender so one noisy agent cannot flood the chat.
	 */
	async forwardMessage(message: InboundMessage): Promise<void> {
		if (await this.service?.chats?.route(message)) return;
		const chat = this.service?.chats;
		if (chat && message.type === "chat.message" && message.labels?.eventNotice !== "true") {
			// a plain direct chat from an agent outside any conversation the owner started: still shown, with the agent's name as title
			await chat.show(message, false);
			return;
		}
		const { pass, carried } = this.#notices.take(message.from);
		if (carried > 0) await this.tell(`${carried} more messages from ${defang(message.from)} were suppressed in the last hour.`);
		if (!pass) return;
		const notice = message.labels?.eventNotice === "true";
		await this.tell(`[${notice ? "events: " : ""}${defang(message.from)}] ${clip(defang(message.text), 3500)}`);
	}

	async reportSuppressed(): Promise<void> {
		for (const { key, suppressed } of this.#notices.finished()) await this.tell(`${suppressed} more messages from ${defang(key)} were suppressed in the last hour.`).catch(() => {});
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
		if (update.callback_query) return this.handleCallback(update.callback_query);
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
		return this.prompt(chatId, text);
	}

	/** A tap on an inline button. Only the paired owner, in the paired private chat, is ever answered; anyone else's tap is dropped silently. */
	async handleCallback(query: any): Promise<void> {
		const owner = this.state.allowedUserId;
		const chat = query?.message?.chat;
		if (!owner || query?.from?.id !== owner || chat?.type !== "private" || chat.id !== this.state.chatId) return;
		const answer = (text: string) => this.api("answerCallbackQuery", { callback_query_id: query.id, text: text.slice(0, 190) }).catch(() => {});
		const match = /^ct:([yn]):([A-Za-z0-9_-]{1,70})$/.exec(String(query.data ?? ""));
		if (!match || !this.service) return void (await answer("That button does not work any more."));
		const [, choice, id] = match as unknown as [string, string, string];
		if (!CONTROL_REQUEST_ID.test(id)) return void (await answer("That button does not work any more."));
		if (choice === "y" && this.isSuspended()) return void (await answer("Everything is suspended: /unsuspend first."));
		try {
			const result = choice === "y" ? await this.service.approve(id) : await this.service.denyAny(id);
			await answer(result.ok ? "Done." : "Not done.");
			if (query.message?.message_id !== undefined) {
				await this.api("editMessageReplyMarkup", { chat_id: chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
			}
			await this.reply(chat.id, result.message);
		} catch (error) {
			await answer("Failed.");
			await this.reply(chat.id, `That did not work: ${error instanceof Error ? clip(defang(error.message), 300) : "error"}`);
		}
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
				const waiting = (this.service?.pendingRequests() ?? 0) + Object.keys(this.state.chatApprovals ?? {}).length;
				return say(`${this.state.suspended ? `SUSPENDED since ${this.state.suspended.at.slice(0, 16)}Z${this.state.suspended.reason ? ` (${this.state.suspended.reason})` : ""}\n` : this.isSuspended() ? "SUSPENDED (the processes are stopped; /unsuspend starts them)\n" : ""}Manager ${status.isStreaming ? "working" : "idle"}\nModel: ${status.model?.provider}/${status.model?.id}\nThinking: ${status.thinkingLevel}\nWorkspace: /workspace\nQuestions waiting for you: ${waiting}`);
			}
			case "/suspend":
				return this.suspendEverything(say, argument);
			case "/unsuspend":
				return this.needService(say, async (service) => say(await this.controlsOf(service).resumeAll()));
			case "/stop":
				await this.rpc.command("clear_queue");
				await this.rpc.command("abort", {}, 60_000);
				return say("Stop requested.");
			case "/agents":
				return this.needService(say, async (service) => {
					const agents = await service.agents();
					return say(agents.length ? agents.map((a) => `${a.agentId} [${a.availability ?? "?"}]: ${a.capabilities.join(", ") || "-"}`).join("\n") : "No agents in the catalog.");
				});
			case "/pending":
				return this.needService(say, (service) => {
					const pending = service.controlRequests?.pending() ?? [];
					const questions = Object.entries(this.state.chatApprovals ?? {}).map(([id, ask]) => `${id} ${defang(ask.agent)} asks for approval of a step (/chatapprove ${id} or /chatdeny ${id})`);
					const requests = pending.map((request) => `${request.id} ${describeAction(request.action)} until ${new Date(request.expiresAt).toISOString().slice(11, 16)}Z`);
					return say([...questions, ...requests].join("\n") || "Nothing waits for you.");
				});
			case "/approve":
				return this.needService(say, async (service) => {
					if (this.isSuspended()) return say("Everything is suspended: send /unsuspend before approving anything.");
					if (!argument) return say("Usage: /approve <id>");
					return say((await service.approve(argument)).message);
				});
			case "/deny":
				return this.needService(say, async (service) => (argument ? say((await service.denyAny(argument)).message) : say("Usage: /deny <id>")));
			case "/rules":
				return this.needService(say, async (service) => say(this.controlsOf(service).formatRules(await this.controlsOf(service).rules())));
			case "/sources":
				return this.needService(say, async (service) => say(this.controlsOf(service).formatSources(await this.controlsOf(service).sources())));
			case "/handlers":
				return this.needService(say, async (service) => {
					if (!/^agent\/[a-z0-9][a-z0-9._-]{0,48}$/.test(argument)) return say("Usage: /handlers <agent>, for example /handlers agent/reviewer");
					return say(this.controlsOf(service).formatHandlers(argument, await this.controlsOf(service).handlers(argument)));
				});
			case "/pause":
			case "/resume":
				return this.control(say, { action: name.toLowerCase() === "/pause" ? "pause_rule" : "resume_rule", rule: argument });
			case "/pausesource":
			case "/resumesource":
				return this.control(say, { action: name.toLowerCase() === "/pausesource" ? "pause_source" : "resume_source", source: argument });
			case "/kill":
			case "/unkill": {
				const [agent, handler, ...reason] = rest;
				return this.control(say, { action: name.toLowerCase() === "/kill" ? "kill_handler" : "unkill_handler", agent, handler, reason: reason.join(" ") || undefined });
			}
			case "/chatapprove":
			case "/chatdeny":
				return this.needService(say, async (service) => {
					if (!argument || !service.chats) return say("Usage: /chatapprove <id> or /chatdeny <id>, with the id from the question.");
					const approved = name.toLowerCase() === "/chatapprove";
					if (approved && this.isSuspended()) return say("Everything is suspended: send /unsuspend before approving anything.");
					try {
						const { agent } = await service.chats.decide(argument, approved);
						await say(`${approved ? "Approved" : "Denied"} for ${defang(agent)}.`);
					} catch (error) {
						await say(error instanceof PolicyError ? error.message : `Could not send the answer: ${error instanceof Error ? clip(defang(error.message), 200) : "error"}`);
					}
				});
			case "/ask":
				return this.needService(say, async (service) => {
					const [agent, ...words] = rest;
					if (!agent || words.length === 0) return say("Usage: /ask <agent> <text>, for example /ask reviewer what can you do?");
					try {
						// the service tells the owner "sent, waiting for a reply" itself, so the same text comes from /ask and from the tool
						await service.ask({ agent, text: words.join(" ") });
					} catch (error) {
						await say(error instanceof PolicyError ? error.message : `Could not send: ${error instanceof Error ? clip(defang(error.message), 200) : "error"}`);
					}
				});
			default:
				return say("Unknown command. Use /help.");
		}
	}

	/** The owner's kill switch: stop what the platform starts, cancel what runs, and stop the Manager's own model run. Each step reports itself. */
	async suspendEverything(say: (text: string) => Promise<void>, reason: string): Promise<void> {
		await say("Suspending everything...");
		const lines: string[] = [];
		await this.needService(say, async (service) => {
			lines.push(await this.controlsOf(service).suspendAll(reason || undefined));
		});
		await this.rpc.command("clear_queue").catch(() => {});
		await this.rpc.command("abort", {}, 60_000).catch(() => {});
		lines.push("The Manager's own work is stopped. Jobs the agents are running in the background are not cancelled from here: to stop the machines themselves use scripts/fleet-suspend.sh.");
		return say(["SUSPENDED.", ...lines, "Send /unsuspend to put everything back."].join("\n"));
	}

	/** The recorded suspension, or the flag file of the machines (also left by scripts/fleet-suspend.sh). */
	isSuspended(): boolean {
		return this.state.suspended !== undefined || (this.service?.controls?.isSuspended() ?? false);
	}

	controlsOf(service: ManagerService): Controls {
		if (!service.controls) throw new PolicyError(503, "not_configured", "event controls are not configured");
		return service.controls;
	}

	/** The owner's own switch commands run at once; only switches the model asks for wait for a confirmation. */
	async control(say: (text: string) => Promise<void>, raw: Record<string, unknown>): Promise<void> {
		return this.needService(say, async (service) => {
			let action: ControlAction;
			try {
				action = parseAction(raw);
			} catch (error) {
				return say(error instanceof PolicyError ? error.message : "That is not a valid request.");
			}
			return say(await this.controlsOf(service).run(action));
		});
	}

	async needService(say: (text: string) => Promise<void>, run: (service: ManagerService) => Promise<void> | void): Promise<void> {
		if (!this.service) return say("The SomeWork gateway is not configured.");
		try {
			await run(this.service);
		} catch (error) {
			await say(`SomeWork request failed: ${error instanceof Error ? clip(scrub(error.message), 300) : "error"}`);
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
			await this.reply(chatId, "The Manager did not accept that message. Check /status before retrying.");
		}
	}
}
