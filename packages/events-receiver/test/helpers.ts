import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type ReceiverConfig } from "../src/config.ts";
import { hookToken, pullToken } from "../src/derive.ts";
import { Queue } from "../src/queue.ts";
import { Receiver } from "../src/receiver.ts";

export const SECRET = "test-hub-secret-0123456789abcdef0123456789";

export interface Harness {
	receiver: Receiver;
	queue: Queue;
	dir: string;
	publicUrl: string;
	privateUrl: string;
	logs: string[];
	clock: { now: number };
	hook(source: string, version?: number, rest?: string): string;
	pull(after?: number, wait?: number): Promise<{ items: any[] }>;
	ack(upTo: number): Promise<Response>;
	authorized(): Record<string, string>;
	stop(): Promise<void>;
}

export interface HarnessOptions {
	config?: Record<string, unknown>;
	dir?: string;
}

const defaultConfig = { sources: [{ name: "github", version: 1, verify: "github-hmac" }, { name: "jira", version: 1 }, { name: "datadog", version: 2 }, { name: "woodpecker", version: 1, path: "/api/hook" }] };

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
	const dir = options.dir ?? mkdtempSync(join(tmpdir(), "receiver-"));
	const clock = { now: Date.parse("2026-10-05T12:00:00Z") };
	const logs: string[] = [];
	const config: ReceiverConfig = parseConfig({ ...defaultConfig, ...(options.config ?? {}) });
	const queue = new Queue(join(dir, "queue.sqlite"), () => clock.now);
	const receiver = new Receiver({ config, secret: SECRET, queue, now: () => clock.now, log: (level, event, fields) => logs.push(JSON.stringify({ level, event, ...fields })) });
	const publicServer = receiver.publicServer();
	const privateServer = receiver.privateServer();
	await Promise.all([new Promise<void>((r) => publicServer.listen(0, "127.0.0.1", r)), new Promise<void>((r) => privateServer.listen(0, "127.0.0.1", r))]);
	const publicUrl = `http://127.0.0.1:${(publicServer.address() as AddressInfo).port}`;
	const privateUrl = `http://127.0.0.1:${(privateServer.address() as AddressInfo).port}`;
	const authorized = () => ({ authorization: `Bearer ${pullToken(SECRET)}` });
	return {
		receiver,
		queue,
		dir,
		publicUrl,
		privateUrl,
		logs,
		clock,
		hook: (source, version, rest = "") => `${publicUrl}/hook/${source}/${hookToken(SECRET, source, version ?? config.sources.find((s) => s.name === source)?.version ?? 1)}${rest}`,
		pull: async (after = 0, wait = 0) => (await fetch(`${privateUrl}/v1/pull?after=${after}&wait=${wait}`, { headers: authorized() })).json() as Promise<{ items: any[] }>,
		ack: (upTo) => fetch(`${privateUrl}/v1/ack`, { method: "POST", headers: { ...authorized(), "content-type": "application/json" }, body: JSON.stringify({ upTo }) }),
		authorized,
		stop: async () => {
			publicServer.closeAllConnections();
			privateServer.closeAllConnections();
			await Promise.all([new Promise((r) => publicServer.close(r)), new Promise((r) => privateServer.close(r))]);
			queue.close();
			if (!options.dir) rmSync(dir, { recursive: true, force: true });
		},
	};
}
