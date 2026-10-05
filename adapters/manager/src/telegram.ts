import { createHash, timingSafeEqual } from "node:crypto";
import type { ManagerState } from "./state.ts";

export type TelegramApi = (method: string, payload?: Record<string, unknown>, signal?: AbortSignal) => Promise<any>;

export function isPrivateUserMessage(message: any): boolean {
	return (
		message?.chat?.type === "private" &&
		!message.from?.is_bot &&
		Number.isSafeInteger(message.from?.id) &&
		message.from.id > 0 &&
		message.chat.id === message.from.id
	);
}

export function validPairing(message: any, state: ManagerState, now = Date.now()): boolean {
	if (!isPrivateUserMessage(message) || state.allowedUserId || !state.pairingHash || now >= (state.pairingExpiresAt ?? 0)) return false;
	const match = /^\/pair ([a-f0-9]{32})$/.exec(message.text?.trim() ?? "");
	if (!match || !Number.isFinite(message.date) || message.date * 1000 < (state.pairingCreatedAt ?? 0) - 5000) return false;
	const actual = createHash("sha256").update(match[1]!).digest();
	const expected = Buffer.from(state.pairingHash, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function textChunks(text: string, maximum = 4000): string[] {
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
