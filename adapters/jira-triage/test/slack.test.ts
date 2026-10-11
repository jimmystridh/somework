import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SlackError, slackWebApi } from "../src/slack.ts";

const BOT_TOKEN = "xoxb-1234-secret-token-value";

/** A stand-in for slack.com: the answers by method, and every request recorded (method, form fields, authorization). */
function fakeSlack(answers: Record<string, unknown | ((fields: Record<string, string>) => unknown)>) {
	const calls: { method: string; fields: Record<string, string>; authorization: string | undefined; contentType: string | undefined }[] = [];
	const fetchApi = (async (url: string, init: RequestInit) => {
		const method = new URL(url).pathname.split("/").at(-1)!;
		const fields = Object.fromEntries(new URLSearchParams(String(init.body)));
		const headers = init.headers as Record<string, string>;
		calls.push({ method, fields, authorization: headers.authorization, contentType: headers["content-type"] });
		const answer = answers[method];
		return { json: async () => (typeof answer === "function" ? (answer as (f: Record<string, string>) => unknown)(fields) : (answer ?? { ok: false, error: "unknown_method" })) } as Response;
	}) as unknown as typeof fetch;
	return { api: slackWebApi(BOT_TOKEN, fetchApi), calls };
}

describe("the Slack Web API", () => {
	it("sends every call as a form post with the bot token, which is what the read methods accept", async () => {
		const { api, calls } = fakeSlack({ "users.lookupByEmail": { ok: true, user: { id: "U0123ABCD" } } });
		await api.findUserByEmail("dana@example.test");
		assert.deepEqual(calls[0], { method: "users.lookupByEmail", fields: { email: "dana@example.test" }, authorization: `Bearer ${BOT_TOKEN}`, contentType: "application/x-www-form-urlencoded" });
	});

	it("finds a person by e-mail address, and says nothing found for an unknown address, a deleted account or a bot", async () => {
		assert.equal(await fakeSlack({ "users.lookupByEmail": { ok: true, user: { id: "U0123ABCD" } } }).api.findUserByEmail("a@b.test"), "U0123ABCD");
		assert.equal(await fakeSlack({ "users.lookupByEmail": { ok: false, error: "users_not_found" } }).api.findUserByEmail("a@b.test"), undefined);
		assert.equal(await fakeSlack({ "users.lookupByEmail": { ok: true, user: { id: "U0123ABCD", deleted: true } } }).api.findUserByEmail("a@b.test"), undefined);
		assert.equal(await fakeSlack({ "users.lookupByEmail": { ok: true, user: { id: "U0123ABCD", is_bot: true } } }).api.findUserByEmail("a@b.test"), undefined);
		assert.equal(await fakeSlack({ "users.lookupByEmail": { ok: true, user: { id: "not an id" } } }).api.findUserByEmail("a@b.test"), undefined);
	});

	it("lets a missing scope or any other failure through as an error with a short code, never a token", async () => {
		const { api } = fakeSlack({ "users.lookupByEmail": { ok: false, error: "missing_scope", needed: "users:read.email", detail: BOT_TOKEN } });
		await assert.rejects(api.findUserByEmail("a@b.test"), (error: Error) => error instanceof SlackError && error.code === "missing_scope" && !error.message.includes(BOT_TOKEN));
		const odd = fakeSlack({ "users.lookupByEmail": { ok: false, error: "Some Odd <Message>" } });
		await assert.rejects(odd.api.findUserByEmail("a@b.test"), (error: Error) => (error as SlackError).code === "unknown");
	});

	it("turns a network failure into an error without the address or the token", async () => {
		const api = slackWebApi(BOT_TOKEN, (async () => {
			throw new Error(`connect failed ${BOT_TOKEN}`);
		}) as unknown as typeof fetch);
		await assert.rejects(api.openDirectMessage("U0123ABCD"), (error: Error) => (error as SlackError).code === "request_failed" && !error.message.includes(BOT_TOKEN));
	});

	it("opens a direct message and returns the channel", async () => {
		const { api, calls } = fakeSlack({ "conversations.open": { ok: true, channel: { id: "D0123ABCD" } } });
		assert.equal(await api.openDirectMessage("U0123ABCD"), "D0123ABCD");
		assert.deepEqual(calls[0]!.fields, { users: "U0123ABCD" });
		await assert.rejects(fakeSlack({ "conversations.open": { ok: true, channel: {} } }).api.openDirectMessage("U0123ABCD"), /no_channel/);
	});

	it("posts plain text with no markup and no link previews, and returns the timestamp", async () => {
		const { api, calls } = fakeSlack({ "chat.postMessage": { ok: true, ts: "1760000000.000100" } });
		assert.deepEqual(await api.post("D0123ABCD", "Hello *world*"), { ts: "1760000000.000100" });
		assert.deepEqual(calls[0]!.fields, { channel: "D0123ABCD", text: "Hello *world*", mrkdwn: "false", unfurl_links: "false", unfurl_media: "false" });
		await assert.rejects(fakeSlack({ "chat.postMessage": { ok: true } }).api.post("D1", "x"), /no_timestamp/);
	});

	it("reads what one person wrote in a direct message after a point in time, oldest first, and nothing else", async () => {
		const { api, calls } = fakeSlack({
			"conversations.history": {
				ok: true,
				messages: [
					{ user: "U0123ABCD", text: "Second", ts: "1760000200.000100" },
					{ user: "U0123ABCD", text: "First", ts: "1760000100.000100" },
					{ user: "U9999ZZZZ", text: "Somebody else", ts: "1760000150.000100" },
					{ bot_id: "B1", user: "U0123ABCD", text: "A bot", ts: "1760000160.000100" },
					{ user: "U0123ABCD", subtype: "channel_join", text: "joined", ts: "1760000170.000100" },
					{ user: "U0123ABCD", text: "   ", ts: "1760000180.000100" },
					{ user: "U0123ABCD", text: "Earlier", ts: "1759999999.000100" },
					{ user: "U0123ABCD", text: "With a file", subtype: "file_share", ts: "1760000300.000100" },
				],
			},
		});
		const replies = await api.replies("D0123ABCD", "1760000000.000100", "U0123ABCD");
		assert.deepEqual(replies.map((reply) => reply.text), ["First", "Second", "With a file"]);
		assert.deepEqual(calls[0]!.fields, { channel: "D0123ABCD", oldest: "1760000000.000100", inclusive: "false", limit: "50" });
	});

	it("reads a display name, and says nothing when Slack does not give one", async () => {
		assert.equal(await fakeSlack({ "users.info": { ok: true, user: { profile: { display_name: "dana" }, real_name: "Dana Dev" } } }).api.displayName("U0123ABCD"), "dana");
		assert.equal(await fakeSlack({ "users.info": { ok: true, user: { profile: { display_name: "" }, real_name: "Dana Dev" } } }).api.displayName("U0123ABCD"), "Dana Dev");
		assert.equal(await fakeSlack({ "users.info": { ok: false, error: "missing_scope" } }).api.displayName("U0123ABCD"), undefined);
	});
});
