import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { HandlerRunner, type RunResult } from "../src/events/runner.ts";
import type { HandlerEvent, HandlerInput } from "../src/events/types.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "events-runner-")));
const event: HandlerEvent = { id: "evt_1", seq: 1, topic: "github.pull_request.opened", source: "github", key: "k", data: { title: "hello" }, classification: "internal", verified: true, depth: 0, untrusted: true };
const input: HandlerInput = { event, agent: { id: "agent/test", role: "test", capabilities: [{ id: "code.review", version: "3" }] }, now: "2026-10-05T10:00:00Z" };
let counter = 0;

/** The container sandbox and the Windows environment add their base environment (PATH, HOME) to every command; a bare Node env does not. */
function sandboxLike(): NodeExecutionEnv {
	const env = new NodeExecutionEnv({ cwd: root });
	return new Proxy(env, {
		get(target, key) {
			if (key === "exec") return (command: string, options: any, context: any) => target.exec(command, { ...options, env: { PATH: process.env.PATH ?? "", ...(options?.env ?? {}) } }, context);
			const value = (target as any)[key];
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function runner(over: Partial<ConstructorParameters<typeof HandlerRunner>[0]> = {}): HandlerRunner {
	return new HandlerRunner({ env: sandboxLike, dir: join(root, ".somework-events"), timeoutSeconds: 5, memoryMb: 64, maxOutputBytes: 4096, fetchHosts: [], ...over });
}

const run = (source: string, over: Partial<ConstructorParameters<typeof HandlerRunner>[0]> = {}): Promise<RunResult> => {
	counter += 1;
	return runner(over).run({ name: `h${counter}`, hash: `${counter}`.padStart(12, "0"), source }, input);
};
const fn = (body: string) => `export default async function (input, kit) { ${body} }\n`;

describe("a handler runs in the agent's execution environment", () => {
	it("receives the input and returns its decision", async () => {
		const result = await run(fn("return { action: 'notify', message: input.event.data.title + ' on ' + input.agent.id + ' at ' + input.now };"));
		assert.ok(result.ok, JSON.stringify(result));
		assert.deepEqual(result.decision, { action: "notify", message: "hello on agent/test at 2026-10-05T10:00:00Z" });
	});

	it("can be a plain synchronous function and may log", async () => {
		const result = await run("export default function () { console.log('seen'); return { action: 'drop' }; }\n");
		assert.ok(result.ok);
		assert.deepEqual(result.decision, { action: "drop" });
		assert.match(result.stderr, /seen/, "console goes to the diagnostics, never into the decision");
	});

	it("does not see the service's environment, so credentials in it never reach a handler", async () => {
		process.env.SOMEWORK_TEST_SECRET = "must-not-leak";
		process.env.GIT_TOKEN = "ghp_neverseethisone123456";
		try {
			const result = await run(fn("return { action: 'notify', message: JSON.stringify(Object.entries(process.env)) };"));
			assert.ok(result.ok, JSON.stringify(result));
			const message = (result.decision as { message: string }).message;
			assert.ok(!message.includes("must-not-leak"), message);
			assert.ok(!message.includes("ghp_neverseethisone123456"), message);
			assert.ok(!/SOMEWORK_TEST_SECRET|GIT_TOKEN/.test(message), message);
		} finally {
			delete process.env.SOMEWORK_TEST_SECRET;
			delete process.env.GIT_TOKEN;
		}
	});

	it("is given only the fetch allow-list and output limit as settings", async () => {
		const result = await run(fn("return { action: 'notify', message: Object.keys(process.env).filter((name) => name.startsWith('HANDLER_')).sort().join(',') };"), { fetchHosts: ["api.example.com"] });
		assert.ok(result.ok);
		assert.equal((result.decision as { message: string }).message, "HANDLER_FETCH_HOSTS,HANDLER_MAX_OUTPUT");
	});

	it("leaves no input file behind", async () => {
		await run(fn("return { action: 'drop' };"));
		assert.ok(!readdirSync(join(root, ".somework-events")).some((file) => file.startsWith("in-")));
	});
});

describe("limits", () => {
	it("stops a handler that runs too long", async () => {
		const started = Date.now();
		const result = await run(fn("await new Promise(() => setInterval(() => {}, 1000));"), { timeoutSeconds: 1 });
		assert.ok(!result.ok);
		assert.equal(result.kind, "timeout");
		assert.ok(Date.now() - started < 8000);
	});

	it("stops a handler that uses too much memory", async () => {
		const result = await run(fn("const keep = []; for (;;) keep.push(new Array(1e6).fill(Math.random()));"), { memoryMb: 32, timeoutSeconds: 20 });
		assert.ok(!result.ok);
		assert.equal(result.kind, "memory", JSON.stringify(result));
	});

	it("stops a handler that prints without end", async () => {
		const result = await run(fn("for (;;) process.stdout.write('x'.repeat(1000));"), { maxOutputBytes: 2000, timeoutSeconds: 20 });
		assert.ok(!result.ok);
		assert.equal(result.kind, "output");
	});

	it("refuses a decision larger than the output cap", async () => {
		const result = await run(fn("return { action: 'notify', message: 'y'.repeat(6000) };"), { maxOutputBytes: 4096 });
		assert.ok(!result.ok);
		assert.equal(result.kind, "output");
	});
});

describe("failures", () => {
	it("reports an exception with the diagnostics redacted", async () => {
		const result = await run(fn("throw new Error('boom with token ghp_abcdefghijklmnop12345');"));
		assert.ok(!result.ok);
		assert.equal(result.kind, "error");
		assert.match(result.stderr, /boom/);
		assert.ok(!result.stderr.includes("ghp_abcdefghijklmnop12345"));
	});

	it("reports a module that is not a handler", async () => {
		const result = await run("export const x = 1;\n");
		assert.ok(!result.ok);
		assert.match(result.stderr, /no default export function/);
	});

	it("passes an empty return through for the caller's validation", async () => {
		const result = await run(fn("return;"));
		assert.ok(result.ok);
		assert.equal(result.decision, null);
	});

	it("reports an environment that cannot be reached", async () => {
		const result = await run(fn("return { action: 'drop' };"), { dir: "/proc/definitely/not/writable/events" });
		assert.ok(!result.ok);
		assert.equal(result.kind, "unavailable");
	});
});

describe("the kit offered to handlers", () => {
	it("redacts token-like strings", async () => {
		const result = await run(fn("return { action: 'notify', message: kit.redact('key ghp_abcdefghijklmnop12345 and Authorization: Bearer abcdefgh12345678') };"));
		assert.ok(result.ok);
		const message = (result.decision as { message: string }).message;
		assert.ok(!message.includes("ghp_abcdefghijklmnop12345") && !message.includes("abcdefgh12345678"), message);
	});

	it("fetches only https hosts on the allow-list and never sends credentials", async () => {
		const attempt = async (call: string, hosts: string[] = []) => {
			const result = await run(fn(`try { await ${call}; return { action: 'notify', message: 'allowed' }; } catch (error) { return { action: 'notify', message: String(error.message) }; }`), { fetchHosts: hosts });
			assert.ok(result.ok, JSON.stringify(result));
			return (result.decision as { message: string }).message;
		};
		assert.match(await attempt("kit.fetchText('https://api.example.com/x')"), /not on this agent's fetch allow-list/);
		assert.match(await attempt("kit.fetchText('http://api.example.com/x')", ["api.example.com"]), /only https/);
		assert.match(await attempt("kit.fetchJson('https://evil.example.net/x')", ["api.example.com"]), /allow-list/);
		assert.match(await attempt("kit.fetchText('https://api.example.com/x', { headers: { Authorization: 'Bearer abc' } })", ["api.example.com"]), /does not send credentials: Authorization/);
		assert.match(await attempt("kit.fetchText('https://api.example.com/x', { headers: { cookie: 'a=b' } })", ["api.example.com"]), /does not send credentials/);
	});
});
