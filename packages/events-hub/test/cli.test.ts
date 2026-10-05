import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { hookToken, signingSecret } from "../src/derive.ts";
import { githubPr, post, SECRET, startWorld, waitFor, type World } from "./support.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
let current: World | undefined;
afterEach(async () => {
	if (current) {
		await current.hub.stop().catch(() => {});
		await current.stop();
		current = undefined;
	}
});

const run = (w: World, args: string[]) =>
	new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
		const configPath = join(w.dir, "hub.config.json");
		const sources = w.config.sources.map((s) => ({ name: s.name, version: s.version, ...(s.mapping ? { mapping: s.mapping } : {}), ...(s.producer ? { producer: s.producer } : {}), ...(s.internal ? { internal: true } : {}), ...(s.forward ? { forward: s.forward } : {}) }));
		writeFileSync(configPath, JSON.stringify({ domain: { url: w.config.domain.url, requireTls: false }, receiver: { url: w.config.receiver.url }, mappingsDir: w.config.mappingsDir, storePath: w.config.storePath, sources, clock: { producer: { keyFile: w.producers.clock!.keyFile }, schedules: [] } }));
		writeFileSync(join(w.dir, "secret"), SECRET);
		execFile(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], { env: { ...process.env, HUB_CONFIG: configPath, HUB_SECRET_FILE: join(w.dir, "secret") }, encoding: "utf8" }, (error, stdout, stderr) => {
			resolve({ status: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
		});
	});

describe("the operator CLI", () => {
	it("lists, shows, replays and drops dead letters", async () => {
		const w = (current = await startWorld());
		w.domain.always = { status: 400 };
		await post(w.edge.hook("github"), githubPr("cli-1"));
		await post(w.edge.hook("github"), githubPr("cli-2"));
		w.hub.start();
		await waitFor(() => w.store.deadLetters().length === 2, 8000, "two dead letters");
		await w.hub.stop();
		const [first, second] = w.store.deadLetters();

		const listed = await run(w, ["dead-letters", "list"]);
		assert.equal(listed.status, 0, listed.stderr);
		assert.equal(listed.stdout.trim().split("\n").length, 2);
		assert.ok(listed.stdout.includes(first!.id) && listed.stdout.includes("publish"));

		const shown = await run(w, ["dead-letters", "show", first!.id]);
		assert.equal(shown.status, 0, shown.stderr);
		const meta = JSON.parse(shown.stdout);
		assert.equal(meta.source, "github");
		assert.ok(meta.bodyStart.includes("pull_request"));
		assert.equal(meta.query, undefined, "the query is secret material and is not shown");

		w.domain.always = undefined;
		const replayed = await run(w, ["dead-letters", "replay", first!.id]);
		assert.equal(replayed.status, 0, replayed.stderr);
		assert.match(replayed.stdout, /"kind":"published"/);
		assert.equal(w.domain.uniqueEvents, 1);

		const all = await run(w, ["dead-letters", "replay", "--all"]);
		assert.equal(all.status, 0, all.stderr);
		assert.equal(w.domain.uniqueEvents, 2);
		assert.equal((await run(w, ["dead-letters", "list"])).stdout.trim(), "");

		assert.equal((await run(w, ["dead-letters", "drop", second!.id])).status, 0);
		assert.equal((await run(w, ["dead-letters", "drop", second!.id])).status, 1, "dropping twice fails");
		assert.equal((await run(w, ["dead-letters", "show", "nope"])).status, 1);
	});

	it("reports a failed replay with a non-zero exit and keeps the letter", async () => {
		const w = (current = await startWorld());
		w.domain.always = { status: 400 };
		await post(w.edge.hook("github"), githubPr("cli-fail"));
		w.hub.start();
		await waitFor(() => w.store.deadLetters().length === 1, 8000, "a dead letter");
		await w.hub.stop();
		const replayed = await run(w, ["dead-letters", "replay", "--all"]);
		assert.equal(replayed.status, 1);
		assert.match(replayed.stderr, /FAILED/);
		assert.equal(w.store.deadLetters({ pending: true }).length, 1);
	});

	it("tests a mapping on a saved webhook body", async () => {
		const w = (current = await startWorld());
		const file = join(w.dir, "payload.json");
		writeFileSync(file, githubPr("x").body);
		const result = await run(w, ["mapping", "test", "github", file, "--header", "x-github-event=pull_request", "--header", "x-github-delivery=abc"]);
		assert.equal(result.status, 0, result.stderr);
		const out = JSON.parse(result.stdout);
		assert.equal(out.events[0].topic, "github.pull_request.opened");
		assert.equal(out.events[0].key, "github:delivery:abc");
	});

	it("prints the webhook URL of every source and the signing secret of a github-hmac source", async () => {
		const w = (current = await startWorld());
		const urls = await run(w, ["urls", "--host", "https://hooks.example.test"]);
		assert.equal(urls.status, 0, urls.stderr);
		const lines = urls.stdout.trim().split("\n").map((line) => line.split("\t"));
		assert.deepEqual(lines.map((l) => l[0]), ["github", "jira", "datadog", "grafana", "woodpecker"]);
		assert.equal(lines[0]![2], `POST https://hooks.example.test/hook/github/${hookToken(SECRET, "github", 1)}`);
		assert.equal(lines[3]![1], "internal");
		assert.equal(lines[3]![2], `POST /in/grafana/${hookToken(SECRET, "grafana", 1)}`);
		const receiverConfig = join(w.dir, "receiver.config.json");
		writeFileSync(receiverConfig, JSON.stringify({ sources: [{ name: "woodpecker", path: "/api/hook" }] }));
		const withSuffix = await run(w, ["urls", "--host", "https://h", "--receiver-config", receiverConfig]);
		assert.match(withSuffix.stdout, new RegExp(`woodpecker\tpublic\tPOST https://h/hook/woodpecker/${hookToken(SECRET, "woodpecker", 1)}/api/hook`));
		assert.equal((await run(w, ["signing-secret", "github"])).stdout.trim(), signingSecret(SECRET, "github", 1));
		assert.equal((await run(w, ["signing-secret", "nosuch"])).status, 1);
	});

	it("prints usage", async () => {
		const w = (current = await startWorld());
		assert.equal((await run(w, ["--help"])).status, 0);
		assert.equal((await run(w, ["nonsense"])).status, 2);
	});
});
