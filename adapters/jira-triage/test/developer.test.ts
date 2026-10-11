import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { developerOverDomain } from "../src/developer.ts";

function domain(messages: any[] = []) {
	const posts: { path: string; body: any; options: any }[] = [];
	const client = {
		async post(path: string, body: unknown, options?: unknown) {
			posts.push({ path, body, options });
			return { messageId: "msg_1", conversationId: "conv_1" };
		},
		async conversationMessages(_id: string, _limit?: number) {
			return { messages };
		},
	};
	return { client, posts };
}

const record = (over: Record<string, unknown>) => ({ type: "chat.message", sender: { kind: "agent", id: "agent/pi-agent" }, content: { mediaType: "text/plain", data: "An answer" }, createdAt: "2026-10-11T09:05:00.000Z", ...over });

describe("the developer agent over the domain", () => {
	it("is asked with a plain message to that agent only, directed, labelled with the ticket, and once per key", async () => {
		const { client, posts } = domain();
		const developer = developerOverDomain(client as never, "agent/pi-agent");
		const sent = await developer.ask({ ticket: "SAD-7", key: "SAD-7:1:0", text: "Read-only investigation request ..." });
		assert.equal(sent.conversationId, "conv_1");
		assert.equal(sent.messageId, "msg_1");
		assert.ok(Date.parse(sent.sentAt) > 0);
		const post = posts[0]!;
		assert.equal(post.path, "/v1/messages");
		assert.equal(post.body.type, "chat.message");
		assert.deepEqual(post.body.recipients, [{ kind: "agent", id: "agent/pi-agent" }]);
		assert.equal(post.body.triggerMode, "directed");
		assert.equal(post.body.labels.jiraTriage, "SAD-7");
		assert.equal(post.body.content.data, "Read-only investigation request ...");
		assert.equal(post.options.idempotencyKey, "jira-triage:developer:SAD-7:1:0");
		assert.equal(post.body.artifacts, undefined, "nothing but text goes to the developer");
		assert.equal(Object.keys(post.body).includes("repository"), false);
	});

	it("fails when the domain does not say which conversation it went to", async () => {
		const developer = developerOverDomain({ post: async () => ({}), conversationMessages: async () => ({ messages: [] }) } as never, "agent/pi-agent");
		await assert.rejects(developer.ask({ ticket: "SAD-7", key: "k", text: "x" }), /did not say which conversation/);
	});

	const asked = { conversationId: "conv_1", messageId: "msg_1", sentAt: "2026-10-11T09:00:00.000Z", ticket: "SAD-7" };

	it("reads the answer to its own request, by the id the developer replied to: not an earlier message, not another sender, not a busy notice", async () => {
		const { client } = domain([
			record({ createdAt: "2026-10-11T08:00:00.000Z", replyTo: "msg_0", content: { mediaType: "text/plain", data: "An old message" } }),
			record({ sender: { kind: "agent", id: "agent/someone-else" }, replyTo: "msg_1", content: { mediaType: "text/plain", data: "Not the developer" } }),
			record({ labels: { chatNotice: "busy" }, replyTo: "msg_1", content: { mediaType: "text/plain", data: "I am in 4 conversations" } }),
			record({ labels: { autoReply: "true" }, replyTo: "msg_1", content: { mediaType: "text/plain", data: "automatic notice" } }),
			record({ type: "chat.notice", replyTo: "msg_1", content: { mediaType: "text/plain", data: "a notice" } }),
			record({ createdAt: "2026-10-11T09:07:00.000Z", replyTo: "msg_1", content: { mediaType: "text/plain", data: "The later message" } }),
			record({ createdAt: "2026-10-11T09:06:00.000Z", replyTo: "msg_1", content: { mediaType: "text/plain", data: "The real answer\nFINDING reproduction-steps: Open it." } }),
		]);
		const answer = await developerOverDomain(client as never, "agent/pi-agent").answer(asked);
		assert.match(answer?.text ?? "", /^The real answer/);
		assert.equal(answer?.at, "2026-10-11T09:06:00.000Z");
	});

	it("shares its conversation with the developer between tickets, and takes only the answer to its own: another ticket's answer is not its", async () => {
		const { client } = domain([
			record({ createdAt: "2026-10-11T09:01:00.000Z", replyTo: "msg_OTHER", content: { mediaType: "text/plain", data: "About SAD-8: it is in the export" } }),
			record({ createdAt: "2026-10-11T09:02:00.000Z", replyTo: "msg_1", content: { mediaType: "text/plain", data: "About SAD-7: it is in the posting module" } }),
		]);
		assert.match((await developerOverDomain(client as never, "agent/pi-agent").answer(asked))?.text ?? "", /SAD-7/);
		assert.equal(await developerOverDomain(domain([record({ createdAt: "2026-10-11T09:01:00.000Z", replyTo: "msg_OTHER", content: { mediaType: "text/plain", data: "About SAD-8" } })]).client as never, "agent/pi-agent").answer(asked), undefined);
	});

	it("takes an answer that names no request when it mentions the ticket and came after the request, within a few seconds of clock skew", async () => {
		const mention = domain([record({ createdAt: "2026-10-11T08:59:57.000Z", content: { mediaType: "text/plain", data: "Looked at SAD-7: the posting module" } })]);
		assert.match((await developerOverDomain(mention.client as never, "agent/pi-agent").answer(asked))?.text ?? "", /posting module/);
		const early = domain([record({ createdAt: "2026-10-11T08:00:00.000Z", content: { mediaType: "text/plain", data: "Looked at SAD-7 long ago" } })]);
		assert.equal(await developerOverDomain(early.client as never, "agent/pi-agent").answer(asked), undefined);
		const silent = domain([record({ createdAt: "2026-10-11T09:05:00.000Z", content: { mediaType: "text/plain", data: "Something about nothing" } })]);
		assert.equal(await developerOverDomain(silent.client as never, "agent/pi-agent").answer(asked), undefined);
	});

	it("has no answer yet when there is none, and cuts a very long one", async () => {
		const none = domain([record({ createdAt: "2026-10-11T08:00:00.000Z" })]);
		assert.equal(await developerOverDomain(none.client as never, "agent/pi-agent").answer(asked), undefined);
		const long = domain([record({ replyTo: "msg_1", content: { mediaType: "text/plain", data: "x".repeat(20_000) } })]);
		assert.equal((await developerOverDomain(long.client as never, "agent/pi-agent").answer(asked))?.text.length, 8000);
	});
});
