import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "../src/backoff.ts";
import { SomeWorkClient } from "../src/client.ts";
import { Identity } from "../src/identity.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../../..");
const binary = process.env.SOMEWORK_BIN ?? join(repoRoot, "dist/somework");

export async function freePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolvePort(port));
		});
		server.on("error", reject);
	});
}

const natsServerBinary = process.env.NATS_SERVER_BIN ?? join(repoRoot, "tools/bin/nats-server");

export interface Broker {
	url: string;
	port: number;
	stop(): Promise<void>;
	start(): Promise<void>;
}

export interface Domain {
	url: string;
	dir: string;
	/** Present when started with `nats: true`: a real nats-server configured the way a deployment is (`render-nats-conf`). */
	nats?: Broker;
	/** Every request that reached the domain through `worker()` / `author`, as `METHOD /path?query`. */
	requests: string[];
	worker: (options?: { retries?: number }) => SomeWorkClient;
	author: SomeWorkClient;
	/** Stops the domain process only. */
	stop(): Promise<void>;
	start(): Promise<void>;
	/** Stops everything this domain started. */
	close(): Promise<void>;
}

/** A real domain server in a temporary directory with one provider agent (`agent/ts-worker`, code.review) and one requester. */
export async function startDomain(options: { cardFile?: string; nats?: boolean } = {}): Promise<Domain> {
	const dir = mkdtempSync(join(tmpdir(), "somework-sdk-"));
	const port = await freePort();
	const url = `http://127.0.0.1:${port}`;
	const config = join(dir, "somework.toml");
	const natsPort = options.nats ? await freePort() : 0;
	const natsDir = join(dir, "nats");
	const natsUrl = `nats://127.0.0.1:${natsPort}`;
	const natsSection = options.nats
		? `[nats]\nurl = "${natsUrl}"\nuser = "somework-domain"\npassword = "domain-secret-for-tests"\nusers_file = "${natsDir}/users.conf"\nreload_command = ["sh", "-c", "kill -HUP $(cat ${natsDir}/nats.pid)"]\nreconcile_interval_ms = 200\nmetrics_interval_ms = 500\n`
		: "";
	const masterKey = options.nats ? `master_key = "${randomBytes(32).toString("base64url")}"\n` : "";
	writeFileSync(
		config,
		`[domain]\nid = "development"\ndb = "${dir}/somework.db"\nlisten = "127.0.0.1:${port}"\npublic_url = "${url}"\n${masterKey}synchronous_full = false\nmaintenance_interval_ms = 200\n[objects]\ndir = "${dir}/objects"\n${natsSection}`,
	);
	const admin = (...args: string[]) => {
		const out = spawnSync(binary, ["admin", "--config", config, ...args], { encoding: "utf8" });
		if (out.status !== 0) throw new Error(`somework admin ${args.join(" ")} failed: ${out.stderr}`);
	};
	admin("bootstrap", "--key-out", join(dir, "root.key.json"));
	admin("enroll-agent", "--id", "agent/ts-worker", "--side-effects", "write", "--key-out", join(dir, "worker.key.json"));
	admin("enroll-agent", "--id", "agent/ts-author", "--side-effects", "write", "--may-invoke", "code.*", "--key-out", join(dir, "author.key.json"));
	const card = JSON.parse(readFileSync(options.cardFile ?? join(repoRoot, "examples/reviewer-card.json"), "utf8"));
	card.agentId = "agent/ts-worker";
	writeFileSync(join(dir, "card.json"), JSON.stringify(card));
	admin("register-card", "--card", join(dir, "card.json"), "--approve");

	let broker: ChildProcess | undefined;
	let nats: Broker | undefined;
	if (options.nats) {
		mkdirSync(natsDir, { recursive: true });
		admin("render-nats-conf", "--out-dir", natsDir, "--host", "127.0.0.1", "--port", String(natsPort), "--store-dir", join(natsDir, "jetstream"), "--pid-file", join(natsDir, "nats.pid"));
		const startBroker = async () => {
			broker = spawn(natsServerBinary, ["-c", join(natsDir, "nats-server.conf")], { stdio: "ignore" });
			broker.unref();
			for (let i = 0; i < 100; i++) {
				if (await portOpen(natsPort)) return void (await sleep(300)); // JetStream finishes recovering shortly after the port opens
				await sleep(100);
			}
			throw new Error("nats-server did not start");
		};
		const stopBroker = async () => {
			const current = broker;
			broker = undefined;
			if (!current || current.exitCode !== null) return;
			current.kill("SIGKILL");
			await new Promise((done) => current.once("exit", done));
		};
		nats = { url: natsUrl, port: natsPort, start: startBroker, stop: stopBroker };
		await startBroker();
	}

	const requests: string[] = [];
	const proxy = await countingProxy(url, requests);

	let child: ChildProcess | undefined;
	const start = async () => {
		child = spawn(binary, ["serve", "--config", config], { stdio: "ignore" });
		for (let i = 0; i < 100; i++) {
			try {
				if ((await fetch(`${url}/healthz`)).ok) return;
			} catch {
				// not up yet
			}
			await sleep(100);
		}
		throw new Error("the domain did not become healthy");
	};
	const stop = async () => {
		const current = child;
		child = undefined;
		if (!current || current.exitCode !== null) return;
		current.kill("SIGKILL");
		await new Promise((done) => current.once("exit", done));
	};
	await start();
	return {
		url,
		dir,
		nats,
		requests,
		worker: (clientOptions = {}) => new SomeWorkClient({ baseUrl: proxy.url, identity: Identity.fromFile(join(dir, "worker.key.json")), retries: 0, ...clientOptions }),
		author: new SomeWorkClient({ baseUrl: url, identity: Identity.fromFile(join(dir, "author.key.json")) }),
		stop: async () => {
			await stop();
		},
		start,
		async close() {
			await stop();
			await nats?.stop();
			proxy.close();
		},
	};
}

async function portOpen(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ port, host: "127.0.0.1" }, () => {
			socket.destroy();
			resolve(true);
		});
		socket.on("error", () => resolve(false));
	});
}

/** Forwards to the domain and records every request line, so tests can assert what the SDK sends. */
async function countingProxy(target: string, requests: string[]): Promise<{ url: string; close(): void }> {
	const upstream = new URL(target);
	const server: Server = createHttpServer((incoming, outgoing) => {
		requests.push(`${incoming.method} ${incoming.url}`);
		const forwarded = httpRequest({ host: upstream.hostname, port: upstream.port, method: incoming.method, path: incoming.url, headers: incoming.headers }, (response) => {
			outgoing.writeHead(response.statusCode ?? 502, response.headers);
			response.pipe(outgoing);
		});
		forwarded.on("error", () => {
			outgoing.writeHead(502).end();
		});
		incoming.pipe(forwarded);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	server.unref(); // a test that only calls stop() must still let its process exit
	return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() };
}

export const review = (text = "echo hi") => ({ capability: { id: "code.review", version: "2" }, input: { text } });
export const approve = { type: "completed" as const, result: { verdict: "approve", summary: "ok", findings: [] } };
