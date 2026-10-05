import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { SomeWorkClient } from "../src/client.ts";
import { Identity } from "../src/identity.ts";
import { repoRoot } from "./harness.ts";

const identity = new Identity({ kind: "agent", id: "agent/t", domainId: "development", privateKey: Buffer.alloc(32, 3).toString("base64url"), publicKey: "" });
let dir: string;
let good: Server;
let wrongName: Server;
let goodPort: number;
let wrongNamePort: number;

const serve = (certName: string): Promise<{ server: Server; port: number }> =>
	new Promise((resolve) => {
		const server = createServer({ cert: readFileSync(join(dir, `${certName}.pem`)), key: readFileSync(join(dir, `${certName}.key`)) }, (_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end('{"status":"ok"}');
		});
		server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
	});

before(async () => {
	dir = mkdtempSync(join(tmpdir(), "somework-sdk-tls-"));
	const script = join(repoRoot, "deploy/scripts/make-private-ca.sh");
	const made = spawnSync(script, [dir, "good=127.0.0.1", "elsewhere=10.9.9.9"], { encoding: "utf8" });
	assert.equal(made.status, 0, made.stderr);
	({ server: good, port: goodPort } = await serve("good"));
	({ server: wrongName, port: wrongNamePort } = await serve("elsewhere"));
});
after(() => {
	good.close();
	wrongName.close();
});

const client = (port: number, caFile?: string) => new SomeWorkClient({ baseUrl: `https://127.0.0.1:${port}`, identity, caFile, retries: 0 });

describe("TLS to the domain", () => {
	it("trusts the private CA and nothing else", async () => {
		assert.deepEqual(await client(goodPort, join(dir, "ca.pem")).get("/healthz"), { status: "ok" });
	});

	it("rejects a certificate the platform does not trust when no CA is configured", async () => {
		await assert.rejects(() => client(goodPort).get("/healthz"), /unavailable/);
	});

	it("rejects a certificate from another CA", async () => {
		const other = mkdtempSync(join(tmpdir(), "somework-sdk-other-ca-"));
		assert.equal(spawnSync(join(repoRoot, "deploy/scripts/make-private-ca.sh"), [other, "x=127.0.0.1"]).status, 0);
		await assert.rejects(() => client(goodPort, join(other, "ca.pem")).get("/healthz"), /unavailable/);
	});

	it("rejects a certificate issued for another name even from the trusted CA", async () => {
		await assert.rejects(() => client(wrongNamePort, join(dir, "ca.pem")).get("/healthz"), /unavailable/);
	});

	it("refuses plain http when TLS is required", () => {
		assert.throws(() => new SomeWorkClient({ baseUrl: "http://127.0.0.1:1", identity, requireTls: true }), /TLS is required/);
	});
});
