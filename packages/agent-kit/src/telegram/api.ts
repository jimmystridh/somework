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
		if ((method === "sendMessage" || method === "editMessageText") && typeof payload.text === "string") {
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

/** What an Approve or Deny button carries back: the decision and the question's id (Telegram allows 64 bytes). */
export const approvalButtonData = (id: string, approved: boolean): string => `${approved ? "approve" : "deny"}:${id}`;

/** The decision a button carries, or undefined for anything that is not one of ours. */
export function parseApprovalButton(data: unknown): { id: string; approved: boolean } | undefined {
	const match = typeof data === "string" ? /^(approve|deny):([0-9a-f]{12})$/.exec(data) : null;
	return match ? { id: match[2]!, approved: match[1] === "approve" } : undefined;
}

/** A picture Telegram holds for a message: a photo (we ask for the largest size within the limit) or an image sent as a file. */
export interface TelegramImage {
	fileId: string;
	mimeType: string;
}

export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
/** The biggest picture the channel downloads (the model's own limit for an image is lower still; it scales larger ones down). */
export const MAX_IMAGE_BYTES = 8_000_000;

/** The pictures of a message: the largest size of a photo that is within the limit, and a document that is an image. */
export function imagesOf(message: any): TelegramImage[] {
	const images: TelegramImage[] = [];
	const sizes = Array.isArray(message?.photo) ? message.photo.filter((size: any) => typeof size?.file_id === "string" && (!Number.isFinite(size.file_size) || size.file_size <= MAX_IMAGE_BYTES)) : [];
	const best = sizes.sort((a: any, b: any) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0];
	if (best) images.push({ fileId: best.file_id, mimeType: "image/jpeg" });
	const document = message?.document;
	if (document && typeof document.file_id === "string" && IMAGE_MIME_TYPES.includes(String(document.mime_type)) && (!Number.isFinite(document.file_size) || document.file_size <= MAX_IMAGE_BYTES)) images.push({ fileId: document.file_id, mimeType: String(document.mime_type) });
	return images;
}

/** Downloads a file Telegram holds: `getFile` for its path, then the file. Errors never carry the address (it contains the token). */
export type TelegramFiles = (fileId: string, maxBytes?: number) => Promise<Buffer>;

export function telegramFiles(token: string, api: TelegramApi, fetchApi: typeof fetch = fetch): TelegramFiles {
	return async (fileId, maxBytes = MAX_IMAGE_BYTES) => {
		const file = await api("getFile", { file_id: fileId });
		if (typeof file?.file_path !== "string" || !/^[\w./-]{1,200}$/.test(file.file_path) || file.file_path.includes("..")) throw new Error("Telegram gave no usable file path");
		if (Number.isFinite(file.file_size) && file.file_size > maxBytes) throw new Error("the file is too large");
		let bytes: Buffer;
		try {
			const response = await fetchApi(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(45_000) });
			if (!response.ok) throw new Error("status");
			bytes = Buffer.from(await response.arrayBuffer());
		} catch {
			throw new Error("Telegram file download failed");
		}
		if (bytes.length === 0 || bytes.length > maxBytes) throw new Error("the file is empty or too large");
		return bytes;
	};
}

export type ParsedUpdate =
	| { kind: "callback"; updateId: number; userId: number; chatId: number; queryId: string; data: string; messageId: number | undefined; text: string }
	| { kind: "text"; updateId: number; userId: number; chatId: number; text: string; sentAt: string; images: TelegramImage[] }
	| { kind: "unsupported"; updateId: number; chatId: number }
	| { kind: "ignored"; updateId: number; reason: "not_a_message" | "not_private" | "bot" | "not_allowed" };

/**
 * One update from `getUpdates`, sorted into what the channel does with it. Only a private chat with an allowed person is ever served;
 * everything else is ignored without an answer, so the bot does not tell strangers that it is there. Undefined: not an update at all.
 */
export function parseUpdate(update: any, allowed: ReadonlySet<number>, maxChars = 4000): ParsedUpdate | undefined {
	const updateId = update?.update_id;
	if (!Number.isSafeInteger(updateId)) return undefined;
	if (update.callback_query && typeof update.callback_query === "object") return parseCallback(updateId, update.callback_query, allowed);
	const message = update.message;
	if (!message || typeof message !== "object") return { kind: "ignored", updateId, reason: "not_a_message" };
	if (message.from?.is_bot) return { kind: "ignored", updateId, reason: "bot" };
	if (!isPrivateUserMessage(message)) return { kind: "ignored", updateId, reason: "not_private" };
	const userId: number = message.from.id;
	if (!allowed.has(userId)) return { kind: "ignored", updateId, reason: "not_allowed" };
	const images = imagesOf(message);
	const text = (typeof message.text === "string" ? message.text : typeof message.caption === "string" ? message.caption : "").trim();
	if (text === "" && images.length === 0) return { kind: "unsupported", updateId, chatId: message.chat.id };
	const seconds = Number.isFinite(message.date) ? message.date * 1000 : Date.now();
	return { kind: "text", updateId, userId, chatId: message.chat.id, text: text.slice(0, maxChars), sentAt: new Date(seconds).toISOString(), images };
}

/** A button press: served only from a private chat with an allowed person, like a message. */
function parseCallback(updateId: number, query: any, allowed: ReadonlySet<number>): ParsedUpdate {
	const message = query.message;
	if (query.from?.is_bot) return { kind: "ignored", updateId, reason: "bot" };
	if (!message || !isPrivateUserMessage({ ...message, from: query.from })) return { kind: "ignored", updateId, reason: "not_private" };
	if (!allowed.has(query.from.id)) return { kind: "ignored", updateId, reason: "not_allowed" };
	if (typeof query.id !== "string" || typeof query.data !== "string") return { kind: "ignored", updateId, reason: "not_a_message" };
	return { kind: "callback", updateId, userId: query.from.id, chatId: message.chat.id, queryId: query.id, data: query.data, messageId: Number.isSafeInteger(message.message_id) ? message.message_id : undefined, text: typeof message.text === "string" ? message.text : "" };
}
