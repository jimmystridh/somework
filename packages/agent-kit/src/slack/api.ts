import { textChunks } from "../telegram/api.ts";
import { SLACK_PREFIX } from "./store.ts";

export type SlackApi = (method: string, payload?: Record<string, unknown>, signal?: AbortSignal) => Promise<any>;

/** What a reply is cut into: Slack cuts a message of more than 4000 characters, and long ones read badly anyway. */
export const SLACK_CHUNK = 3000;

export const slackChunks = (text: string): string[] => textChunks(text, SLACK_CHUNK);

/** Where a reply goes: a channel (a DM is one), in a thread of it when there is one. */
export interface SlackTarget {
	channel: string;
	threadTs?: string;
}

export const slackConversationId = (target: SlackTarget): string => `${SLACK_PREFIX}${target.channel}${target.threadTs ? `:${target.threadTs}` : ""}`;

/** The channel and thread of a conversation id (`slack:C0123` or `slack:C0123:1700000000.000100`); undefined for anything else. */
export function slackTargetOf(conversationId: string | undefined): SlackTarget | undefined {
	const match = /^slack:([A-Z0-9]+)(?::(\d+\.\d+))?$/.exec(conversationId ?? "");
	return match ? { channel: match[1]!, ...(match[2] ? { threadTs: match[2] } : {}) } : undefined;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const timeout = (signal: AbortSignal | undefined): AbortSignal => (signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000));

/** Slack's error codes are short snake_case words; anything else is not shown. */
const errorCode = (data: any): string => (typeof data?.error === "string" && /^[a-z_]{1,40}$/.test(data.error) ? data.error : "unknown");

/**
 * The Web API over `fetch`, with the bot token. Errors never carry the URL or a token, and outbound text is scrubbed of both tokens. A 429 is
 * waited out once (`Retry-After`, at most a minute) and then tried again.
 */
export function slackApi(tokens: { botToken: string; appToken?: string }, fetchApi: typeof fetch = fetch, sleep: (ms: number) => Promise<void> = defaultSleep): SlackApi {
	const scrub = (text: string): string => {
		const bot = text.replaceAll(tokens.botToken, "[redacted bot token]");
		return tokens.appToken ? bot.replaceAll(tokens.appToken, "[redacted app token]") : bot;
	};
	return async (method, payload = {}, signal) => {
		if (method === "chat.postMessage" && typeof payload.text === "string") payload = { ...payload, text: scrub(payload.text) };
		for (let attempt = 0; ; attempt++) {
			let response: Response;
			try {
				response = await fetchApi(`https://slack.com/api/${method}`, {
					method: "POST",
					headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${tokens.botToken}` },
					body: JSON.stringify(payload),
					signal: timeout(signal),
				});
			} catch {
				throw new Error("Slack request failed");
			}
			if (response.status === 429 && attempt === 0) {
				const seconds = Number(response.headers?.get?.("retry-after"));
				await sleep(Math.min(Number.isFinite(seconds) && seconds >= 0 ? seconds : 1, 60) * 1000);
				continue;
			}
			if (response.status === 429) throw new Error("Slack API error ratelimited");
			let data: any;
			try {
				data = await response.json();
			} catch {
				throw new Error("Slack request failed");
			}
			if (!data?.ok) throw new Error(`Slack API error ${errorCode(data)}`);
			return data;
		}
	};
}

/** Asks Slack for the address of a Socket Mode connection with the app-level token. The address is good for one connection and for seconds only. */
export function slackSocketUrl(appToken: string, fetchApi: typeof fetch = fetch): (signal?: AbortSignal) => Promise<string> {
	return async (signal) => {
		let data: any;
		try {
			const response = await fetchApi("https://slack.com/api/apps.connections.open", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${appToken}` },
				signal: timeout(signal),
			});
			data = await response.json();
		} catch {
			throw new Error("Slack request failed");
		}
		if (!data?.ok) throw new Error(`Slack API error ${errorCode(data)}`);
		if (typeof data.url !== "string" || !data.url.startsWith("wss://")) throw new Error("Slack gave no connection address");
		return data.url;
	};
}

