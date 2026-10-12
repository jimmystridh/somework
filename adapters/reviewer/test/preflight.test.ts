import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ServiceContext } from "@somework/agent-kit";
import { reviewerHooksFor } from "../src/hooks.ts";
import { closeServers, codeHost, TOKEN } from "./support.ts";

afterEach(closeServers);

const context = (apiBase: string, over: Record<string, unknown> = {}): ServiceContext =>
	({
		env: { CHAT_REPOSITORY_URL: "https://github.com/o/r" },
		config: { state: { dir: mkdtempSync(join(tmpdir(), "reviewer-preflight-")) }, git: { tokenHosts: ["github.com"], githubApi: apiBase, mirror: undefined } },
		log: () => {},
		client: {},
		gitToken: TOKEN,
		ownerTokens: {},
		...over,
	}) as unknown as ServiceContext;

const run = (hooks: ReturnType<typeof reviewerHooksFor>) => hooks.preflight!({ log: () => {}, signal: new AbortController().signal });

describe("the reviewer's preflight", () => {
	it("checks that the read-only token reads the contents and the pull requests of the configured repository", async () => {
		const host = await codeHost();
		const checks = await run(reviewerHooksFor(context(host.apiBase)));
		assert.deepEqual(checks.map(({ name, ok }) => [name, ok]), [["github-repository", true], ["github-pull-requests", true]]);
		assert.deepEqual(host.seen.map((call) => call.url), ["/repos/o/r/contents", "/repos/o/r/pulls?per_page=1"]);
		assert.ok(host.seen.every((call) => call.auth === `Bearer ${TOKEN}`));
	});

	it("says what the review loses when the token cannot read pull requests", async () => {
		const host = await codeHost({ "/repos/o/r/pulls": 403 });
		const [, pulls] = await run(reviewerHooksFor(context(host.apiBase)));
		assert.deepEqual(pulls, { name: "github-pull-requests", ok: false, severity: "warning", detail: "the token lacks Pull requests: read; reviews run without the pull request's description, files and checks" });
	});

	it("has no preflight without a token", () => {
		assert.equal(reviewerHooksFor(context("http://127.0.0.1:1", { gitToken: undefined })).preflight, undefined);
	});
});
