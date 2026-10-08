import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "deploy", "observability", "alloy", "install-metrics.sh");

const BASE = `logging { level = "warn" }
loki.write "central" {
  endpoint {
    url = "https://10.10.10.13:9443/loki/api/v1/push"
    basic_auth { username = "102"
      password_file = "/etc/agent-cluster-logging/writer-password"
    }
    tls_config { ca_file = "/etc/agent-cluster-logging/ca.crt" }
  }
}
loki.source.journal "system" {
  labels = { cluster="agent-cluster", host="admin-cloud-agents", vm_id="102", os="linux", source="journal" }
  forward_to = [loki.write.central.receiver]
}
`;

function run(targets: string[], options: { validate?: string; check?: string; config?: string } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "metrics-"));
	const file = join(dir, "config.alloy");
	writeFileSync(file, options.config ?? BASE);
	const again = () =>
		spawnSync("bash", [SCRIPT, ...targets], {
			encoding: "utf8",
			env: { ...process.env, ALLOY_CONFIG: file, VALIDATE: options.validate ?? "true", RESTART: "true", CHECK: options.check ?? "true", SETTLE: "0" },
		});
	return { file, again, read: () => readFileSync(file, "utf8") };
}

describe("install-metrics.sh", () => {
	it("adds a block with the host's identity, its write account and the agent targets", () => {
		const rig = run(["pi-agent=10.10.10.11:8081", "reviewer=10.10.10.11:8082"]);
		const result = rig.again();
		assert.equal(result.status, 0, result.stderr);
		const text = rig.read();
		assert.ok(text.startsWith(BASE), "the logging configuration is untouched");
		assert.match(text, /url = "https:\/\/10\.10\.10\.13:9443\/api\/v1\/write"/);
		assert.match(text, /username = "102"/);
		assert.match(text, /password_file = "\/etc\/agent-cluster-logging\/writer-password"/);
		assert.match(text, /external_labels = \{ cluster = "agent-cluster", host = "admin-cloud-agents", vm_id = "102", os = "linux" \}/);
		assert.match(text, /\{ __address__ = "10\.10\.10\.11:8081", stack = "pi-agent" \},\n\s+\{ __address__ = "10\.10\.10\.11:8082", stack = "reviewer" \},\n/);
		assert.match(text, /prometheus\.exporter\.unix "node"/);
	});

	it("replaces its own block when run again and keeps one copy", () => {
		const rig = run(["a=127.0.0.1:8081"]);
		assert.equal(rig.again().status, 0);
		const second = rig.again();
		assert.equal(second.status, 0, second.stderr);
		const text = rig.read();
		assert.equal(text.split("// begin metrics").length, 2);
		assert.equal(text.split("// end metrics").length, 2);
		assert.equal(text.split(`prometheus.remote_write "central"`).length, 2);
	});

	it("works without agent targets (a host with only host metrics)", () => {
		const rig = run([]);
		assert.equal(rig.again().status, 0);
		assert.ok(!rig.read().includes("somework-agent"));
	});

	it("puts the previous configuration back when it does not validate or Alloy does not stay up", () => {
		for (const options of [{ validate: "false" }, { check: "false" }]) {
			const rig = run(["a=127.0.0.1:8081"], options);
			const result = rig.again();
			assert.notEqual(result.status, 0);
			assert.equal(rig.read(), BASE);
		}
	});

	it("refuses a target that is not a plain name and address", () => {
		for (const bad of ["a=host", "A=127.0.0.1:1", "a=127.0.0.1:80;rm", 'a="x"=1.1.1.1:8081']) {
			const rig = run([bad]);
			const result = rig.again();
			assert.notEqual(result.status, 0, bad);
			assert.equal(rig.read(), BASE);
		}
	});

	it("stops when the configuration has no write account to reuse", () => {
		const rig = run([], { config: 'logging { level = "warn" }\n' });
		assert.notEqual(rig.again().status, 0);
	});
});
