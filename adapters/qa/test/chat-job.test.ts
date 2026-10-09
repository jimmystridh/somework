import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { approvalPolicy, createHandler, Metrics, PiDurableRuntime } from "@somework/agent-kit";
import { scriptedModels } from "@somework/agent-kit/providers/faux";
import { chatInstructionRig, FakeHost, makeRemote, sh } from "@somework/agent-kit/testing";
import { localEnvFactory } from "@somework/agent-kit/windows";
import { freePort } from "../../../sdk/typescript/test/harness.ts";
import type { AppProfile } from "../src/app.ts";
import { FakeBackend } from "../src/browser/fake.ts";
import { qaChat } from "../src/chat.ts";
import { createQaHooks } from "../src/hooks.ts";
import { qaProfile } from "../src/profile.ts";
import { QaSession } from "../src/session.ts";

const cliPath = fileURLToPath(new URL("../src/browser/cli.ts", import.meta.url));
const PAGE = `<!doctype html><html><head><title>Invoice form</title></head><body><h1>Invoice</h1><label for="c">Customer</label><input id="c" type="text"><button>Calculate</button><p id="o">Total: 0</p></body></html>`;
const APP_SERVER = `import { createServer } from "node:http";
createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end(${JSON.stringify(PAGE)}); }).listen(Number(process.argv[2]), "127.0.0.1");\n`;
const REPORT = `\`\`\`json\n${JSON.stringify({ verdict: "verified", acceptanceChecks: [{ criterion: "the total is right", passed: true, evidence: "saw it" }], fixtures: [], notes: "done" })}\n\`\`\``;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("a ticket verification given as an instruction in chat, in a domain that has no task for it", () => {
	it("verifies: the video is kept on the host and named in the reply, the app is stopped, and no task-bound call is made", async () => {
		const { dir: remoteDir, remote } = makeRemote();
		const seed = join(remoteDir, "seed");
		writeFileSync(join(seed, "server.mjs"), APP_SERVER);
		sh(seed, "add", "-A");
		sh(seed, "commit", "-m", "app");
		sh(seed, "push", "origin", "HEAD:main");
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "qa-chat-")));
		const root = join(dir, "workspaces").replaceAll("\\", "/");
		const port = await freePort();
		const url = `http://127.0.0.1:${port}/`;
		const profiles: Record<string, AppProfile> = { default: { start: `nohup node server.mjs ${port} > .qa-app.log 2>&1 < /dev/null & echo $! > .qa-app.pid`, health: [url], stop: "kill $(cat .qa-app.pid)", env: {}, startupTimeoutSeconds: 20 } };
		const ticketPattern = /^QA-[0-9]+$/;
		const chat = chatInstructionRig({ stateDir: dir });
		const session = new QaSession();
		const profile = qaProfile({});
		const envFor = localEnvFactory({ root, baseEnv: { PATH: process.env.PATH ?? "", HOME: root }, flavour: "posix" });
		const hooks = createQaHooks({
			root,
			ticketPattern,
			profiles,
			session,
			appEnv: (cwd) => envFor(cwd) as never,
			browser: async () => new FakeBackend({ [url]: { title: "Invoice form", lines: ["# Invoice", '[e1] textbox "Customer"', '[e2] button "Calculate"'] } }),
			allowHosts: ["127.0.0.1", "localhost"],
			cliPath,
			extensions: [],
			hasTicketSystem: false,
			verifiedLabel: "AgentTested",
			client: chat.client,
			secrets: [],
		});
		const wrapper = `"$(ls ${root}/.qa/*/qa)"`;
		const fake = scriptedModels([`bash:${wrapper} open ${url}`, `bash:${wrapper} snapshot`, `bash:${wrapper} video-start`, `bash:${wrapper} fill e1 ACME`, `bash:${wrapper} click e2`, `bash:${wrapper} video-stop`, 'call:qa_record_verdict:{"verdict":"verified"}', `final:${REPORT}`]);
		const runtime = new PiDurableRuntime({ storagePath: join(dir, "pi.sqlite"), models: fake.models, model: fake.model, env: envFor, policy: approvalPolicy([], profile.approvalPatterns, profile.toolApprovals), allowedTools: profile.allowedTools, extensions: hooks.extensions });
		await runtime.start();
		cleanups.push(() => runtime.close());
		const handler = createHandler({ runtime: hooks.wrapRuntime!(runtime), envFor, session: { env: envFor(root), identity: { name: "QA", email: "qa@test.invalid" } }, host: new FakeHost(), workspaceRoot: root, client: chat.client, limits: { maxTokensCap: 5_000_000, maxMinutesCap: 60 }, metrics: new Metrics(), profile, hooks, source: "chat" });
		const roleChat = qaChat({ CHAT_REPOSITORY_URL: "https://example.test/o/r" } as NodeJS.ProcessEnv, ticketPattern);
		const planned = (text: string) => {
			const result = roleChat.instructInput!(text) as { capability: any; input: any };
			return "refuse" in result ? result : { ...result, input: { ...result.input, repository: { url: remote, ref: sh(remote, "rev-parse", "main").trim() } } };
		};
		const reply = await chat.responderFor(handler, planned as never, roleChat.describeResult).instruct("verify QA-1");
		assert.match(reply, /^QA-1: VERIFIED\nRevision tested: front end [0-9a-f]{12}\n\nFindings: done\n\nAcceptance checks \(1 passed, 0 failed\):\n✔ the total is right — saw it/);
		assert.match(reply, /Attachments were not uploaded to the domain/);
		assert.match(reply, /chat-m1-qa-video-1\.webm \(video\/webm, [^)]*\): on the agent host at .*chat-artifacts\/chat-m1\//);
		assert.deepEqual(chat.domain.calls, []);
		const kept = readdirSync(join(dir, "chat-artifacts", "chat-m1"));
		assert.ok(kept.some((name) => name.endsWith(".webm")), "the video is on the host");
		assert.equal(await fetch(url, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false), false, "the application was stopped");
		assert.ok(existsSync(join(dir, "chat-artifacts")));
		assert.ok(Buffer.byteLength(reply) <= 4096);
	});
});
