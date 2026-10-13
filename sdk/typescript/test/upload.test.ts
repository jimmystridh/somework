import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { SomeWorkClient } from "../src/client.ts";
import { Identity } from "../src/identity.ts";

const keyFile = { kind: "service", id: "agent/qa", domainId: "development", privateKey: Buffer.alloc(32, 9).toString("base64url"), publicKey: "" };

let server: Server;
let baseUrl: string;
let puts = 0;
let putAnswer: (attempt: number, respond: { reset: () => void; status: (code: number) => void }) => void = () => {};

before(async () => {
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			if (req.method === "PUT") {
				puts += 1;
				return putAnswer(puts, { reset: () => req.socket.destroy(), status: (code) => void res.writeHead(code, { etag: '"e1"' }).end() });
			}
			const body = req.url === "/v1/artifacts/uploads" ? { artifactId: "art_1", version: 1, url: `${baseUrl}/object/art_1` } : { artifactId: "art_1", uri: "artifact://art_1", traceId: "t" };
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());

const client = () => new SomeWorkClient({ baseUrl, identity: new Identity(keyFile), retries: 2 });
const upload = () => client().uploadArtifact({ filename: "video.webm", mediaType: "video/webm", bytes: "some bytes" });

describe("uploadArtifact", () => {
	it("puts the bytes again when the connection resets", async () => {
		puts = 0;
		putAnswer = (attempt, respond) => (attempt === 1 ? respond.reset() : respond.status(200));
		assert.equal((await upload()).artifactId, "art_1");
		assert.equal(puts, 2);
	});

	it("puts the bytes again when the object store answers 503, and gives up after the retries", async () => {
		puts = 0;
		putAnswer = (attempt, respond) => respond.status(attempt === 1 ? 503 : 200);
		await upload();
		assert.equal(puts, 2);
		puts = 0;
		putAnswer = (_attempt, respond) => respond.status(503);
		await assert.rejects(upload(), /object upload failed: 503/);
		assert.equal(puts, 3, "the first try and two retries");
	});

	it("does not repeat an upload the store refused for good", async () => {
		puts = 0;
		putAnswer = (_attempt, respond) => respond.status(403);
		await assert.rejects(upload(), /object upload failed: 403/);
		assert.equal(puts, 1);
	});
});
