import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { loadConfig } from "./config.ts";
import { checkSecret } from "./derive.ts";
import { jsonLogger } from "./log.ts";
import { Queue } from "./queue.ts";
import { Receiver } from "./receiver.ts";

const env = (name: string, fallback?: string): string => {
	const value = process.env[name] ?? fallback;
	if (value === undefined || value === "") throw new Error(`${name} is required`);
	return value;
};

const listen = (server: Server, host: string, port: number): Promise<void> => new Promise((resolve, reject) => {
	server.once("error", reject);
	server.listen(port, host, resolve);
});

async function main(): Promise<void> {
	const log = jsonLogger();
	const config = loadConfig(env("RECEIVER_CONFIG", "/etc/receiver/receiver.config.json"));
	const secret = checkSecret(readFileSync(env("HUB_SECRET_FILE"), "utf8"));
	const queue = new Queue(env("QUEUE_PATH", "/data/queue.sqlite"));
	const receiver = new Receiver({ config, secret, queue, log });

	const tlsCert = process.env.PRIVATE_TLS_CERT;
	const tlsKey = process.env.PRIVATE_TLS_KEY;
	if (!tlsCert || !tlsKey) log("warn", "private_listener_plain", { reason: "PRIVATE_TLS_CERT and PRIVATE_TLS_KEY are not set; use this only on a trusted test network" });
	const clientCa = process.env.PRIVATE_CLIENT_CA;
	const publicServer = receiver.publicServer();
	const privateServer = receiver.privateServer(tlsCert && tlsKey ? { cert: readFileSync(tlsCert), key: readFileSync(tlsKey), ...(clientCa ? { ca: readFileSync(clientCa), requestCert: true, rejectUnauthorized: true } : {}) } : undefined);
	await listen(publicServer, env("PUBLIC_HOST", "0.0.0.0"), Number(env("PUBLIC_PORT", "8080")));
	await listen(privateServer, env("PRIVATE_HOST"), Number(env("PRIVATE_PORT", "8443")));
	log("info", "receiver_started", { sources: config.sources.length, retentionHours: config.retentionHours });

	const purge = () => {
		const removed = queue.purge(config.retentionHours * 3_600_000);
		if (removed > 0) log("info", "queue_purged", { removed });
	};
	purge();
	const purgeTimer = setInterval(purge, 600_000);

	let stopping = false;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		log("info", "receiver_stopping", {});
		clearInterval(purgeTimer);
		publicServer.close();
		privateServer.close();
		publicServer.closeAllConnections();
		privateServer.closeAllConnections();
		queue.close();
		process.exit(0);
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}

main().catch((error) => {
	process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "receiver_failed", error: String(error?.message ?? error) })}\n`);
	process.exit(1);
});
