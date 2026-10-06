import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { AikidoClient, AikidoError, API_BASES, OAUTH_URL, readCredentials } from "../src/aikido/client.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Fake {
	base: string;
	oauth: string;
	tokens: number;
	requests: { method: string; url: string; authorization?: string }[];
	routes: Map<string, { status: number; body: unknown; raw?: boolean }>;
	tokenStatus: number;
	expiresIn: number;
	issued: string[];
	reject401Once: boolean;
	redirectTo?: string;
}

async function fake(): Promise<Fake> {
	const state = { tokens: 0, requests: [] as Fake["requests"], routes: new Map(), tokenStatus: 200, expiresIn: 3600, issued: [] as string[], reject401Once: false } as Omit<Fake, "base" | "oauth">;
	const body = (request: IncomingMessage): Promise<string> => new Promise((resolve) => {
		let text = "";
		request.on("data", (chunk) => (text += chunk));
		request.on("end", () => resolve(text));
	});
	const server: Server = createServer(async (request, response) => {
		const text = await body(request);
		const authorization = request.headers.authorization;
		if (request.url === "/api/oauth/token") {
			state.tokens += 1;
			state.requests.push({ method: request.method!, url: request.url, authorization });
			assert.equal(JSON.parse(text).grant_type, "client_credentials");
			if (state.tokenStatus !== 200) return void response.writeHead(state.tokenStatus).end(JSON.stringify({ error: "invalid_client" }));
			const token = `tok-${state.tokens}`;
			state.issued.push(token);
			return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: token, expires_in: state.expiresIn }));
		}
		state.requests.push({ method: request.method!, url: request.url!, authorization });
		if ((state as Fake).redirectTo && request.url === "/api/public/v1/issues/groups/77") return void response.writeHead(302, { location: (state as Fake).redirectTo! }).end();
		if (state.reject401Once) {
			state.reject401Once = false;
			return void response.writeHead(401).end("{}");
		}
		const route = state.routes.get(request.url!);
		if (!route) return void response.writeHead(404).end("{}");
		response.writeHead(route.status, { "content-type": "application/json" }).end(route.raw ? String(route.body) : JSON.stringify(route.body));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const port = (server.address() as { port: number }).port;
	return Object.assign(state, { base: `http://127.0.0.1:${port}/api/public/v1`, oauth: `http://127.0.0.1:${port}/api/oauth/token` }) as Fake;
}

const client = (f: Fake, extra: Partial<ConstructorParameters<typeof AikidoClient>[0]> = {}) =>
	new AikidoClient({ credentials: { clientId: "client-id-1", clientSecret: "client-secret-value" }, apiBase: f.base, oauthUrl: f.oauth, ...extra });
const group = { id: 1, title: "t", severity: "high", type: "open_source" };

