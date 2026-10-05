import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { RuleSpec, RuleView } from "@somework/sdk";
import { run, type Io } from "../src/cli.ts";
import { asLive, declared, FakeDomain, parse } from "./fake.ts";
import { realRules, repoRoot, REVIEW_YAML, rulesDir, view } from "./helpers.ts";

function invoke(args: string[], io: Partial<Io> = {}) {
	const out: string[] = [];
	const err: string[] = [];
	return run(args, { stdout: (text) => out.push(text), stderr: (text) => err.push(text), env: {}, ...io }).then((code) => ({ code, out: out.join(""), err: err.join("") }));
}

const temp = () => mkdtempSync(join(tmpdir(), "rules-cli-out-"));
const apiOf = (domain: FakeDomain): Io["api"] => () => ({ listRules: () => domain.list(), putRule: (name, spec) => domain.put(name, spec), deleteRule: (name) => domain.remove(name), pauseRule: (name) => domain.pause(name), resumeRule: (name) => domain.resume(name) });

describe("validate", () => {
	it("passes the shipped rules, with the real cards and samples, even in strict mode", async () => {
		const result = await invoke(["validate", "--dir", realRules, "--card", join(repoRoot, "adapters"), "--strict"]);
		assert.equal(result.code, 0, result.err);
		assert.match(result.out, /^\d+ rule file\(s\) valid/);
	});

	it("exits 1, names the file and writes a markdown comment for a pull request", async () => {
		const dir = rulesDir({ "pr-review.yaml": REVIEW_YAML.replace("owner: automation/pr-review", "owner: agent/manager") });
		const out = join(temp(), "plan.md");
		const json = join(temp(), "plan.json");
		const result = await invoke(["validate", "--dir", dir, "--out", out, "--json-out", json]);
		assert.equal(result.code, 1);
		assert.match(result.err, /error\s+pr-review\.yaml: a rule with a reaction must be owned by an automation principal/);
		assert.match(readFileSync(out, "utf8"), /not valid, so no plan was made[\s\S]*pr-review\.yaml/);
		assert.equal(JSON.parse(readFileSync(json, "utf8")).ok, false);
	});

	it("exits 1 for warnings only in strict mode", async () => {
		const dir = rulesDir({ "pr-review.yaml": `${REVIEW_YAML}status: active\n` });
		assert.equal((await invoke(["validate", "--dir", dir])).code, 0);
		assert.equal((await invoke(["validate", "--dir", dir, "--strict"])).code, 1);
	});
});

describe("plan and apply", () => {
	const dir = () => rulesDir({ ...declared("a"), ...declared("b") });

	it("plan prints the markdown, writes both outputs, and exits 0 when there are changes", async () => {
		const domain = new FakeDomain(asLive([parse(declared("a"))[0]!]));
		const out = join(temp(), "plan.md");
		const json = join(temp(), "plan.json");
		const result = await invoke(["plan", "--dir", dir(), "--out", out, "--json-out", json], { api: apiOf(domain) });
		assert.equal(result.code, 0, result.err);
		assert.match(result.out, /`b` \| create/);
		assert.equal(readFileSync(out, "utf8").trimEnd(), result.out.trimEnd());
		const parsed = JSON.parse(readFileSync(json, "utf8"));
		assert.equal(parsed.hasChanges, true);
		assert.equal(parsed.counts.create, 1);
		assert.deepEqual(domain.calls.filter((call) => call !== "list"), []);
	});

	it("plan warns that apply would refuse a risky plan but still exits 0", async () => {
		const many = Array.from({ length: 6 }, (_, index) => view(`old${index}`, { owner: "agent/x", selector: "x.y.z", wake: true }));
		const result = await invoke(["plan", "--dir", dir()], { api: apiOf(new FakeDomain(many)) });
		assert.equal(result.code, 0);
		assert.match(result.err, /apply would refuse this plan: applying would delete 6 rules/);
	});

	it("plan stops at validation errors with exit 1 and never contacts the domain", async () => {
		const domain = new FakeDomain();
		const result = await invoke(["plan", "--dir", rulesDir({ "x.yaml": "name: x\n" })], { api: apiOf(domain) });
		assert.equal(result.code, 1);
		assert.deepEqual(domain.calls, []);
	});

	it("apply --dry-run changes nothing and apply converges the domain", async () => {
		const domain = new FakeDomain();
		const dry = await invoke(["apply", "--dir", dir(), "--dry-run"], { api: apiOf(domain) });
		assert.equal(dry.code, 0);
		assert.match(dry.out, /Dry run: nothing was changed/);
		assert.equal(domain.rules.size, 0);
		const real = await invoke(["apply", "--dir", dir()], { api: apiOf(domain) });
		assert.equal(real.code, 0, real.err);
		assert.match(real.out, /the domain now matches the files/);
		assert.deepEqual([...domain.rules.keys()].sort(), ["a", "b"]);
	});

	it("apply exits 2 when a change fails and says which", async () => {
		const domain = new FakeDomain();
		domain.failOn.add("put b");
		const result = await invoke(["apply", "--dir", dir()], { api: apiOf(domain) });
		assert.equal(result.code, 2);
		assert.match(result.err, /failed: create b: 500 internal: boom/);
		assert.match(result.out, /does not match the files yet/);
	});

	it("apply refuses an empty rules directory unless told otherwise", async () => {
		const domain = new FakeDomain(asLive(parse(declared("a"))));
		const refused = await invoke(["apply", "--dir", rulesDir({})], { api: apiOf(domain) });
		assert.equal(refused.code, 2);
		assert.match(refused.err, /refused: no rule files were found/);
		assert.equal(domain.rules.size, 1);
		assert.equal((await invoke(["apply", "--dir", rulesDir({}), "--allow-empty"], { api: apiOf(domain) })).code, 0);
		assert.equal(domain.rules.size, 0);
	});

	it("honours --no-prune and --max-deletes", async () => {
		const stale = [view("o1", { owner: "agent/x", selector: "x.y.z", wake: true }), view("o2", { owner: "agent/x", selector: "x.y.z", wake: true })];
		const domain = new FakeDomain(stale);
		assert.equal((await invoke(["apply", "--dir", dir(), "--no-prune"], { api: apiOf(domain) })).code, 0);
		assert.equal(domain.rules.size, 4);
		assert.equal((await invoke(["apply", "--dir", dir(), "--max-deletes", "1"], { api: apiOf(domain) })).code, 2);
		assert.equal(domain.rules.size, 4);
		assert.equal((await invoke(["apply", "--dir", dir(), "--max-deletes", "2"], { api: apiOf(domain) })).code, 0);
		assert.equal(domain.rules.size, 2);
	});
});

