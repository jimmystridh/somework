/** What the triage needs of Slack: find a person by e-mail address, open a direct message with them, write into it and read what they answered. */
export interface SlackPort {
	findUserByEmail(email: string): Promise<string | undefined>;
	openDirectMessage(userId: string): Promise<string>;
	post(channel: string, text: string): Promise<{ ts: string }>;
	/** Messages the person wrote in the direct message after `afterTs`, oldest first. */
	replies(channel: string, afterTs: string, userId: string): Promise<{ ts: string; text: string }[]>;
	/** A display name for a member id, when Slack gives one. */
	displayName(userId: string): Promise<string | undefined>;
}

export class SlackError extends Error {
	override readonly name = "SlackError";
	readonly code: string;
	constructor(code: string) {
		super(`Slack API error ${code}`);
		this.code = code;
	}
}

const errorCode = (data: any): string => (typeof data?.error === "string" && /^[a-z_]{1,40}$/.test(data.error) ? data.error : "unknown");

const MEMBER = /^[UW][A-Z0-9]{2,}$/;
const CHANNEL = /^[A-Z0-9]{3,}$/;
const TIMESTAMP = /^\d+\.\d+$/;

/**
 * The Slack Web API with the agent's bot token, as form posts: the read methods (`users.lookupByEmail`, `conversations.history`) take form fields, not JSON.
 * The token is sent only to slack.com and never appears in an error. Needs the scopes users:read, users:read.email, im:write, im:history and chat:write.
 */
export function slackWebApi(botToken: string, fetchApi: typeof fetch = fetch): SlackPort {
	const call = async (method: string, fields: Record<string, string>): Promise<any> => {
		let data: any;
		try {
			const response = await fetchApi(`https://slack.com/api/${method}`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${botToken}` },
				body: new URLSearchParams(fields).toString(),
				signal: AbortSignal.timeout(20_000),
			});
			data = await response.json();
		} catch {
			throw new SlackError("request_failed");
		}
		if (!data?.ok) throw new SlackError(errorCode(data));
		return data;
	};
	return {
		async findUserByEmail(email) {
			try {
				const data = await call("users.lookupByEmail", { email });
				return typeof data.user?.id === "string" && MEMBER.test(data.user.id) && data.user.deleted !== true && data.user.is_bot !== true ? data.user.id : undefined;
			} catch (error) {
				if (error instanceof SlackError && error.code === "users_not_found") return undefined;
				throw error;
			}
		},
		async openDirectMessage(userId) {
			const data = await call("conversations.open", { users: userId });
			const channel = data.channel?.id;
			if (typeof channel !== "string" || !CHANNEL.test(channel)) throw new SlackError("no_channel");
			return channel;
		},
		async post(channel, text) {
			const data = await call("chat.postMessage", { channel, text, mrkdwn: "false", unfurl_links: "false", unfurl_media: "false" });
			if (typeof data.ts !== "string" || !TIMESTAMP.test(data.ts)) throw new SlackError("no_timestamp");
			return { ts: data.ts };
		},
		async replies(channel, afterTs, userId) {
			const data = await call("conversations.history", { channel, oldest: afterTs, inclusive: "false", limit: "50" });
			const messages: any[] = Array.isArray(data.messages) ? data.messages : [];
			return messages
				.filter((message) => message?.user === userId && !message.bot_id && (message.subtype === undefined || message.subtype === "file_share") && typeof message.text === "string" && message.text.trim() !== "" && typeof message.ts === "string" && TIMESTAMP.test(message.ts) && Number(message.ts) > Number(afterTs))
				.map((message) => ({ ts: message.ts as string, text: String(message.text) }))
				.sort((a, b) => Number(a.ts) - Number(b.ts));
		},
		async displayName(userId) {
			try {
				const data = await call("users.info", { user: userId });
				const name = data.user?.profile?.display_name || data.user?.real_name || data.user?.name;
				return typeof name === "string" && name.trim() !== "" ? name.trim().slice(0, 80) : undefined;
			} catch {
				return undefined;
			}
		},
	};
}
