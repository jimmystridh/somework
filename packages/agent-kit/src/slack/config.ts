import { readFileSync } from "node:fs";

/** What the environment says about the Slack channel; see `resolveSlack` for whether it can start. */
export interface SlackSettings {
	botToken?: string;
	botTokenFile?: string;
	appToken?: string;
	appTokenFile?: string;
	/** The raw `SLACK_ALLOWED_USER_IDS` entries. */
	allowedUserIds: string[];
	/** The raw `SLACK_ALLOWED_CHANNELS` entries. */
	allowedChannels: string[];
	messagesPerHour: number;
}

const list = (raw: string | undefined): string[] => (raw ?? "").split(/[\s,]+/).filter(Boolean);

export function slackSettingsFrom(env: NodeJS.ProcessEnv): SlackSettings {
	const rawLimit = env.SLACK_MESSAGES_PER_HOUR;
	const messagesPerHour = rawLimit === undefined || rawLimit === "" ? 30 : Number(rawLimit);
	if (!Number.isInteger(messagesPerHour) || messagesPerHour <= 0) throw new Error("SLACK_MESSAGES_PER_HOUR must be a positive integer");
	return {
		...(env.SLACK_BOT_TOKEN ? { botToken: env.SLACK_BOT_TOKEN.trim() } : {}),
		...(env.SLACK_BOT_TOKEN_FILE ? { botTokenFile: env.SLACK_BOT_TOKEN_FILE } : {}),
		...(env.SLACK_APP_TOKEN ? { appToken: env.SLACK_APP_TOKEN.trim() } : {}),
		...(env.SLACK_APP_TOKEN_FILE ? { appTokenFile: env.SLACK_APP_TOKEN_FILE } : {}),
		allowedUserIds: list(env.SLACK_ALLOWED_USER_IDS),
		allowedChannels: list(env.SLACK_ALLOWED_CHANNELS),
		messagesPerHour,
	};
}

export type SlackStart = { enabled: false; reason?: string } | { enabled: true; botToken: string; appToken: string; allowedUsers: ReadonlySet<string>; allowedChannels: ReadonlySet<string> };

const BOT_TOKEN = /^xoxb-[A-Za-z0-9-]+$/;
const APP_TOKEN = /^xapp-[A-Za-z0-9-]+$/;
const USER_ID = /^[UW][A-Z0-9]{2,}$/;
const CHANNEL_ID = /^[CG][A-Z0-9]{2,}$/;

/**
 * Whether the channel can start. Neither token set (or both files empty, which is what mounting /dev/null does) is "not configured": no reason,
 * nothing to say. Only one of the two, a token of the wrong kind, or a token without a usable allow-list is a refusal with a reason: a bot that
 * anybody in the workspace can write to must never start by accident. The reasons never contain a token.
 */
export function resolveSlack(settings: SlackSettings, readFile: (path: string) => string = (path) => readFileSync(path, "utf8")): SlackStart {
	const read = (token: string | undefined, file: string | undefined, name: string): { token: string } | { reason: string } => {
		if (token) return { token };
		if (!file) return { token: "" };
		try {
			return { token: readFile(file).trim() };
		} catch {
			return { reason: `${name}_FILE could not be read` };
		}
	};
	const bot = read(settings.botToken, settings.botTokenFile, "SLACK_BOT_TOKEN");
	if ("reason" in bot) return { enabled: false, reason: bot.reason };
	const app = read(settings.appToken, settings.appTokenFile, "SLACK_APP_TOKEN");
	if ("reason" in app) return { enabled: false, reason: app.reason };
	if (!bot.token && !app.token) return { enabled: false };
	if (!bot.token) return { enabled: false, reason: "the Slack bot token is missing or empty (SLACK_BOT_TOKEN or SLACK_BOT_TOKEN_FILE): both the bot token and the app token are required" };
	if (!app.token) return { enabled: false, reason: "the Slack app token is missing or empty (SLACK_APP_TOKEN or SLACK_APP_TOKEN_FILE): both the bot token and the app token are required" };
	if (!BOT_TOKEN.test(bot.token)) return { enabled: false, reason: "the Slack bot token must be a bot token (it starts with xoxb-)" };
	if (!APP_TOKEN.test(app.token)) return { enabled: false, reason: "the Slack app token must be an app-level token (it starts with xapp-)" };
	if (settings.allowedUserIds.length === 0) return { enabled: false, reason: "SLACK_ALLOWED_USER_IDS is required with Slack tokens: list the Slack member ids (like U0123ABCD) that may write to this agent" };
	if (!settings.allowedUserIds.every((id) => USER_ID.test(id))) return { enabled: false, reason: "SLACK_ALLOWED_USER_IDS must be Slack member ids like U0123ABCD separated by commas" };
	if (!settings.allowedChannels.every((id) => CHANNEL_ID.test(id))) return { enabled: false, reason: "SLACK_ALLOWED_CHANNELS must be Slack channel ids like C0123ABCD separated by commas" };
	return { enabled: true, botToken: bot.token, appToken: app.token, allowedUsers: new Set(settings.allowedUserIds), allowedChannels: new Set(settings.allowedChannels) };
}
