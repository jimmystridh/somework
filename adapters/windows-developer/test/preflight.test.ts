import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import type { ServiceContext } from "@somework/agent-kit";
import { windowsHooksFor } from "../src/service.ts";
import { loadWindowsSettings } from "../src/settings.ts";

const TOKEN = "xq9-plain-literal-token-0123456789";
const servers: Server[] = [];
// the confined environment makes its workspace root (here a relative "C:/ws" off Windows) in the working directory
const home = process.cwd();
before(() => process.chdir(mkdtempSync(join(tmpdir(), "windows-preflight-"))));
after(() => process.chdir(home));
afterEach(() => {
	for (const server of servers.splice(0)) server.close();
});

async function codeHost(answers: Record<string, number>) {
	const seen: { url: string; auth?: string }[] = [];
	const server = createServer((req, res) => {
		seen.push({ url: req.url!, auth: req.headers.authorization });
		res.statusCode = answers[req.url!.split("?")[0]!] ?? 200;
		res.end("[]");
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { apiBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const hooksFor = (apiBase: string, over: Record<string, unknown> = {}) =>
	windowsHooksFor(
		loadWindowsSettings({ WINDOWS_WORKSPACE_ROOT: "C:\\ws" }, () => true),
		{ env: { CHAT_REPOSITORY_URL: "https://github.com/o/r" }, config: { git: { tokenHosts: ["github.com"], githubApi: apiBase, mirror: undefined } }, log: () => {}, gitToken: TOKEN, ownerTokens: {}, ...over } as unknown as ServiceContext,
	);

describe("the Windows developer's preflight", () => {
	it("checks that the git token reads the configured repository and its pull requests", async () => {
		const host = await codeHost({ "/repos/o/r/pulls": 403 });
		const checks = await hooksFor(host.apiBase).preflight!({ log: () => {}, signal: new AbortController().signal });
		assert.deepEqual(checks, [
			{ name: "github-repository", ok: true, severity: "error" },
			{ name: "github-pull-requests", ok: false, severity: "warning", detail: "the token lacks Pull requests: read; pull requests cannot be found or opened" },
		]);
		assert.ok(host.seen.every((call) => call.auth === `Bearer ${TOKEN}`));
	});

	it("has no preflight without a git token", () => {
		assert.equal(hooksFor("http://127.0.0.1:1", { gitToken: undefined }).preflight, undefined);
	});
});