describe("Aikido client", () => {
	it("gets a token with client credentials over basic auth, then reads the issue group with it", async () => {
		const f = await fake();
		f.routes.set("/api/public/v1/issues/groups/1", { status: 200, body: group });
		const found = await client(f).resolveIssue(1);
		assert.deepEqual(found.group, group);
		assert.equal(f.requests[0]!.authorization, `Basic ${Buffer.from("client-id-1:client-secret-value").toString("base64")}`);
		assert.equal(f.requests[1]!.authorization, "Bearer tok-1");
		assert.equal(f.requests[1]!.method, "GET");
	});

	it("keeps the token in memory and reuses it, and asks again when it is about to expire", async () => {
		const f = await fake();
		f.routes.set("/api/public/v1/issues/groups/1", { status: 200, body: group });
		let clock = 1_000_000;
		const c = client(f, { now: () => clock });
		await c.resolveIssue(1);
		await c.resolveIssue("1");
		assert.equal(f.tokens, 1);
		clock += 3600_000 - 30_000;
		await c.resolveIssue(1);
		assert.equal(f.tokens, 2, "within the safety margin of the expiry");
	});

	it("shares one token request between calls made at the same time", async () => {
		const f = await fake();
		f.routes.set("/api/public/v1/issues/groups/1", { status: 200, body: group });
		const c = client(f);
		await Promise.all([c.resolveIssue(1), c.resolveIssue(1), c.resolveIssue(1)]);
		assert.equal(f.tokens, 1);
	});

	it("retries once with a fresh token when the API says 401, and gives up on the second", async () => {
		const f = await fake();
		f.routes.set("/api/public/v1/issues/groups/1", { status: 200, body: group });
		f.reject401Once = true;
		await client(f).resolveIssue(1);
		assert.equal(f.tokens, 2);
		f.routes.set("/api/public/v1/issues/groups/2", { status: 401, body: {} });
		await assert.rejects(client(f).resolveIssue(2), (error: AikidoError) => error.kind === "unauthorized" && error.permanent);
	});

	it("falls back from a group to the issue with that id and its group", async () => {
		const f = await fake();
		f.routes.set("/api/public/v1/issues/9", { status: 200, body: { id: 9, group_id: 1, affected_package: "lodash" } });
		f.routes.set("/api/public/v1/issues/groups/1", { status: 200, body: group });
		const found = await client(f).resolveIssue(9);
		assert.equal(found.issue?.affected_package, "lodash");
		assert.equal(found.group.id, 1);
		assert.deepEqual(f.requests.filter((r) => r.url !== "/api/oauth/token").map((r) => r.url), ["/api/public/v1/issues/groups/9", "/api/public/v1/issues/9", "/api/public/v1/issues/groups/1"]);
	});

	it("says not_found, permanently, when neither a group nor an issue has the id", async () => {
		const f = await fake();
		await assert.rejects(client(f).resolveIssue(404), (error: AikidoError) => error.kind === "not_found" && error.permanent && error.status === 404);
	});

	it("separates refused credentials (permanent) from trouble that may pass (not permanent)", async () => {
		const f = await fake();
		f.tokenStatus = 401;
		await assert.rejects(client(f).resolveIssue(1), (error: AikidoError) => error.kind === "unauthorized" && error.permanent);
		f.tokenStatus = 200;
		f.routes.set("/api/public/v1/issues/groups/1", { status: 503, body: {} });
		await assert.rejects(client(f).resolveIssue(1), (error: AikidoError) => error.kind === "unavailable" && !error.permanent);
		f.routes.set("/api/public/v1/issues/groups/1", { status: 429, body: {} });
		await assert.rejects(client(f).resolveIssue(1), (error: AikidoError) => error.kind === "rate_limited" && !error.permanent);
		f.routes.set("/api/public/v1/issues/groups/1", { status: 200, body: "not json", raw: true });
		await assert.rejects(client(f).resolveIssue(1), (error: AikidoError) => error.kind === "bad_response");
	});

	it("refuses an answer larger than the cap, and an id that is not a whole number without any request", async () => {
		const f = await fake();
		f.routes.set("/api/public/v1/issues/groups/1", { status: 200, body: JSON.stringify({ x: "y".repeat(600_000) }), raw: true });
		await assert.rejects(client(f).resolveIssue(1), (error: AikidoError) => error.kind === "bad_response");
		const before = f.requests.length;
		for (const id of ["abc", "1/../2", "", "12345678901234", "1; drop"]) await assert.rejects(client(f).resolveIssue(id), AikidoError, id);
		assert.equal(f.requests.length, before);
	});

	it("does not follow a redirect to another host", async () => {
		const f = await fake();
		f.redirectTo = "https://evil.example/steal";
		await assert.rejects(client(f).resolveIssue(77), (error: AikidoError) => error.kind === "unavailable");
	});

	it("never puts the secret, the token or a body in an error", async () => {
		const f = await fake();
		f.routes.set("/api/public/v1/issues/groups/1", { status: 500, body: { leaked: "client-secret-value tok-1" } });
		const failures: string[] = [];
		for (const status of [500, 403, 404]) {
			f.routes.set("/api/public/v1/issues/groups/1", { status, body: { leaked: "client-secret-value tok-1" } });
			await client(f).resolveIssue(1).catch((error: Error) => failures.push(error.message));
		}
		f.tokenStatus = 401;
		await client(f).resolveIssue(1).catch((error: Error) => failures.push(error.message));
		assert.ok(failures.length >= 3);
		for (const message of failures) assert.ok(!/client-secret-value|tok-1|client-id-1|leaked/.test(message), message);
	});

	it("talks to the regional API host and the token endpoint only", () => {
		assert.equal(API_BASES.eu, "https://app.aikido.dev/api/public/v1");
		assert.equal(API_BASES.us, "https://app.us.aikido.dev/api/public/v1");
		assert.equal(OAUTH_URL, "https://app.aikido.dev/api/oauth/token");
		assert.throws(() => new AikidoClient({ region: "mars", credentials: { clientId: "a", clientSecret: "b" } }), /unknown Aikido region/);
		assert.throws(() => new AikidoClient({ region: "eu" }), /credentials are required/);
	});
});

describe("Aikido credentials file", () => {
	const write = (content: string): string => {
		const file = join(mkdtempSync(join(tmpdir(), "aikido-creds-")), "client.json");
		writeFileSync(file, content, { mode: 0o600 });
		return file;
	};
	it("reads both spellings of the client pair", () => {
		assert.deepEqual(readCredentials(write('{"clientId":"a","clientSecret":"b"}')), { clientId: "a", clientSecret: "b" });
		assert.deepEqual(readCredentials(write('{"client_id":"a","client_secret":"b"}')), { clientId: "a", clientSecret: "b" });
	});
	it("rejects a file that is missing, not JSON or incomplete without printing its content", () => {
		assert.throws(() => readCredentials("/nonexistent/client.json"), /cannot be read: ENOENT/);
		assert.throws(() => readCredentials(write("secret-not-json")), (error: Error) => /is not valid JSON/.test(error.message) && !error.message.includes("secret-not-json"));
		assert.throws(() => readCredentials(write('{"clientId":"a"}')), /needs clientId and clientSecret/);
	});
});
