import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig as parseReceiverConfig } from "../../events-receiver/src/config.ts";
import { hookToken, pullToken } from "../../events-receiver/src/derive.ts";
import { Queue } from "../../events-receiver/src/queue.ts";
import { Receiver } from "../../events-receiver/src/receiver.ts";
import { parseConfig, type HubConfig } from "../src/config.ts";
import { HttpForwarder } from "../src/forwarder.ts";
import { Hub } from "../src/hub.ts";
import type { Log } from "../src/log.ts";
import { MappingEngine } from "../src/mapping.ts";
import { DomainPublisher } from "../src/publisher.ts";
import { ReceiverClient, type ReceiverApi } from "../src/receiver-client.ts";
import { Store } from "../src/store.ts";

export const SECRET = "integration-hub-secret-0123456789abcdef-0123456789";
export const MAPPINGS = join(dirname(fileURLToPath(import.meta.url)), "..", "mappings");

export const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
export const removeDir = (dir: string): void => rmSync(dir, { recursive: true, force: true });

export interface Producer {
	id: string;
	keyFile: string;
	publicKey: string;
}

export function makeProducer(dir: string, name: string): Producer {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const jwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
	const id = `producer/${name}`;
	const keyFile = join(dir, `${name}.key.json`);
	writeFileSync(keyFile, JSON.stringify({ kind: "service", id, domainId: "dom_test", privateKey: jwk.d, publicKey: jwk.x }));
	void publicKey;
	return { id, keyFile, publicKey: jwk.x };
}

export interface PublishCall {
	issuer: string;
	body: any;
	duplicate: boolean;
}

export type Behaviour = { status: number } | undefined;

/** A stand-in for POST /v1/events/publish: verifies the assertion signature, dedupes on (principal, key), and can be told to fail. */
export class FakeDomain {
	readonly calls: PublishCall[] = [];
	readonly events = new Map<string, number>();
	readonly #keys = new Map<string, string>();
	readonly #server: Server;
	failures: Behaviour[] = [];
	always: Behaviour;
	url = "";

	constructor() {
		this.#server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => {
				const answer = (status: number, body: unknown) => {
					res.writeHead(status, { "content-type": "application/json" });
					res.end(JSON.stringify(body));
				};
				const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
				const [head, claims, signature] = token.split(".");
				if (req.url !== "/v1/events/publish" || req.method !== "POST" || !head || !claims || !signature) return answer(404, { code: "not_found", message: "no" });
				const iss = JSON.parse(Buffer.from(claims, "base64url").toString()).iss as string;
				const publicKey = this.#keys.get(iss);
				if (!publicKey) return answer(401, { code: "unauthorized", message: "unknown principal" });
				const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
				if (!verify(null, Buffer.from(`${head}.${claims}`), key, Buffer.from(signature, "base64url"))) return answer(401, { code: "unauthorized", message: "bad signature" });
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				const forced = this.failures.shift() ?? this.always;
				if (forced) {
					this.calls.push({ issuer: iss, body, duplicate: false });
					return answer(forced.status, { code: forced.status === 400 ? "validation_failed" : "unavailable", message: `forced ${forced.status}` });
				}
				const id = `${iss}|${body.key}`;
				const duplicate = this.events.has(id);
				if (!duplicate) this.events.set(id, this.events.size + 1);
				this.calls.push({ issuer: iss, body, duplicate });
				answer(200, { seq: this.events.get(id), eventId: `evt_${this.events.get(id)}`, duplicate });
			});
		});
	}

	trust(producer: Producer): void {
		this.#keys.set(`service:${producer.id}`, producer.publicKey);
	}

	async start(): Promise<void> {
		await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
		this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
	}

	async stop(): Promise<void> {
		this.#server.closeAllConnections();
		await new Promise((resolve) => this.#server.close(resolve));
	}

	get uniqueEvents(): number {
		return this.events.size;
	}
}

export interface Edge {
	dir: string;
	queue: Queue;
	receiver: Receiver;
	publicUrl: string;
	privateUrl: string;
	hook(source: string, version?: number, rest?: string): string;
	stop(): Promise<void>;
}

export async function startEdge(dir: string, sources: object[] = [{ name: "github", version: 1 }, { name: "jira", version: 1 }, { name: "datadog", version: 1 }, { name: "woodpecker", version: 1, path: "/api/hook" }]): Promise<Edge> {
	const queue = new Queue(join(dir, "queue.sqlite"));
	const receiver = new Receiver({ config: parseReceiverConfig({ sources }), secret: SECRET, queue });
	const publicServer = receiver.publicServer();
	const privateServer = receiver.privateServer();
	await Promise.all([new Promise<void>((r) => publicServer.listen(0, "127.0.0.1", r)), new Promise<void>((r) => privateServer.listen(0, "127.0.0.1", r))]);
	const publicUrl = `http://127.0.0.1:${(publicServer.address() as AddressInfo).port}`;
	const privateUrl = `http://127.0.0.1:${(privateServer.address() as AddressInfo).port}`;
	return {
		dir,
		queue,
		receiver,
		publicUrl,
		privateUrl,
		hook: (source, version = 1, rest = "") => `${publicUrl}/hook/${source}/${hookToken(SECRET, source, version)}${rest}`,
		stop: async () => {
			publicServer.closeAllConnections();
			privateServer.closeAllConnections();
			await Promise.all([new Promise((r) => publicServer.close(r)), new Promise((r) => privateServer.close(r))]);
			queue.close();
		},
	};
}

