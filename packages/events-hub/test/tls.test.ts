import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Agent, request } from "node:https";
import { adminToken } from "../src/derive.ts";
import { createHubServer } from "../src/server.ts";
import { removeDir, SECRET, startWorld, tempDir, type World } from "./support.ts";

const worlds: World[] = [];
afterEach(async () => {
	while (worlds.length) {
		const w = worlds.pop()!;
		await w.hub.stop().catch(() => {});
		await w.stop();
	}
});

const get = (port: number, path: string, ca: Buffer, authorization?: string): Promise<{ status: number; body: string }> =>
	new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, ca, agent: new Agent({ keepAlive: false }), servername: "localhost", headers: authorization ? { authorization } : {} }, (res) => {
			let body = "";
			res.on("data", (chunk) => (body += chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
		});
		req.on("error", reject);
		req.end();
	});

describe("TLS listener", () => {
	it("serves the same endpoints over TLS and rejects plain clients", async () => {
		const dir = tempDir("hub-tls-");
		try {
			execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
			const cert = readFileSync(join(dir, "c.pem"));
			const w = await startWorld();
			worlds.push(w);
			const server = createHubServer(w.hub, w.store, SECRET, { cert, key: readFileSync(join(dir, "k.pem")) });
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const port = (server.address() as AddressInfo).port;
			assert.equal((await get(port, "/healthz", cert)).status, 200);
			assert.equal((await get(port, "/admin/stats", cert)).status, 401);
			assert.equal((await get(port, "/admin/stats", cert, `Bearer ${adminToken(SECRET)}`)).status, 200);
			await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
			await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
		} finally {
			removeDir(dir);
		}
	});
});
