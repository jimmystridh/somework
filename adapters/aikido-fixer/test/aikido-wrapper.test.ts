import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const wrapper = new URL("../sandbox/aikido-wrapper.cjs", import.meta.url).pathname;
const SECRET = "s3cr3t-value-that-must-never-show-up";
const CLIENT_ID = "AIK_CLIENT_test";

function rig(clientFile?: string | null) {
	const dir = mkdtempSync(join(tmpdir(), "aikido-wrapper-"));
	const record = join(dir, "record.txt");
	const binary = join(dir, "aikido-real");
	writeFileSync(binary, `#!/bin/sh\nenv > "$FAKE_RECORD"\nprintf 'args:%s\\n' "$*" >> "$FAKE_RECORD"\nif [ "$1" = "stdin" ]; then cat; fi\nif [ "$1" = "exit" ]; then exit "$2"; fi\necho "the issues"\necho "a warning" >&2\n`);
	chmodSync(binary, 0o755);
	const client = join(dir, "client.json");
	if (clientFile !== null) writeFileSync(client, clientFile ?? JSON.stringify({ clientId: CLIENT_ID, clientSecret: SECRET }));
	const run = (args: string[], env: Record<string, string> = {}, input?: string) =>
		spawnSync("node", [wrapper, ...args], { encoding: "utf8", input, env: { PATH: process.env.PATH!, AIKIDO_CLI_BINARY: binary, AIKIDO_SANDBOX_CLIENT_FILE: client, FAKE_RECORD: record, ...env } });
	const recorded = (): Map<string, string> => new Map(readFileSync(record, "utf8").split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
	return { dir, binary, client, run, recorded, record };
}

describe("the aikido wrapper of the sandbox", () => {
	it("starts the real CLI with the client from the mounted file, the arguments untouched, and no extra flags", () => {
		const { run, recorded, record } = rig();
		const result = run(["issue-ignore", "42", "--reason", "false positive"]);
		assert.equal(result.status, 0);
		assert.equal(result.stdout, "the issues\n");
		const env = recorded();
		assert.equal(env.get("AIKIDO_CLIENT_ID"), CLIENT_ID);
		assert.equal(env.get("AIKIDO_CLIENT_SECRET"), SECRET);
		assert.match(readFileSync(record, "utf8"), /args:issue-ignore 42 --reason false positive/);
	});

	it("takes region and workspace from the file, or leaves the CLI's own default", () => {
		const withBoth = rig(JSON.stringify({ client_id: CLIENT_ID, client_secret: SECRET, region: "us", workspace: "admin" }));
		withBoth.run(["issues"]);
		assert.equal(withBoth.recorded().get("AIKIDO_REGION"), "us");
		assert.equal(withBoth.recorded().get("AIKIDO_WORKSPACE"), "admin");
		const plain = rig();
		plain.run(["issues"]);
		assert.equal(plain.recorded().has("AIKIDO_REGION"), false);
		assert.equal(plain.recorded().has("AIKIDO_WORKSPACE"), false);
		const inherited = rig();
		inherited.run(["issues"], { AIKIDO_REGION: "me" });
		assert.equal(inherited.recorded().get("AIKIDO_REGION"), "me");
	});

	it("lets nothing else of the AIKIDO_ environment reach the CLI: the file is the one source of credentials", () => {
		const { run, recorded } = rig();
		run(["issues"], { AIKIDO_CLIENT_ID: "other", AIKIDO_CLIENT_SECRET: "other-secret", AIKIDO_TOKEN_FILE: "/tmp/token", AIKIDO_WORKSPACE: "elsewhere", AIKIDO_SOMETHING: "x" });
		const env = recorded();
		assert.equal(env.get("AIKIDO_CLIENT_ID"), CLIENT_ID);
		assert.equal(env.get("AIKIDO_CLIENT_SECRET"), SECRET);
		for (const name of ["AIKIDO_TOKEN_FILE", "AIKIDO_WORKSPACE", "AIKIDO_SOMETHING", "AIKIDO_CLI_BINARY", "AIKIDO_SANDBOX_CLIENT_FILE"]) assert.equal(env.has(name), false, name);
		assert.equal(env.get("FAKE_RECORD") !== undefined, true, "everything that is not AIKIDO_ passes on (the proxy settings among it)");
	});

	it("never prints the secret itself, not even when the file is broken", () => {
		const good = rig().run(["issues"]);
		assert.ok(!good.stdout.includes(SECRET) && !good.stderr.includes(SECRET));
		for (const content of [`{"clientId": "${CLIENT_ID}", "clientSecret": "${SECRET}"`, `["${SECRET}"]`, JSON.stringify({ clientId: "", clientSecret: SECRET }), JSON.stringify({ clientSecret: SECRET }), JSON.stringify({ clientId: CLIENT_ID, clientSecret: SECRET, region: SECRET }), JSON.stringify({ clientId: CLIENT_ID, clientSecret: SECRET, workspace: 7 })]) {
			const result = rig(content).run(["issues"]);
			assert.equal(result.status, 78, content);
			assert.ok(!result.stdout.includes(SECRET) && !result.stderr.includes(SECRET), content);
			assert.match(result.stderr, /^aikido: /);
		}
	});

	it("says plainly that there are no credentials when the file is missing, empty or not the expected shape", () => {
		const missing = rig(null).run(["issues"]);
		assert.equal(missing.status, 78);
		assert.match(missing.stderr, /no Aikido credentials are mounted in this sandbox \(.*client\.json: ENOENT\)/);
		const empty = rig("").run(["issues"]);
		assert.equal(empty.status, 78);
		assert.match(empty.stderr, /client\.json is empty/);
		assert.match(rig("not json").run(["issues"]).stderr, /is not valid JSON/);
		assert.match(rig("{}").run(["issues"]).stderr, /needs clientId and clientSecret/);
		assert.match(rig(JSON.stringify({ clientId: "a", clientSecret: "b", region: "mars" })).run(["issues"]).stderr, /unknown region \(use eu, us, me\)/);
	});

	it("says plainly that the CLI is not installed when the binary is missing or the mount is the /dev/null default", () => {
		const { run } = rig();
		for (const binary of [join(tmpdir(), "no-such-aikido-binary"), "/dev/null"]) {
			const result = run(["issues"], { AIKIDO_CLI_BINARY: binary });
			assert.equal(result.status, 69, binary);
			assert.match(result.stderr, /the aikido CLI is not installed in this sandbox/);
			assert.ok(!result.stderr.includes(SECRET));
		}
	});

	it("passes the CLI's exit status, output and standard input through", () => {
		const { run } = rig();
		assert.equal(run(["exit", "3"]).status, 3);
		const result = run(["issues"]);
		assert.equal(result.stderr, "a warning\n");
		assert.equal(run(["stdin"], {}, "from the model\n").stdout, "from the model\nthe issues\n");
	});
});