export const pullBearer = (): string => `Bearer ${pullToken(SECRET)}`;

export interface World {
	dir: string;
	domain: FakeDomain;
	edge: Edge;
	producers: Record<string, Producer>;
	config: HubConfig;
	store: Store;
	hub: Hub;
	sleeps: number[];
	/** Builds another hub over the same store, edge and domain (a restart). */
	rebuild(options?: { receiver?: ReceiverApi }): Hub;
	stop(): Promise<void>;
}

export interface WorldOptions {
	sources?: object[];
	clock?: object;
	timers?: object;
	forwardUrl?: string;
	mappingsDir?: string;
	maxAttempts?: number;
	receiver?: (real: ReceiverApi) => ReceiverApi;
	now?: () => number;
	log?: Log;
}

export async function startWorld(options: WorldOptions = {}): Promise<World> {
	const dir = tempDir("hub-world-");
	const domain = new FakeDomain();
	await domain.start();
	const producers: Record<string, Producer> = {};
	for (const name of ["github", "jira", "datadog", "grafana", "clock", "boom"]) {
		producers[name] = makeProducer(dir, name);
		domain.trust(producers[name]!);
	}
	const edge = await startEdge(dir);
	const prod = (name: string) => ({ keyFile: producers[name]!.keyFile });
	const config = parseConfig({
		domain: { url: domain.url, requireTls: false },
		receiver: { url: edge.privateUrl, waitSeconds: 1 },
		mappingsDir: options.mappingsDir ?? MAPPINGS,
		storePath: join(dir, "hub.sqlite"),
		maxAttempts: options.maxAttempts ?? 4,
		sources: options.sources ?? [
			{ name: "github", version: 1, mapping: "github", producer: prod("github") },
			{ name: "jira", version: 1, mapping: "jira", producer: prod("jira") },
			{ name: "datadog", version: 1, mapping: "datadog", producer: prod("datadog") },
			{ name: "grafana", version: 1, internal: true, mapping: "grafana", producer: prod("grafana") },
			{ name: "woodpecker", version: 1, forward: { baseUrl: options.forwardUrl ?? "http://127.0.0.1:9" } },
		],
		clock: options.clock ?? { producer: prod("clock"), schedules: [] },
		...(options.timers ? { timers: options.timers } : {}),
	});
	const store = new Store(config.storePath);
	const sleeps: number[] = [];
	const keyFiles: Record<string, string> = { clock: producers.clock!.keyFile };
	for (const source of config.sources) if (source.producer) keyFiles[source.name] = source.producer.keyFile;
	const build = (overrides: { receiver?: ReceiverApi } = {}): Hub => {
		const real = new ReceiverClient({ url: edge.privateUrl }, SECRET);
		return new Hub({
			config,
			secret: SECRET,
			store,
			receiver: overrides.receiver ?? options.receiver?.(real) ?? real,
			publisher: new DomainPublisher({ domainUrl: domain.url, requireTls: false, keyFiles }),
			forwarder: new HttpForwarder(),
			mappings: new MappingEngine(config.mappingsDir),
			sleep: async (ms, signal) => {
				if (ms >= 15_000) {
					await new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));
					return;
				}
				sleeps.push(ms);
				await new Promise((resolve) => setTimeout(resolve, 1));
			},
			now: options.now,
			log: options.log,
		});
	};
	const world: World = {
		dir,
		domain,
		edge,
		producers,
		config,
		store,
		sleeps,
		hub: build(),
		rebuild: build,
		stop: async () => {
			await edge.stop();
			await domain.stop();
			store.close();
			removeDir(dir);
		},
	};
	return world;
}

export const waitFor = async (condition: () => boolean | Promise<boolean>, timeoutMs = 8000, label = "condition"): Promise<void> => {
	const started = Date.now();
	while (!(await condition())) {
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
};

export const githubPr = (delivery: string, action = "opened", number = 7) => ({
	headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": delivery, "x-hub-signature-256": "sha256=unused" },
	body: JSON.stringify({ action, number, pull_request: { number, title: "Fix rounding", html_url: "https://github.com/o/r/pull/7", state: "open", draft: false, merged: false, user: { login: "anna" }, base: { ref: "main", sha: "b" }, head: { ref: "fix", sha: "h" } }, repository: { full_name: "o/r", clone_url: "https://github.com/o/r.git", html_url: "https://github.com/o/r", default_branch: "main", private: true }, sender: { login: "anna" } }),
});

export const post = (url: string, init: { headers?: Record<string, string>; body: string | Uint8Array }) => fetch(url, { method: "POST", headers: init.headers, body: init.body });

export { mkdirSync };