describe("usage", () => {
	it("prints help and fails on unknown commands, unknown options and a missing environment", async () => {
		assert.equal((await invoke(["--help"])).code, 0);
		assert.equal((await invoke([])).code, 2);
		assert.equal((await invoke(["destroy"])).code, 2);
		assert.equal((await invoke(["plan", "--bogus"])).code, 2);
		const missing = await invoke(["plan", "--dir", rulesDir({ ...declared("a") })]);
		assert.equal(missing.code, 2);
		assert.match(missing.err, /SOMEWORK_URL and SOMEWORK_RULES_KEY_FILE must be set/);
	});
});

describe("against an HTTP domain", () => {
	let server: Server;
	let url: string;
	const store = new Map<string, RuleView>();
	const seen: { method: string; path: string; authorized: boolean }[] = [];
	let shape: "ok" | "broken" = "ok";
	let keyFile: string;

	before(async () => {
		keyFile = join(temp(), "rules.key.json");
		writeFileSync(keyFile, JSON.stringify({ kind: "service", id: "deployer/rules", domainId: "development", privateKey: Buffer.alloc(32, 5).toString("base64url"), publicKey: "x" }));
		server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				seen.push({ method: req.method!, path: req.url!, authorized: /^Bearer \S+\.\S+\.\S+$/.test(req.headers.authorization ?? "") });
				const send = (status: number, body?: unknown) => {
					res.writeHead(status, { "content-type": "application/json" });
					res.end(body === undefined ? "" : JSON.stringify(body));
				};
				const match = /^\/v1\/rules(?:\/([^/]+?)(?:\/(pause|resume))?)?$/.exec(req.url!);
				if (!match) return send(404, { code: "not_found", detail: "no route" });
				const [, name, action] = match;
				if (!name) return send(200, shape === "ok" ? { rules: [...store.values()] } : { items: [] });
				if (req.method === "DELETE") return store.delete(name) ? send(204) : send(404, { code: "not_found", detail: "no rule" });
				if (action) {
					const rule = store.get(name)!;
					store.set(name, { ...rule, status: action === "pause" ? "paused" : "active" });
					return send(200, store.get(name));
				}
				const spec = JSON.parse(Buffer.concat(chunks).toString()) as RuleSpec;
				store.set(name, view(name, { ...spec, status: spec.status ?? "active" }));
				return send(200, store.get(name));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});
	after(() => server.close());

	const env = () => ({ SOMEWORK_URL: url, SOMEWORK_RULES_KEY_FILE: keyFile });
	const dir = () => rulesDir({ ...declared("a"), ...declared("b") });

	it("signs every request, applies, and a second apply makes no writes", async () => {
		seen.length = 0;
		const first = await invoke(["apply", "--dir", dir()], { env: env() });
		assert.equal(first.code, 0, first.err);
		assert.deepEqual([...store.keys()].sort(), ["a", "b"]);
		assert.ok(seen.every((request) => request.authorized));
		assert.deepEqual(seen.filter((request) => request.method === "PUT").map((request) => request.path).sort(), ["/v1/rules/a", "/v1/rules/b"]);
		seen.length = 0;
		const second = await invoke(["apply", "--dir", dir()], { env: env() });
		assert.equal(second.code, 0);
		assert.deepEqual(seen.filter((request) => request.method !== "GET"), []);
	});

	it("keeps a rule paused at runtime paused through a later apply", async () => {
		store.set("a", { ...store.get("a")!, status: "paused" });
		const changed = rulesDir({ ...declared("a", (yaml) => yaml.replace("wake: false", "wake: true")), ...declared("b") });
		const result = await invoke(["apply", "--dir", changed], { env: env() });
		assert.equal(result.code, 0, result.err);
		assert.equal(store.get("a")!.status, "paused");
		assert.equal(store.get("a")!.wake, true);
	});

	it("exits 2 without writing when the domain answers with an unexpected shape", async () => {
		shape = "broken";
		seen.length = 0;
		const result = await invoke(["apply", "--dir", dir()], { env: env() });
		shape = "ok";
		assert.equal(result.code, 2);
		assert.match(result.err, /unexpected answer to a rule list/);
		assert.deepEqual(seen.filter((request) => request.method !== "GET"), []);
	});

	it("exits 2 when the domain is unreachable", async () => {
		const result = await invoke(["plan", "--dir", dir()], { env: { SOMEWORK_URL: "http://127.0.0.1:1", SOMEWORK_RULES_KEY_FILE: keyFile } });
		assert.equal(result.code, 2);
		assert.match(result.err, /failed:/);
	});
});