export type ParsedSlackEvent =
	| { kind: "text"; eventKey: string; keys: string[]; userId: string; target: SlackTarget; conversationId: string; text: string; sentAt: string }
	| { kind: "unsupported"; keys: string[]; target: SlackTarget }
	| { kind: "ignored"; reason: "not_a_message" | "bot" | "subtype" | "not_private" | "not_allowed" | "channel_not_allowed" };

const decodeEscapes = (text: string): string => text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/** The text without the mention of the bot that addresses it (`<@U0123ABCD> `), and with Slack's escapes undone. */
export function cleanSlackText(text: string, botUserId?: string): string {
	const mention = botUserId ? new RegExp(`^\\s*<@${botUserId}(?:\\|[^>]*)?>[\\s,:]*`) : /^\s*<@[UW][A-Z0-9]+(?:\|[^>]*)?>[\s,:]*/;
	return decodeEscapes(text.replace(mention, "")).trim();
}

/**
 * The payload of one `events_api` envelope, sorted into what the channel does with it. Only a DM from an allowed person, or a mention by an
 * allowed person in an allowed channel, is ever served; everything else is ignored without an answer, so the bot does not tell strangers that
 * it is there. A mention is answered in a thread of the message. Undefined: not a payload at all.
 */
export function parseSlackEvent(payload: any, allowed: { users: ReadonlySet<string>; channels: ReadonlySet<string> }, maxChars = 4000): ParsedSlackEvent | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const event = payload.event;
	if (!event || typeof event !== "object" || (event.type !== "message" && event.type !== "app_mention")) return { kind: "ignored", reason: "not_a_message" };
	const botUserId: string | undefined = typeof payload.authorizations?.[0]?.user_id === "string" && /^[UW][A-Z0-9]+$/.test(payload.authorizations[0].user_id) ? payload.authorizations[0].user_id : undefined;
	if (event.bot_id || event.bot_profile || event.subtype === "bot_message" || (botUserId !== undefined && event.user === botUserId)) return { kind: "ignored", reason: "bot" };
	const ts: unknown = event.ts;
	const channel: unknown = event.channel;
	if (typeof ts !== "string" || !/^\d+\.\d+$/.test(ts) || typeof channel !== "string" || !/^[A-Z0-9]+$/.test(channel)) return { kind: "ignored", reason: "not_a_message" };
	const mention = event.type === "app_mention";
	if (!mention && event.channel_type !== "im") return { kind: "ignored", reason: "not_private" };
	if ((event.subtype !== undefined && event.subtype !== "file_share") || event.edited) return { kind: "ignored", reason: "subtype" };
	if (typeof event.user !== "string" || !allowed.users.has(event.user)) return { kind: "ignored", reason: "not_allowed" };
	if (mention && !allowed.channels.has(channel)) return { kind: "ignored", reason: "channel_not_allowed" };
	const thread = mention ? (typeof event.thread_ts === "string" && /^\d+\.\d+$/.test(event.thread_ts) ? event.thread_ts : ts) : undefined;
	const target: SlackTarget = { channel, ...(thread ? { threadTs: thread } : {}) };
	const eventId: string | undefined = typeof payload.event_id === "string" && payload.event_id !== "" ? payload.event_id : undefined;
	const keys = [...(eventId ? [eventId] : []), `${channel}:${ts}`];
	const hasFiles = event.subtype === "file_share" || (Array.isArray(event.files) && event.files.length > 0);
	const text = hasFiles || typeof event.text !== "string" ? "" : cleanSlackText(event.text, botUserId);
	if (text === "") return { kind: "unsupported", keys, target };
	return { kind: "text", eventKey: eventId ?? ts, keys, userId: event.user, target, conversationId: slackConversationId(target), text: text.slice(0, maxChars), sentAt: new Date(Number(ts.split(".")[0]) * 1000).toISOString() };
}
