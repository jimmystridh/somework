import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { gunzipSync } from "node:zlib";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "build-ops-image.sh");
const seconds = (offset: number): Date => new Date(Date.now() + offset * 1000);

/** A repository tree with the dashboard's inputs, and fake `dx`, `docker` and `ssh` that record what they were asked and where. */
function rig(options: { bundle?: "current" | "stale" | "missing"; withoutDx?: boolean; dockerFails?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "ops-image-"));
	const bin = join(root, "bin");
	const repository = join(root, "repository");
	mkdirSync(bin);
	const put = (path: string, text: string, mode?: number) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
		if (mode) chmodSync(path, mode);
	};
	mkdirSync(join(repository, "scripts"), { recursive: true });
	copyFileSync(SCRIPT, join(repository, "scripts", "build-ops-image.sh"));
	const sources = ["ui/src/main.rs", "ui/Cargo.toml", "shared/src/lib.rs", "shared/Cargo.toml", "public/style.css", "Dioxus.toml", "Cargo.toml", "Cargo.lock"];
	for (const file of sources) put(join(repository, "dashboard", file), `// ${file}\n`);
	for (const file of [...sources, "ui/src", "shared/src", "public"]) utimesSync(join(repository, "dashboard", file), seconds(-100), seconds(-100));
	if (options.bundle && options.bundle !== "missing") {
		put(join(repository, "dashboard", "bundle", "index.html"), "old bundle\n");
		utimesSync(join(repository, "dashboard", "bundle", "index.html"), seconds(-50), seconds(-50));
		if (options.bundle === "stale") utimesSync(join(repository, "dashboard", "ui", "src", "main.rs"), seconds(-10), seconds(-10));
	}
	const calls = join(root, "calls.log");
	if (!options.withoutDx) {
		put(join(bin, "dx"), `#!/bin/sh\necho "dx $* (in $(basename "$PWD"))" >> "${calls}"\nmkdir -p target/dx/fleet-ui/release/web/public\necho 'new bundle' > target/dx/fleet-ui/release/web/public/index.html\n`, 0o755);
	}
	put(join(bin, "docker"), `#!/bin/sh\necho "docker $* (in $(basename "$PWD"), buildkit=\${DOCKER_BUILDKIT:-})" >> "${calls}"\n${options.dockerFails ? 'case "$1" in build) exit 1;; esac' : ""}\n[ "$1" != save ] || echo "image bytes of $2"\nexit 0\n`, 0o755);
	put(join(bin, "ssh"), `#!/bin/sh\necho "ssh $*" >> "${calls}"\ncat > "${root}/received.gz"\n`, 0o755);
	const run = (args: string[]) => spawnSync("sh", [join(repository, "scripts", "build-ops-image.sh"), ...args], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } });
	return {
		repository,
		run,
		calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []),
		bundleIndex: () => readFileSync(join(repository, "dashboard", "bundle", "index.html"), "utf8"),
		bundleFile: (name: string) => join(repository, "dashboard", "bundle", name),
		received: () => gunzipSync(readFileSync(join(root, "received.gz"))).toString(),
	};
}

