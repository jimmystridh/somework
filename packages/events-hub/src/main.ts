import { readFileSync } from "node:fs";
import { createHub } from "./bootstrap.ts";
import { jsonLogger } from "./log.ts";
import { createHubServer } from "./server.ts";

async function main(): Promise<void> {
	const log = jsonLogger();
	const { hub, store, secret } = createHub(process.env, log);
	const server = createHubServer(hub, store, secret);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(Number(process.env.LISTEN_PORT ?? 8090), process.env.LISTEN_HOST ?? "0.0.0.0", resolve);
	});
	const tlsServer = process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE
		? createHubServer(hub, store, secret, { cert: readFileSync(process.env.TLS_CERT_FILE), key: readFileSync(process.env.TLS_KEY_FILE) })
		: undefined;
	if (tlsServer) {
		await new Promise<void>((resolve, reject) => {
			tlsServer.once("error", reject);
			tlsServer.listen(Number(process.env.TLS_PORT ?? 8091), process.env.LISTEN_HOST ?? "0.0.0.0", resolve);
		});
	}
	hub.start();

	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		log("info", "hub_stopping", {});
		for (const listener of [server, tlsServer]) {
			listener?.close();
			listener?.closeAllConnections();
		}
		await hub.stop();
		store.close();
		process.exit(0);
	};
	process.on("SIGTERM", () => void stop());
	process.on("SIGINT", () => void stop());
}

main().catch((error) => {
	process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "hub_failed", error: String(error?.message ?? error) })}\n`);
	process.exit(1);
});
