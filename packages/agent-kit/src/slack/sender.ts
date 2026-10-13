import { silent, type Log } from "../log.ts";
import { attachmentsLine } from "../telegram/sender.ts";
import { finishReply, type OutgoingMessage, type Sender, type SentMessage } from "../threads/message.ts";
import { slackChunks, slackTargetOf, type SlackApi } from "./api.ts";
import { SLACK_PREFIX, type SlackStore } from "./store.ts";

/** Plain text: no markup of Slack's is read into what the agent says, and no link is expanded into a preview. */
export const slackMessage = (target: { channel: string; threadTs?: string }, text: string): Record<string, unknown> => ({
	channel: target.channel,
	...(target.threadTs ? { thread_ts: target.threadTs } : {}),
	text,
	mrkdwn: false,
	unfurl_links: false,
	unfurl_media: false,
});

/** The question as blocks (plain text) with its two buttons; the message's `text` stays as what notifications and old clients show. */
const approvalBlocks = (text: string, id: string): unknown[] => [
	{ type: "section", text: { type: "plain_text", text: text.slice(0, 3000), emoji: false } },
	{
		type: "actions",
		block_id: `approval:${id}`,
		elements: [
			{ type: "button", action_id: "approve", value: id, style: "primary", text: { type: "plain_text", text: "Approve" } },
			{ type: "button", action_id: "deny", value: id, style: "danger", text: { type: "plain_text", text: "Deny" } },
		],
	},
];

/** Delivers what an agent says in a Slack conversation to that DM or thread. */
export class SlackSender implements Sender {
	readonly #api: SlackApi;
	readonly #store: SlackStore;
	readonly #agentId: string;
	readonly #maxBytes: number;
	readonly #log: Log;
	#sent = 0;

	constructor(options: { api: SlackApi; store: SlackStore; agentId: string; maxBytes?: number; log?: Log }) {
		this.#api = options.api;
		this.#store = options.store;
		this.#agentId = options.agentId;
		this.#maxBytes = options.maxBytes ?? 8192;
		this.#log = options.log ?? silent;
	}

	async send(message: OutgoingMessage): Promise<SentMessage> {
		return this.#deliver(message);
	}

	async #deliver(message: OutgoingMessage, question?: string): Promise<SentMessage> {
		const target = slackTargetOf(message.conversationId);
		if (!target) throw new Error("not a Slack conversation");
		const text = finishReply(`${message.text}${attachmentsLine(message.artifacts)}`, this.#maxBytes);
		const messageId = `${SLACK_PREFIX}out:${Date.now()}:${this.#sent++}`;
		this.#store.record({ id: messageId, conversationId: message.conversationId!, sender: { kind: "agent", id: this.#agentId }, text, at: new Date().toISOString() });
		const chunks = slackChunks(text);
		for (const [index, chunk] of chunks.entries()) await this.#api("chat.postMessage", { ...slackMessage(target, chunk), ...(question !== undefined && index === chunks.length - 1 ? { blocks: approvalBlocks(chunk, question) } : {}) });
		this.#log("info", "slack_sent", { chunks: chunks.length });
		return { messageId, conversationId: message.conversationId! };
	}

	/** A line into a conversation that is not an answer. */
	async say(conversationId: string, text: string): Promise<void> {
		await this.send({ recipients: [], conversationId, text, key: "" });
	}

	/** An approval question with Approve and Deny buttons; `id` is the question's id, which the tap carries back (`parseSlackAction`). */
	async ask(conversationId: string, text: string, id: string): Promise<void> {
		await this.#deliver({ recipients: [], conversationId, text, key: "" }, id);
	}
}
