import { readFileSync } from "node:fs";

/** What the environment says about the Telegram channel; see `resolveTelegram` for whether it can start. */
export interface TelegramSettings {
	token?: string;
	tokenFile?: string;
	/** The raw `TELEGRAM_ALLOWED_USER_IDS` entries. */
	allowedUserIds: string[];
	messagesPerHour: number;
	pollSeconds: number;
}

export function telegramSettingsFrom(env: NodeJS.ProcessEnv): TelegramSettings {
	const whole = (name: string, fallback: number): number => {
		const raw = env[name];
		if (raw === undefined || raw === "") return fallback;
		const value = Number(raw);
		if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
		return value;
	};
	return {
		...(env.TELEGRAM_BOT_TOKEN ? { token: env.TELEGRAM_BOT_TOKEN.trim() } : {}),
		...(env.TELEGRAM_BOT_TOKEN_FILE ? { tokenFile: env.TELEGRAM_BOT_TOKEN_FILE } : {}),
		allowedUserIds: (env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(/[\s,]+/).filter(Boolean),
		messagesPerHour: whole("TELEGRAM_MESSAGES_PER_HOUR", 30),
		pollSeconds: whole("TELEGRAM_POLL_SECONDS", 30),
	};
}

export type TelegramStart = { enabled: false; reason?: string } | { enabled: true; token: string; allowed: ReadonlySet<number> };

/**
 * Whether the channel can start. No token is "not configured" (no reason, nothing to say). A token without a usable allow-list is a refusal
 * with a reason: a bot that anybody on Telegram can write to must never start by accident.
 */
export function resolveTelegram(settings: TelegramSettings, readFile: (path: string) => string = (path) => readFileSync(path, "utf8")): TelegramStart {
	if (!settings.token && !settings.tokenFile) return { enabled: false };
	let token = settings.token;
	if (!token && settings.tokenFile) {
		try {
			token = readFile(settings.tokenFile).trim();
		} catch {
			return { enabled: false, reason: "TELEGRAM_BOT_TOKEN_FILE could not be read" };
		}
	}
	if (!token) return { enabled: false, reason: "the Telegram bot token is empty" };
	if (settings.allowedUserIds.length === 0) return { enabled: false, reason: "TELEGRAM_ALLOWED_USER_IDS is required with a bot token: list the numeric Telegram user ids that may write to this agent" };
	const ids = settings.allowedUserIds.map((entry) => (/^[1-9][0-9]{0,14}$/.test(entry) ? Number(entry) : Number.NaN));
	if (ids.some((id) => !Number.isSafeInteger(id))) return { enabled: false, reason: "TELEGRAM_ALLOWED_USER_IDS must be numeric Telegram user ids separated by commas" };
	return { enabled: true, token, allowed: new Set(ids) };
}