describe("build-ops-image.sh", () => {
	it("builds the bundle when it is missing, with the steps of the README, and then the image from the repository root", () => {
		const r = rig({ bundle: "missing" });
		const out = r.run(["v1"]);
		assert.equal(out.status, 0, out.stderr);
		assert.deepEqual(r.calls(), ["dx bundle --release --platform web --package fleet-ui (in dashboard)", "docker build -f dashboard/Dockerfile -t agent-cluster-fleet:v1 . (in repository, buildkit=1)"]);
		assert.equal(r.bundleIndex(), "new bundle\n");
		assert.equal(readFileSync(r.bundleFile("style.css"), "utf8"), "// public/style.css\n", "the style sheet is copied over what dx made");
		assert.match(out.stdout, /built agent-cluster-fleet:v1/);
	});

	it("leaves a current bundle as it is", () => {
		const r = rig({ bundle: "current" });
		assert.equal(r.run(["v2"]).status, 0);
		assert.deepEqual(r.calls(), ["docker build -f dashboard/Dockerfile -t agent-cluster-fleet:v2 . (in repository, buildkit=1)"]);
		assert.equal(r.bundleIndex(), "old bundle\n");
	});

	it("builds it again when a source is newer than the bundle", () => {
		const r = rig({ bundle: "stale" });
		assert.equal(r.run(["v3"]).status, 0);
		assert.ok(r.calls()[0]!.startsWith("dx bundle"), r.calls().join("\n"));
		assert.equal(r.bundleIndex(), "new bundle\n");
	});

	it("builds it again on request", () => {
		const r = rig({ bundle: "current" });
		assert.equal(r.run(["v4", "--rebuild-bundle"]).status, 0);
		assert.ok(r.calls()[0]!.startsWith("dx bundle"));
	});

	it("does not ship anything without --ship", () => {
		const r = rig({ bundle: "current" });
		r.run(["v5"]);
		assert.ok(!r.calls().some((call) => call.startsWith("docker save") || call.startsWith("ssh")));
	});

	it("ships the image with docker save | gzip | ssh HOST docker load", () => {
		const r = rig({ bundle: "current" });
		const out = r.run(["v6", "--ship", "js@services-vm"]);
		assert.equal(out.status, 0, out.stderr);
		assert.deepEqual(r.calls().slice(-2).map((call) => call.replace(/ \(in .*/, "")), ["docker save agent-cluster-fleet:v6", "ssh -o BatchMode=yes js@services-vm docker load"]);
		assert.equal(r.received(), "image bytes of agent-cluster-fleet:v6\n");
		assert.match(out.stdout, /loaded agent-cluster-fleet:v6 on js@services-vm/);
	});

	it("takes the options in any order, and has no default host", () => {
		const r = rig({ bundle: "current" });
		assert.equal(r.run(["--ship", "services-vm", "v7"]).status, 0);
		assert.ok(r.calls().some((call) => call === "ssh -o BatchMode=yes services-vm docker load"));
		assert.notEqual(r.run(["v7", "--ship"]).status, 0, "--ship without a host");
	});

	it("does not ship an image that did not build", () => {
		const r = rig({ bundle: "current", dockerFails: true });
		const out = r.run(["v8", "--ship", "services-vm"]);
		assert.notEqual(out.status, 0);
		assert.ok(!r.calls().some((call) => call.startsWith("ssh")));
	});

	it("says what is missing when dx is not installed, before it builds anything", () => {
		const r = rig({ bundle: "missing", withoutDx: true });
		const out = r.run(["v9"]);
		assert.equal(out.status, 1);
		assert.match(out.stderr, /dx is not installed/);
		assert.deepEqual(r.calls(), []);
	});

	it("does not need dx when the bundle is current", () => {
		const r = rig({ bundle: "current", withoutDx: true });
		assert.equal(r.run(["v10"]).status, 0);
	});

	it("prints its usage on --help and when it is given no tag", () => {
		const r = rig();
		const help = r.run(["--help"]);
		assert.equal(help.status, 0);
		assert.match(help.stdout, /scripts\/build-ops-image\.sh TAG \[--ship HOST\] \[--rebuild-bundle\] \[--help\]/);
		assert.match(help.stdout, /--ship HOST/);
		const none = r.run([]);
		assert.equal(none.status, 2);
		assert.match(none.stderr, /TAG/);
		assert.deepEqual(r.calls(), []);
	});

	it("refuses odd tags, hosts and options before it does anything", () => {
		const r = rig({ bundle: "missing" });
		for (const args of [["v 1"], ["v1; id"], ["a", "b"], ["v1", "--ship", "-oProxyCommand=id"], ["v1", "--ship", "host; id"], ["v1", "--ship", "a b"], ["v1", "--nope"]]) {
			assert.notEqual(r.run(args).status, 0, args.join(" "));
		}
		assert.deepEqual(r.calls(), []);
	});
});
