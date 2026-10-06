import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { GitHubAppCredentials } from "../src/github-app.ts";
import { GitHubHost } from "../src/githost.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

interface Call {
	method: string;
	path: string;
	authorization: string;
	body?: any;
}

function fakeGitHub(options: { installations?: { id: number }[]; lifetimeSeconds?: number; clock: { now: number } }) {
	const calls: Call[] = [];
	let minted = 0;
	const fetchImpl = (async (url: string, init: any) => {
		const path = new URL(url).pathname + new URL(url).search;
		calls.push({ method: init.method, path, authorization: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined });
		const answer = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
		if (path.startsWith("/app/installations?")) return answer(options.installations ?? [{ id: 77 }]);
		if (path === "/app/installations/77/access_tokens") {
			minted += 1;
			return answer({ token: `ghs_token_${minted}`, expires_at: new Date(options.clock.now + (options.lifetimeSeconds ?? 3600) * 1000).toISOString() }, 201);
		}
		if (path === "/app") return answer({ slug: "somework-developer" });
		if (path === "/users/somework-developer%5Bbot%5D") return answer({ id: 424242 });
		return answer({ message: "not found" }, 404);
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());

test("the app JWT is RS256, short-lived and verifies against the app's public key", async () => {
	const clock = { now: Date.UTC(2026, 9, 6, 12) };
	const github = fakeGitHub({ clock });
	const app = new GitHubAppCredentials({ appId: "12345", privateKeyPem, installationId: "77", fetch: github.fetchImpl, now: () => clock.now });
	await app.token();
	const [header, claims, signature] = github.calls[0]!.authorization.replace("Bearer ", "").split(".") as [string, string, string];
	assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT" });
	assert.equal(decode(claims).iss, "12345");
	assert.equal(decode(claims).exp - decode(claims).iat, 600);
	assert.ok(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, "base64url")));
});

test("a token is reused until shortly before it expires, then replaced; concurrent callers share one request", async () => {
	const clock = { now: Date.UTC(2026, 9, 6, 12) };
	const github = fakeGitHub({ clock });
	const app = new GitHubAppCredentials({ appId: "1", privateKeyPem, installationId: "77", fetch: github.fetchImpl, now: () => clock.now });
	const [a, b] = await Promise.all([app.token(), app.token()]);
	assert.equal(a, "ghs_token_1");
	assert.equal(b, "ghs_token_1");
	clock.now += 3000 * 1000;
	assert.equal(await app.token(), "ghs_token_1");
	clock.now += 400 * 1000;
	assert.equal(await app.token(), "ghs_token_2", "inside the five-minute margin a new token is minted");
	assert.equal(github.calls.filter((call) => call.path.endsWith("/access_tokens")).length, 2);
});

test("the token can be narrowed to named repositories, and the installation is found when there is exactly one", async () => {
	const clock = { now: Date.now() };
	const github = fakeGitHub({ clock });
	const app = new GitHubAppCredentials({ appId: "1", privateKeyPem, repositories: ["visma.administration"], fetch: github.fetchImpl, now: () => clock.now });
	await app.token();
	assert.equal(github.calls[0]!.path.startsWith("/app/installations?"), true);
	assert.deepEqual(github.calls[1]!.body, { repositories: ["visma.administration"] });
});

test("several installations without GITHUB_APP_INSTALLATION_ID is an error, and a refusal from GitHub surfaces without the key", async () => {
	const clock = { now: Date.now() };
	const many = fakeGitHub({ clock, installations: [{ id: 1 }, { id: 2 }] });
	await assert.rejects(new GitHubAppCredentials({ appId: "1", privateKeyPem, fetch: many.fetchImpl, now: () => clock.now }).token(), /2 installations: set GITHUB_APP_INSTALLATION_ID/);
	const refused = new GitHubAppCredentials({ appId: "1", privateKeyPem, installationId: "999", fetch: fakeGitHub({ clock }).fetchImpl, now: () => clock.now });
	await assert.rejects(refused.token(), (error: Error) => /answered 404/.test(error.message) && !error.message.includes("PRIVATE KEY"));
});

test("the commit identity is the app's bot account with its noreply address", async () => {
	const clock = { now: Date.now() };
	const app = new GitHubAppCredentials({ appId: "1", privateKeyPem, installationId: "77", fetch: fakeGitHub({ clock }).fetchImpl, now: () => clock.now });
	assert.deepEqual(await app.identity(), { name: "somework-developer[bot]", email: "424242+somework-developer[bot]@users.noreply.github.com" });
});

test("a bad app id or key is refused at construction", () => {
	assert.throws(() => new GitHubAppCredentials({ appId: "somework", privateKeyPem }), /numeric id/);
	assert.throws(() => new GitHubAppCredentials({ appId: "1", privateKeyPem: "not a key" }), /PEM private key/);
});

test("the pull request host asks the token source on every call", async () => {
	const seen: string[] = [];
	let n = 0;
	const host = new GitHubHost({
		token: async () => `t${++n}`,
		fetch: (async (_url: string, init: any) => {
			seen.push(init.headers.authorization);
			return new Response(JSON.stringify([]), { status: 200 });
		}) as unknown as typeof fetch,
	});
	await host.findPullRequest({ repoUrl: "https://github.com/o/r.git", head: "agent/x" });
	await host.findPullRequest({ repoUrl: "https://github.com/o/r.git", head: "agent/y" });
	assert.deepEqual(seen, ["Bearer t1", "Bearer t2"]);
});

test("config: an app replaces the token file, the two together are refused, the author follows the app unless set", () => {
	const base = { SOMEWORK_URL: "https://x", SOMEWORK_KEY_FILE: "/k", SANDBOX_URL: "http://s" };
	const config = loadConfig({ ...base, GITHUB_APP_ID: "9", GITHUB_APP_KEY_FILE: "/app.pem", GITHUB_APP_REPOSITORIES: "a, b" });
	assert.deepEqual(config.git.app, { appId: "9", keyFile: "/app.pem", installationId: undefined, repositories: ["a", "b"] });
	assert.equal(config.git.authorFromApp, true);
	assert.equal(loadConfig({ ...base, GITHUB_APP_ID: "9", GITHUB_APP_KEY_FILE: "/app.pem", GIT_AUTHOR_NAME: "Bot", GIT_AUTHOR_EMAIL: "b@x" }).git.authorFromApp, false);
	assert.throws(() => loadConfig({ ...base, GITHUB_APP_ID: "9", GITHUB_APP_KEY_FILE: "/app.pem", GIT_TOKEN_FILE: "/t" }), /not both/);
	assert.throws(() => loadConfig({ ...base, GITHUB_APP_ID: "9" }), /go together/);
	assert.equal(loadConfig(base).git.app, undefined);
});
