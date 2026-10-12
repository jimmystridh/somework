import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "smoke-cluster.sh");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const TAG = "ci-0123456";
const TOKEN = "s3cr3t-service-token";

const profile = (version: string): string => JSON.stringify({ schema: 1, role: "reviewer", agentId: "agent/reviewer", version, capabilities: [{ id: "code.review", version: "3" }], hash: "abc" });
const ready = JSON.stringify({ ready: true, failed: [], handlers: [] });

type Answer = { code?: number; body?: string; failFirst?: number };

/** A directory with fake `curl` (canned answers by URL, every call logged with the header file it was given) and `sleep`, and the files an inventory can point at. */
function rig(answers: Record<string, Answer>) {
	const root = mkdtempSync(join(tmpdir(), "smoke-"));
	const bin = join(root, "bin");
	const responses = join(root, "responses");
	mkdirSync(bin);
	mkdirSync(responses);
	const keyOf = (url: string): string => url.replace(/[^A-Za-z0-9]/g, "_");
	for (const [url, answer] of Object.entries(answers)) {
		writeFileSync(join(responses, `${keyOf(url)}.code`), String(answer.code ?? 200));
		writeFileSync(join(responses, `${keyOf(url)}.body`), answer.body ?? "{}");
		if (answer.failFirst) writeFileSync(join(responses, `${keyOf(url)}.fail`), String(answer.failFirst));
	}
	const write = (path: string, text: string, mode?: number) => {
		writeFileSync(path, text);
		if (mode) chmodSync(path, mode);
	};
	write(
		join(bin, "curl"),
		`#!/bin/sh
out=""; url=""; header=""; cacert=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2;;
    -H) header=\${2#@}; shift 2;;
    --cacert) cacert=$2; shift 2;;
    -m|-w) shift 2;;
    -*) shift;;
    *) url=$1; shift;;
  esac
done
key=$(echo "$url" | tr -c 'A-Za-z0-9\\n' _)
echo "curl $url" >> "${root}/calls.log"
[ -z "$header" ] || cat "$header" >> "${root}/headers.log"
[ -z "$cacert" ] || echo "$cacert" >> "${root}/cacerts.log"
[ -f "${responses}/$key.code" ] || { printf 000; exit 7; }
if [ -f "${responses}/$key.fail" ]; then
  left=$(cat "${responses}/$key.fail")
  if [ "$left" -gt 0 ]; then echo $((left - 1)) > "${responses}/$key.fail"; printf 000; exit 7; fi
fi
cat "${responses}/$key.body" > "$out"
printf '%s' "$(cat "${responses}/$key.code")"
`,
		0o755,
	);
	write(join(bin, "sleep"), `#!/bin/sh\necho slept >> "${root}/sleeps.log"\nexit 0\n`, 0o755);
	write(join(root, "ops.token"), `${TOKEN}\n`);
	write(join(root, "empty.token"), "\n");
	write(join(root, "ca.pem"), "ca\n");
	const inventory = (text: string): string => {
		const file = join(root, "inventory");
		write(file, text.replaceAll("@ROOT@", root));
		return file;
	};
	const run = (args: string[]) => spawnSync("sh", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}` } });
	const log = (name: string): string[] => (existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8").trim().split("\n") : []);
	return { root, inventory, run, calls: () => log("calls.log"), headers: () => log("headers.log"), cacerts: () => log("cacerts.log"), sleeps: () => log("sleeps.log") };
}

const healthy: Record<string, Answer> = {
	"http://10.0.0.1:8081/ready": { body: ready },
	"http://10.0.0.1:8081/profile": { body: profile(TAG) },
	"http://10.0.0.1:8082/ready": { body: ready },
	"http://10.0.0.1:8082/profile": { body: profile(TAG) },
	"http://10.0.0.1:7080/status": { body: '{"handlers":[]}' },
	"http://10.0.0.1:8090/healthz": { body: "ok" },
	"https://ops.internal:9444/fleet/api/ops/me": { body: '{"email":"agent/smoke","role":"viewer","auth":"service"}' },
};

const full = `# the pilot
agent pi-agent http://10.0.0.1:8081
agent reviewer http://10.0.0.1:8082/

manager manager http://10.0.0.1:7080
hub events-hub http://10.0.0.1:8090/healthz
operations operations https://ops.internal:9444 token_file=@ROOT@/ops.token ca_file=@ROOT@/ca.pem
`;

describe("smoke-cluster.sh", () => {
	it("passes when every agent is ready on the expected version and the Manager, the hub and Operations answer", () => {
		const r = rig(healthy);
		const out = r.run([r.inventory(full), "--version", TAG]);
		assert.equal(out.status, 0, out.stdout + out.stderr);
		assert.match(out.stdout, /ok {3}pi-agent: ready, version ci-0123456\n/);
		assert.match(out.stdout, /ok {3}reviewer: ready, version ci-0123456\n/);
		assert.match(out.stdout, /ok {3}manager: \/status answers\n/);
		assert.match(out.stdout, /ok {3}events-hub: answers\n/);
		assert.match(out.stdout, /ok {3}operations: service token accepted as agent\/smoke \(viewer\)\n/);
		assert.match(out.stdout, /all 5 checks passed/);
		assert.deepEqual(r.calls(), [
			"curl http://10.0.0.1:8081/ready",
			"curl http://10.0.0.1:8081/profile",
			"curl http://10.0.0.1:8082/ready",
			"curl http://10.0.0.1:8082/profile",
			"curl http://10.0.0.1:7080/status",
			"curl http://10.0.0.1:8090/healthz",
			"curl https://ops.internal:9444/fleet/api/ops/me",
		]);
	});

	it("lists every failure instead of stopping at the first, and exits non-zero", () => {
		const r = rig({
			...healthy,
			"http://10.0.0.1:8081/ready": { code: 503, body: JSON.stringify({ ready: false, failed: ["sandbox"] }) },
			"http://10.0.0.1:8082/profile": { body: profile("ci-aaaaaaa") },
			"http://10.0.0.1:7080/status": { code: 500 },
			"https://ops.internal:9444/fleet/api/ops/me": { code: 401 },
		});
		const inventory = r.inventory(`${full}hub gone http://10.0.0.1:9999/healthz\n`);
		const out = r.run([inventory, "--version", TAG, "--wait", "0"]);
		assert.equal(out.status, 1);
		assert.match(out.stdout, /FAIL pi-agent: \/ready answered 503, not 200/);
		assert.match(out.stdout, /FAIL reviewer: \/profile reports version ci-aaaaaaa, expected ci-0123456/);
		assert.match(out.stdout, /FAIL manager: \/status answered 500, not 200/);
		assert.match(out.stdout, /FAIL operations: \/fleet\/api\/ops\/me answered 401/);
		assert.match(out.stdout, /FAIL gone: no answer from http:\/\/10\.0\.0\.1:9999\/healthz/);
		assert.match(out.stdout, /ok {3}events-hub: answers/, "what works is still reported");
		assert.match(out.stderr, /5 of 6 checks failed:/);
		for (const name of ["pi-agent (http://10.0.0.1:8081)", "reviewer (http://10.0.0.1:8082)", "manager (http://10.0.0.1:7080)", "operations (https://ops.internal:9444)", "gone (http://10.0.0.1:9999/healthz)"]) {
			assert.ok(out.stderr.includes(name), `${name} is in the list at the end:\n${out.stderr}`);
		}
	});

	it("does not take a 200 for ready when the body says ready: false", () => {
		const r = rig({ ...healthy, "http://10.0.0.1:8081/ready": { code: 200, body: '{"ready":false,"failed":["sandbox"]}' } });
		const out = r.run([r.inventory("agent pi-agent http://10.0.0.1:8081\n"), "--version", TAG, "--wait", "0"]);
		assert.equal(out.status, 1);
		assert.match(out.stdout, /FAIL pi-agent: \/ready answered 200 but not "ready": true/);
	});

	it("derives the version from the commit the way deploy-from-ci.sh tags the images", () => {
		const r = rig(healthy);
		assert.equal(r.run([r.inventory(full), "--sha", SHA]).status, 0);
		const wrong = r.run([r.inventory(full), "--sha", `${"f".repeat(7)}${SHA.slice(7)}`, "--wait", "0"]);
		assert.equal(wrong.status, 1);
		assert.match(wrong.stdout, /expected ci-fffffff/);
	});

	it("does not compare versions without --version or --sha, nor for an agent that says version=skip", () => {
		const r = rig({ ...healthy, "http://10.0.0.1:8082/profile": { body: profile("unknown") } });
		const none = r.run([r.inventory("agent pi-agent http://10.0.0.1:8081\n")]);
		assert.equal(none.status, 0, none.stdout);
		assert.match(none.stdout, /ready, version ci-0123456 \(not compared\)/);
		const skipped = r.run([r.inventory("agent reviewer http://10.0.0.1:8082 version=skip\n"), "--version", "ci-bbbbbbb"]);
		assert.equal(skipped.status, 0, skipped.stdout);
		assert.match(skipped.stdout, /version unknown \(not compared\)/);
		const checked = r.run([r.inventory("agent reviewer http://10.0.0.1:8082\n"), "--version", "ci-bbbbbbb", "--wait", "0"]);
		assert.equal(checked.status, 1);
	});

	it("reads the version of the agent, not the version of a capability", () => {
		const body = JSON.stringify({ schema: 1, role: "x", agentId: "agent/x", version: "ci-1111111", capabilities: [{ id: "a", version: "ci-2222222" }] });
		const r = rig({ "http://10.0.0.1:8081/ready": { body: ready }, "http://10.0.0.1:8081/profile": { body } });
		assert.equal(r.run([r.inventory("agent x http://10.0.0.1:8081\n"), "--version", "ci-1111111", "--wait", "0"]).status, 0);
		assert.equal(r.run([r.inventory("agent x http://10.0.0.1:8081\n"), "--version", "ci-2222222", "--wait", "0"]).status, 1);
	});

	it("keeps trying a failing check for --wait seconds, and fails it only after that", () => {
		const slow = { ...healthy, "http://10.0.0.1:8081/ready": { body: ready, failFirst: 2 } };
		const r = rig(slow);
		const out = r.run([r.inventory("agent pi-agent http://10.0.0.1:8081\n"), "--version", TAG, "--wait", "9"]);
		assert.equal(out.status, 0, out.stdout + out.stderr);
		assert.equal(r.sleeps().length, 2, "two pauses before the third try worked");
		const impatient = rig(slow);
		assert.equal(impatient.run([impatient.inventory("agent pi-agent http://10.0.0.1:8081\n"), "--version", TAG, "--wait", "0"]).status, 1);
		assert.deepEqual(impatient.sleeps(), [], "no pause with --wait 0");
		const never = rig({});
		const out2 = never.run([never.inventory("agent pi-agent http://10.0.0.1:8081\n"), "--wait", "6"]);
		assert.equal(out2.status, 1);
		assert.equal(never.calls().length, 3, "tried 3 times in 6 seconds");
	});

	it("sends the service token in a header file and never on a command line, and passes the CA file", () => {
		const r = rig(healthy);
		assert.equal(r.run([r.inventory(full), "--version", TAG]).status, 0);
		assert.deepEqual(r.headers(), [`x-operations-service-token: ${TOKEN}`]);
		assert.ok(!r.calls().some((call) => call.includes(TOKEN)));
		assert.deepEqual(r.cacerts(), [join(r.root, "ca.pem")]);
	});

	it("fails the Operations check, and only that one, when the token file is missing or empty", () => {
		const r = rig(healthy);
		for (const file of ["nowhere.token", "empty.token"]) {
			const out = r.run([r.inventory(`agent pi-agent http://10.0.0.1:8081\noperations operations https://ops.internal:9444 token_file=@ROOT@/${file}\n`), "--version", TAG, "--wait", "0"]);
			assert.equal(out.status, 1);
			assert.match(out.stdout, /ok {3}pi-agent/);
			assert.match(out.stdout, /FAIL operations: (cannot read the token file|the token file .* is empty)/);
		}
		assert.ok(!r.calls().includes("curl https://ops.internal:9444/fleet/api/ops/me"));
	});

	it("rejects a bad inventory with the line numbers, before it asks anything", () => {
		const r = rig(healthy);
		const out = r.run([
			r.inventory("# header\nagent ok http://10.0.0.1:8081\nserver x http://10.0.0.1:1\nagent y ftp://10.0.0.1\nagent z http://10.0.0.1:8082 colour=red\nagent short\noperations o https://ops.internal\nagent q http://10.0.0.1/;id\n"),
		]);
		assert.equal(out.status, 2);
		assert.match(out.stderr, /inventory line 3: unknown kind server/);
		assert.match(out.stderr, /inventory line 4: the URL must start with http/);
		assert.match(out.stderr, /inventory line 5: unknown option colour=red/);
		assert.match(out.stderr, /inventory line 6: expected: KIND NAME URL/);
		assert.match(out.stderr, /inventory line 7: operations needs token_file=PATH/);
		assert.match(out.stderr, /inventory line 8: the URL holds a character that is not allowed/);
		assert.deepEqual(r.calls(), []);
		const empty = r.run([r.inventory("# nothing\n\n")]);
		assert.equal(empty.status, 2);
		assert.match(empty.stderr, /lists nothing to check/);
	});

	it("refuses odd calls", () => {
		const r = rig(healthy);
		const inventory = r.inventory(full);
		for (const args of [[], [inventory, "--sha", "abc"], [inventory, "--sha", SHA.toUpperCase()], [inventory, "--version", "ci 1; id"], [inventory, "--wait", "soon"], [inventory, "--nope"], [inventory, "other"], [join(r.root, "missing")], [inventory, "--version"]]) {
			assert.equal(r.run(args).status, 2, args.join(" "));
		}
		assert.deepEqual(r.calls(), []);
	});

	it("prints its usage on --help", () => {
		const r = rig({});
		const out = r.run(["--help"]);
		assert.equal(out.status, 0);
		assert.match(out.stdout, /scripts\/smoke-cluster\.sh INVENTORY \[--version TAG \| --sha COMMIT\] \[--wait SECONDS\] \[--help\]/);
		assert.match(out.stdout, /operations NAME URL token_file=PATH/);
		assert.match(out.stdout, /Exit status/);
	});
});
