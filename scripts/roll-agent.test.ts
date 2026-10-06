import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "deploy", "agents", "roll-agent.sh");

/** A stack directory plus fake `docker`, `curl` and `sleep`: docker records the tag it was started with, curl answers by a switch file. */
function rig(options: { readyWhen: (tag: string) => boolean }) {
	const root = mkdtempSync(join(tmpdir(), "roll-"));
	const bin = join(root, "bin");
	const stack = join(root, "stack");
	for (const dir of [bin, stack]) spawnSync("mkdir", ["-p", dir]);
	const write = (path: string, text: string, mode?: number) => {
		writeFileSync(path, text);
		if (mode) chmodSync(path, mode);
	};
	write(join(stack, "compose.yaml"), "services: {}\n# original\n");
	write(join(stack, ".env"), "OTHER=1\nAGENT_VERSION=pilot-1\nTAIL=x\n");
	write(join(bin, "docker"), `#!/bin/sh\nif [ "$1 $2" = "compose up" ]; then . ./.env; echo "$AGENT_VERSION $AIKIDO_RESEED_HANDLER" >> "${root}/started.log"; echo "$AGENT_VERSION" > "${root}/running"; exit 0; fi\nexit 0\n`, 0o755);
	write(join(bin, "curl"), `#!/bin/sh\nread tag < "${root}/running"\nif [ "$tag" = "pilot-2" ] && ${options.readyWhen("pilot-2")}; then exit 0; fi\nif [ "$tag" = "pilot-1" ]; then exit 0; fi\nexit 22\n`, 0o755);
	write(join(bin, "sleep"), "#!/bin/sh\nexit 0\n", 0o755);
	const run = (args: string[], env: Record<string, string> = {}) =>
		spawnSync("sh", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, READY_SECONDS: "9", ...env } });
	return { root, stack, run, started: () => readFileSync(join(root, "started.log"), "utf8").trim().split("\n") };
}

describe("roll-agent.sh", () => {
	it("sets the tag, starts the stack, and keeps backups of the old files", () => {
		const r = rig({ readyWhen: () => true });
		const out = r.run([r.stack, "AGENT_VERSION", "pilot-2", "http://agent/ready"]);
		assert.equal(out.status, 0, out.stderr);
		assert.match(out.stdout, /AGENT_VERSION pilot-1 -> pilot-2/);
		assert.equal(readFileSync(join(r.stack, ".env"), "utf8"), "OTHER=1\nAGENT_VERSION=pilot-2\nTAIL=x\n", "only the one variable changes");
		assert.equal(readFileSync(join(r.stack, ".env.before-pilot-2"), "utf8"), "OTHER=1\nAGENT_VERSION=pilot-1\nTAIL=x\n");
		assert.equal(readFileSync(join(r.stack, "compose.yaml.before-pilot-2"), "utf8"), "services: {}\n# original\n");
	});

	it("installs a new compose file and passes one-off settings to that start", () => {
		const r = rig({ readyWhen: () => true });
		writeFileSync(join(r.root, "new.yaml"), "services: {}\n# new\n");
		const out = r.run([r.stack, "AGENT_VERSION", "pilot-2", "http://agent/ready", join(r.root, "new.yaml")], { AIKIDO_RESEED_HANDLER: "1" });
		assert.equal(out.status, 0, out.stderr);
		assert.equal(readFileSync(join(r.stack, "compose.yaml"), "utf8"), "services: {}\n# new\n");
		assert.equal(r.started()[0], "pilot-2 1");
	});

	it("puts the old files back and restarts the old version when the agent does not become ready", () => {
		const r = rig({ readyWhen: () => false });
		writeFileSync(join(r.root, "new.yaml"), "services: {}\n# new\n");
		const out = r.run([r.stack, "AGENT_VERSION", "pilot-2", "http://agent/ready", join(r.root, "new.yaml")]);
		assert.equal(out.status, 1);
		assert.match(out.stderr, /going back to pilot-1/);
		assert.equal(readFileSync(join(r.stack, ".env"), "utf8"), "OTHER=1\nAGENT_VERSION=pilot-1\nTAIL=x\n");
		assert.equal(readFileSync(join(r.stack, "compose.yaml"), "utf8"), "services: {}\n# original\n");
		assert.deepEqual(r.started().map((line) => line.split(" ")[0]), ["pilot-2", "pilot-1"], "the old version was started again");
	});

	it("keeps the first backup when the same tag is rolled twice", () => {
		const r = rig({ readyWhen: () => true });
		assert.equal(r.run([r.stack, "AGENT_VERSION", "pilot-2", "http://agent/ready"]).status, 0);
		assert.equal(r.run([r.stack, "AGENT_VERSION", "pilot-2", "http://agent/ready"]).status, 0);
		assert.match(readFileSync(join(r.stack, ".env.before-pilot-2"), "utf8"), /AGENT_VERSION=pilot-1/, "the second run must not overwrite the backup with the new state");
	});

	it("sets every variable of a stack that runs images of more than one tag, and restores them all", () => {
		const r = rig({ readyWhen: () => false });
		writeFileSync(join(r.stack, ".env"), "AGENT_VERSION=pilot-1\nSANDBOX_VERSION=pilot-1\nOTHER=1\n");
		const failed = r.run([r.stack, "AGENT_VERSION,SANDBOX_VERSION", "pilot-2", "http://agent/ready"]);
		assert.equal(failed.status, 1);
		assert.equal(readFileSync(join(r.stack, ".env"), "utf8"), "AGENT_VERSION=pilot-1\nSANDBOX_VERSION=pilot-1\nOTHER=1\n", "both are back");
		const ok = rig({ readyWhen: () => true });
		writeFileSync(join(ok.stack, ".env"), "AGENT_VERSION=pilot-1\nSANDBOX_VERSION=pilot-1\nOTHER=1\n");
		assert.equal(ok.run([ok.stack, "AGENT_VERSION,SANDBOX_VERSION", "pilot-2", "http://agent/ready"]).status, 0);
		assert.equal(readFileSync(join(ok.stack, ".env"), "utf8"), "AGENT_VERSION=pilot-2\nSANDBOX_VERSION=pilot-2\nOTHER=1\n");
		assert.notEqual(ok.run([ok.stack, "AGENT_VERSION,,SANDBOX_VERSION", "pilot-3"]).status, 0);
		assert.notEqual(ok.run([ok.stack, "AGENT_VERSION,MISSING_VERSION", "pilot-3"]).status, 0);
	});

	it("refuses odd arguments before touching anything", () => {
		const r = rig({ readyWhen: () => true });
		for (const args of [[r.stack, "agent_version", "pilot-2"], [r.stack, "AGENT_VERSION", "pilot 2; rm -rf /"], [r.stack, "MISSING_VERSION", "pilot-2"], [join(r.root, "nowhere"), "AGENT_VERSION", "pilot-2"], [r.stack]]) {
			assert.notEqual(r.run(args).status, 0, args.join(" "));
		}
		assert.equal(existsSync(join(r.stack, ".env.before-pilot-2")), false);
		assert.equal(existsSync(join(r.root, "started.log")), false, "nothing was started");
	});
});
