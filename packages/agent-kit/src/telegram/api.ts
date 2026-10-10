export type TelegramApi = (method: string, payload?: Record<string, unknown>, signal?: AbortSignal) => Promise<any>;

/** What a chat is cut into: Telegram refuses messages of more than 4096 characters. */
export const TELEGRAM_CHUNK = 4000;

export function isPrivateUserMessage(message: any): boolean {
	return (
		message?.chat?.type === "private" &&
		!message.from?.is_bot &&
		Number.isSafeInteger(message.from?.id) &&
		message.from.id > 0 &&
		message.chat.id === message.from.id
	);
}

export function textChunks(text: string, maximum = TELEGRAM_CHUNK): string[] {
	const chunks: string[] = [];
	let chunk = "";
	for (const character of text) {
		if (chunk.length + character.length > maximum) {
			chunks.push(chunk);
			chunk = "";
		}
		chunk += character;
	}
	if (chunk) chunks.push(chunk);
	return chunks;
}

/** The Bot API over `fetch`. Errors never carry the URL (it contains the token) and outbound text is scrubbed of the token. */
export function telegramApi(token: string, fetchApi: typeof fetch = fetch): TelegramApi {
	return async (method, payload = {}, signal) => {
		if (method === "sendMessage" && typeof payload.text === "string") {
			payload = { ...payload, text: payload.text.replaceAll(token, "[redacted bot token]") };
		}
		let data: any;
		try {
			const response = await fetchApi(`https://api.telegram.org/bot${token}/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
			});
			data = await response.json();
		} catch {
			throw new Error("Telegram request failed");
		}
		if (!data.ok) throw new Error(`Telegram API error ${Number.isInteger(data.error_code) ? data.error_code : "unknown"}`);
		return data.result;
	};
}

export type ParsedUpdate =
	| { kind: "text"; updateId: number; userId: number; chatId: number; text: string; sentAt: string }
	| { kind: "unsupported"; updateId: number; chatId: number }
	| { kind: "ignored"; updateId: number; reason: "not_a_message" | "not_private" | "bot" | "not_allowed" };

/**
 * One update from `getUpdates`, sorted into what the channel does with it. Only a private chat with an allowed person is ever served;
 * everything else is ignored without an answer, so the bot does not tell strangers that it is there. Undefined: not an update at all.
 */
export function parseUpdate(update: any, allowed: ReadonlySet<number>, maxChars = 4000): ParsedUpdate | undefined {
	const updateId = update?.update_id;
	if (!Number.isSafeInteger(updateId)) return undefined;
	const message = update.message;
	if (!message || typeof message !== "object") return { kind: "ignored", updateId, reason: "not_a_message" };
	if (message.from?.is_bot) return { kind: "ignored", updateId, reason: "bot" };
	if (!isPrivateUserMessage(message)) return { kind: "ignored", updateId, reason: "not_private" };
	const userId: number = message.from.id;
	if (!allowed.has(userId)) return { kind: "ignored", updateId, reason: "not_allowed" };
	const text = typeof message.text === "string" ? message.text.trim() : "";
	if (text === "") return { kind: "unsupported", updateId, chatId: message.chat.id };
	const seconds = Number.isFinite(message.date) ? message.date * 1000 : Date.now();
	return { kind: "text", updateId, userId, chatId: message.chat.id, text: text.slice(0, maxChars), sentAt: new Date(seconds).toISOString() };
}
