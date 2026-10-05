import assert from "node:assert/strict";
import test from "node:test";
import { TelegramBridge } from "../src/bridge.ts";
import { JsonLines } from "../src/rpc.ts";
import { isPrivateUserMessage, textChunks, telegramApi, validPairing } from "../src/telegram.ts";
import { code, message, now, pairingState, recordingApi, stubRpc } from "./helpers.ts";

const owner = () => ({ allowedUserId: 42, chatId: 42 });

test("accepts only private non-bot senders whose chat and user IDs match", () => {
	assert.equal(isPrivateUserMessage(message()), true);
	for (const invalid of [
		undefined,
		{ ...message(), chat: { id: 42, type: "group" } },
		{ ...message(), from: { id: 42, is_bot: true } },
		{ ...message(), chat: { id: 43, type: "private" } },
		{ ...message(), from: { id: "42" } },
	]) {
		assert.equal(isPrivateUserMessage(invalid), false);
	}
});

test("pairing requires the correct fresh unexpired challenge", () => {
	assert.equal(validPairing(message(`/pair ${code}`), pairingState(), now), true);
	assert.equal(validPairing(message("/start"), pairingState(), now), false);
	assert.equal(validPairing(message(`/pair ${"b".repeat(32)}`), pairingState(), now), false);
	assert.equal(validPairing(message(`/pair ${code}`), pairingState(), now + 60_000), false);
	assert.equal(validPairing({ ...message(`/pair ${code}`), date: 1 }, pairingState(), now), false);
	assert.equal(validPairing(message(`/pair ${code}`), { ...pairingState(), allowedUserId: 43 }, now), false);
});

test("long replies remain under Telegram limits without splitting surrogate pairs", () => {
	const text = "x".repeat(3999) + "😀".repeat(3000);
	const chunks = textChunks(text);
	assert.equal(chunks.join(""), text);
	assert.ok(chunks.every((chunk) => chunk.length <= 4000 && !/[\uD800-\uDBFF]$/.test(chunk)));
});

test("RPC framing handles fragmented JSON, CRLF and Unicode separators", () => {
	const records: unknown[] = [];
	const decoder = new JsonLines((record) => records.push(record));
	decoder.push('{"type":"x","text":"a b');
	decoder.push(' c"}\r\n{"type":"y"}\n');
	assert.deepEqual(records, [{ type: "x", text: "a b c" }, { type: "y" }]);
});

test("unauthorized users never reach Pi; pairing removes its challenge", async () => {
	const state: any = pairingState();
	const { api, sent } = recordingApi();
	const { rpc, calls } = stubRpc();
	const bridge = new TelegramBridge({ state, api, rpc, save: async () => {} });
	await bridge.handleUpdate({ message: message("run a command") });
	assert.equal(calls.length, 0);
	assert.equal(sent.length, 0);
	await bridge.handleUpdate({ message: message(`/pair ${code}`) });
	assert.equal(state.allowedUserId, 42);
	assert.equal(state.pairingHash, undefined);
	sent.length = 0;
	await bridge.handleUpdate({ message: message("run a command", 43) });
	assert.equal(calls.length, 0);
	assert.equal(sent.length, 0);
});

test("only final text is delivered, with no thinking or tool arguments", async () => {
	const { api, texts } = recordingApi();
	const bridge = new TelegramBridge({ state: {}, api, rpc: stubRpc().rpc, save: async () => {} });
	bridge.active = { chatId: 42 };
	bridge.onPiEvent({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Done." }, { type: "toolCall", arguments: "private" }] },
	});
	bridge.onPiEvent({ type: "agent_settled" });
	await bridge.delivery;
	assert.deepEqual(texts(), ["Done."]);
});

test("network errors containing token URLs are replaced by a fixed error", async () => {
	const token = `123456:${"secret".repeat(5)}`;
	const api = telegramApi(token, async () => {
		throw new Error(`https://api.telegram.org/bot${token}/getMe`);
	});
	await assert.rejects(api("getMe"), (error: Error) => !error.message.includes(token) && error.message === "Telegram request failed");
});

test("bot credentials are redacted from outbound text", async () => {
	const token = `123456:${"secret".repeat(5)}`;
	let body: any;
	const api = telegramApi(token, (async (_url: unknown, request: { body: string }) => {
		body = JSON.parse(request.body);
		return { json: async () => ({ ok: true, result: {} }) };
	}) as never);
	await api("sendMessage", { chat_id: 42, text: `Do not send ${token}` });
	assert.equal(body.text, "Do not send [redacted bot token]");
});

test("owner status and stop use control commands rather than model prompts", async () => {
	const { api, texts } = recordingApi();
	const { rpc, calls } = stubRpc();
	const bridge = new TelegramBridge({ state: owner(), api, rpc, save: async () => {} });
	await bridge.handleUpdate({ message: message("/status") });
	await bridge.handleUpdate({ message: message("/stop") });
	await bridge.handleUpdate({ message: message("/unknown") });
	assert.deepEqual(calls.map((c) => c.type), ["get_state", "clear_queue", "abort"]);
	assert.match(texts()[0]!, /Manager idle/);
	assert.equal(texts()[2], "Unknown command. Use /help.");
});

test("a busy agent receives no extra model prompt", async () => {
	const { rpc, calls } = stubRpc({ isStreaming: true });
	const bridge = new TelegramBridge({ state: owner(), api: recordingApi().api, rpc, save: async () => {} });
	await bridge.handleUpdate({ message: message("another task") });
	assert.deepEqual(calls.map((c) => c.type), ["get_state"]);
});

test("an idle agent gets the owner's text as a tagged prompt", async () => {
	const { rpc, calls } = stubRpc();
	const bridge = new TelegramBridge({ state: owner(), api: recordingApi().api, rpc, save: async () => {} });
	await bridge.handleUpdate({ message: message("which agents review code?") });
	clearInterval(bridge.typingTimer);
	assert.deepEqual(calls.map((c) => c.type), ["get_state", "prompt"]);
	assert.equal(calls[1]!.fields.message, "[telegram] which agents review code?");
});

test("workspace and help explain the fixed directory without starting a task", async () => {
	const { api, texts } = recordingApi();
	const rpc = { onEvent: () => {}, onTelemetryEvent: () => {}, command: async () => assert.fail("Workspace/help must not start a model request") };
	const bridge = new TelegramBridge({ state: owner(), api, rpc, save: async () => {} });
	await bridge.handleUpdate({ message: message("/workspace") });
	await bridge.handleUpdate({ message: message("/help") });
	assert.match(texts()[0]!, /Current workspace: \/workspace/);
	assert.match(texts()[0]!, /ordinary message/);
	assert.match(texts()[1]!, /Commands: \/agents, \/tasks, \/pending, \/approve/);
});
