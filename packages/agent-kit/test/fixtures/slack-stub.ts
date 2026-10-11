import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Preloaded into a service process (`--import`) so that the Slack channel can be tried end to end without Slack: the two Slack calls are
 * answered here and every call is written to `calls.jsonl`; the "socket" reads envelopes from `inbound.jsonl` (the test appends to it) and
 * writes what the channel sends (the acknowledgements) to `acks.jsonl`. Everything else goes to the network as usual.
 */
const dir = process.env.SLACK_STUB_DIR!;
const realFetch = globalThis.fetch;
const API = "https://slack.com/api/";

globalThis.fetch = (async (input: any, init?: any) => {
	const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
	if (!url.startsWith(API)) return realFetch(input, init);
	const method = url.slice(API.length);
	const body = typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : undefined;
	appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify({ method, authorization: init?.headers?.authorization, body })}\n`);
	return Response.json(method === "apps.connections.open" ? { ok: true, url: "wss://stub.invalid/socket" } : { ok: true, ts: "1.1" });
}) as typeof fetch;

class StubSocket extends EventTarget {
	readonly #timer: ReturnType<typeof setInterval>;

	constructor(_url: string) {
		super();
		let read = 0;
		setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "hello" }) })), 20);
		this.#timer = setInterval(() => {
			const file = join(dir, "inbound.jsonl");
			if (!existsSync(file)) return;
			const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
			for (const line of lines.slice(read)) this.dispatchEvent(new MessageEvent("message", { data: line }));
			read = lines.length;
		}, 40);
	}

	send(data: string): void {
		appendFileSync(join(dir, "acks.jsonl"), `${data}\n`);
	}

	close(): void {
		clearInterval(this.#timer);
	}
}

globalThis.WebSocket = StubSocket as unknown as typeof WebSocket;
