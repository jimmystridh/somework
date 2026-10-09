import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { AikidoClient, AikidoError, API_BASES, OAUTH_URL, readCredentials, retryAfterMs } from "../src/aikido/client.ts";

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

	it("adds the open issues of the group: the file and the versions the group alone does not have", async () => {
		const f = await fake();
		const issues = [{ id: 5, group_id: 1, affected_file: "bun.lock", affected_package: "ws", installed_version: "1.5.4" }, { id: 6, group_id: 1, affected_file: "package.json" }];
		f.routes.set("/api/public/v1/issues/groups/1", { status: 200, body: group });
		f.routes.set("/api/public/v1/issues/export?format=json&filter_status=open&filter_issue_group_id=1", { status: 200, body: issues });
		const found = await client(f).resolveIssue(1);
		assert.deepEqual(found.issues, issues);
		assert.equal(found.issue?.affected_file, "bun.lock");
	});

	it("still answers with the group when the issues cannot be read", async () => {
		const f = await fake();
		f.routes.set("/api/public/v1/issues/groups/1", { status: 200, body: group });
		f.routes.set("/api/public/v1/issues/export?format=json&filter_status=open&filter_issue_group_id=1", { status: 503, body: {} });
		const found = await client(f).resolveIssue(1);
		assert.deepEqual(found, { group });
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

describe("Aikido client: pacing, rate limits and sharing", () => {
	const OAUTH = "https://aikido.test/oauth";
	const API = "https://aikido.test/api";
	const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

	function scripted(answers: Record<string, (() => Response)[] | (() => Response)>) {
		const calls: { at: number; url: string }[] = [];
		const clock = { now: 1_000_000 };
		const sleeps: number[] = [];
		const fetcher = (async (url: string) => {
			const path = url.startsWith(OAUTH) ? "/oauth" : url.slice(API.length);
			calls.push({ at: clock.now, url: path });
			if (path === "/oauth") return json({ access_token: "tok", expires_in: 3600 });
			const answer = answers[path];
			const next = Array.isArray(answer) ? (answer.length > 1 ? answer.shift()! : answer[0]!) : answer;
			return next ? next() : json({}, 404);
		}) as unknown as typeof fetch;
		const make = (extra: Partial<ConstructorParameters<typeof AikidoClient>[0]> = {}) =>
			new AikidoClient({
				credentials: { clientId: "client-id-1", clientSecret: "client-secret-value" },
				apiBase: API,
				oauthUrl: OAUTH,
				fetch: fetcher,
				now: () => clock.now,
				sleep: async (ms) => {
					sleeps.push(ms);
					clock.now += ms;
				},
				...extra,
			});
		return { make, calls, sleeps, clock };
	}

	it("spaces requests out: a burst waits for its turn instead of going at once", async () => {
		const s = scripted({ "/issues/groups/1": () => json({ id: 1 }), "/issues/groups/2": () => json({ id: 2 }), "/issues/groups/3": () => json({ id: 3 }) });
		const c = s.make({ minIntervalMs: 1500, cacheMs: 0 });
		await Promise.all([1, 2, 3].map((id) => c.resolveIssue(id, { details: false })));
		const times = s.calls.map((call) => call.at);
		for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! >= 1500, `request ${i} came ${times[i]! - times[i - 1]!} ms after the previous one`);
	});

	it("waits as long as Retry-After says and tries again, then gives up with rate_limited", async () => {
		const answers = [() => json({}, 429, { "retry-after": "7" }), () => json({ id: 1 })];
		const s = scripted({ "/issues/groups/1": answers });
		const found = await s.make({ minIntervalMs: 0, cacheMs: 0 }).resolveIssue(1, { details: false });
		assert.deepEqual(found.group, { id: 1 });
		assert.ok(s.sleeps.includes(7000), `slept ${s.sleeps}`);

		const never = scripted({ "/issues/groups/1": () => json({}, 429) });
		await assert.rejects(never.make({ minIntervalMs: 0, cacheMs: 0, maxRetries: 2 }).resolveIssue(1, { details: false }), (error: unknown) => error instanceof AikidoError && error.kind === "rate_limited");
		assert.equal(never.calls.filter((call) => call.url === "/issues/groups/1").length, 3, "the first try and two more");
		const grown = never.sleeps.filter((ms) => ms >= 2000);
		assert.ok(grown.length >= 2 && grown[1]! > grown[0]!, `the wait grows: ${never.sleeps}`);
	});

	it("reads a Retry-After given as a date, and never waits more than a minute", () => {
		assert.equal(retryAfterMs("3", 0), 3000);
		assert.equal(retryAfterMs("999", 0), 60_000);
		assert.equal(retryAfterMs(new Date(5000).toUTCString(), 1000), 4000);
		assert.equal(retryAfterMs("soon", 0), undefined);
		assert.equal(retryAfterMs(null, 0), undefined);
	});

	it("shares an issue between jobs: the same id is asked for once, also when asked at the same time, and a failure is not kept", async () => {
		const failing = [() => json({}, 503), () => json({ id: 5 })];
		const s = scripted({ "/issues/groups/4": () => json({ id: 4 }), "/issues/export?format=json&filter_status=open&filter_issue_group_id=4": () => json([{ id: 41 }]), "/issues/groups/5": failing });
		const c = s.make({ minIntervalMs: 0, cacheMs: 60_000 });
		const [a, b] = await Promise.all([c.resolveIssue(4), c.resolveIssue("4")]);
		assert.deepEqual(a, b);
		await c.resolveIssue(4);
		assert.equal(s.calls.filter((call) => call.url === "/issues/groups/4").length, 1);
		assert.equal(s.calls.filter((call) => call.url.startsWith("/issues/export")).length, 1);
		await assert.rejects(c.resolveIssue(5, { details: false }), (error: unknown) => error instanceof AikidoError && error.kind === "unavailable");
		assert.deepEqual((await c.resolveIssue(5, { details: false })).group, { id: 5 });
		const later = scripted({ "/issues/groups/4": () => json({ id: 4 }) });
		const short = later.make({ minIntervalMs: 0, cacheMs: 1000 });
		await short.resolveIssue(4, { details: false });
		later.clock.now += 2000;
		await short.resolveIssue(4, { details: false });
		assert.equal(later.calls.filter((call) => call.url === "/issues/groups/4").length, 2, "a kept issue goes stale");
	});

	it("leaves the heaviest request out when only the group is wanted, and asks for it later", async () => {
		const s = scripted({ "/issues/groups/9": () => json({ id: 9 }), "/issues/export?format=json&filter_status=open&filter_issue_group_id=9": () => json([{ id: 91 }]) });
		const c = s.make({ minIntervalMs: 0 });
		assert.deepEqual(await c.resolveIssue(9, { details: false }), { group: { id: 9 } });
		assert.ok(!s.calls.some((call) => call.url.startsWith("/issues/export")));
		const full = await c.resolveIssue(9);
		assert.deepEqual(full.issues, [{ id: 91 }]);
		assert.equal(s.calls.filter((call) => call.url === "/issues/groups/9").length, 1, "the group is not read twice");
	});
});
