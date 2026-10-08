import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "deploy", "agents", "deploy-from-ci.sh");
const SHA = "0123456789abcdef0123456789abcdef01234567";

/** A pilot directory with a fake roll-agent.sh, and fake `docker` and `flock` that record what they were asked to do. */
function rig(options: { failRoll?: string; busy?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "deploy-"));
	const bin = join(root, "bin");
	const pilot = join(root, "pilot");
	mkdirSync(bin);
	mkdirSync(join(pilot, "bin"), { recursive: true });
	const write = (path: string, text: string) => {
		writeFileSync(path, text);
		chmodSync(path, 0o755);
	};
	write(join(bin, "docker"), `#!/bin/sh\necho "docker $*" >> "${root}/calls.log"\n`);
	write(join(bin, "flock"), options.busy ? "#!/bin/sh\nexit 1\n" : "#!/bin/sh\nexit 0\n");
	write(join(pilot, "bin", "roll-agent.sh"), `#!/bin/sh\necho "roll $(basename "$1") $2 $3 $4 $(cat "$5")" >> "${root}/calls.log"\n[ "$(basename "$1")" != "${options.failRoll ?? "-"}" ]\n`);
	const repository = join(root, "repository");
	for (const dir of ["adapters/pi", "adapters/reviewer", "adapters/aikido-fixer", "adapters/datadog-triage", "packages/events-hub"]) {
		mkdirSync(join(repository, dir, "deploy"), { recursive: true });
		writeFileSync(join(repository, dir, "deploy", "compose.yaml"), `# ${dir.split("/")[1]}\n`);
	}
	const archive = join(root, "repository.tgz");
	spawnSync("tar", ["czf", archive, "-C", repository, "."]);
	const run = (command: string, input = readFileSync(archive)) =>
		spawnSync("sh", [SCRIPT], { encoding: "utf8", input, env: { PATH: `${bin}:${process.env.PATH}`, PILOT_DIR: pilot, SSH_ORIGINAL_COMMAND: command } });
	const calls = () => (existsSync(join(root, "calls.log")) ? readFileSync(join(root, "calls.log"), "utf8").trim().split("\n") : []);
	return { run, calls, pilot };
}

describe("deploy-from-ci.sh", () => {
	it("builds every image as ci-<short sha> and rolls the hub, then the four agent stacks, with the repository's compose files", () => {
		const r = rig();
		const out = r.run(`deploy ${SHA}`);
		assert.equal(out.status, 0, out.stderr);
		const calls = r.calls();
		for (const image of ["somework-events-hub", "somework-pi-agent", "somework-pi-sandbox", "somework-pi-egress", "somework-reviewer", "somework-aikido-fixer", "somework-datadog-triage", "somework-datadog-triage-sandbox"]) {
			assert.ok(calls.some((call) => call.startsWith("docker build") && call.includes(`-t ${image}:ci-0123456`)), image);
		}
		assert.ok(calls.some((call) => call.includes("--build-arg SANDBOX_BASE=somework-pi-sandbox:ci-0123456")));
		assert.deepEqual(
			calls.filter((call) => call.startsWith("roll")).map((call) => call.replace(/ http\S* /, " ")),
			["roll events-hub HUB_VERSION ci-0123456 # events-hub", "roll datadog-triage DATADOG_VERSION ci-0123456 # datadog-triage", "roll reviewer REVIEWER_VERSION,SANDBOX_VERSION ci-0123456 # reviewer", "roll aikido-fixer FIXER_VERSION,SANDBOX_VERSION ci-0123456 # aikido-fixer", "roll pi-agent PI_VERSION ci-0123456 # pi"],
		);
		assert.match(calls.find((call) => call.startsWith("roll reviewer")) ?? "", /http:\/\/10\.10\.10\.11:8082\/ready/);
		assert.match(calls.find((call) => call.startsWith("roll events-hub")) ?? "", /http:\/\/10\.10\.10\.11:8090\/healthz/);
	});

	it("deploys nothing while the fleet is suspended", () => {
		const r = rig();
		writeFileSync(join(r.pilot, "SUSPENDED"), "2026-10-08T14:00:00Z\n");
		const out = r.run(`deploy ${SHA}`);
		assert.equal(out.status, 4);
		assert.match(out.stderr, /the fleet is suspended/);
		assert.deepEqual(r.calls(), [], "no image was built and no stack rolled");
	});

	it("stops at the first stack that does not become ready", () => {
		const r = rig({ failRoll: "reviewer" });
		const out = r.run(`deploy ${SHA}`);
		assert.notEqual(out.status, 0);
		assert.deepEqual(r.calls().filter((call) => call.startsWith("roll")).map((call) => call.split(" ")[1]), ["events-hub", "datadog-triage", "reviewer"]);
	});

	it("refuses anything but 'deploy' and a full commit hash, before it builds anything", () => {
		for (const command of ["", "ls", "deploy", "deploy main", "deploy 0123456", `deploy ${SHA.toUpperCase()}`, `deploy ${SHA}; id`, `deploy ${SHA} extra`, `deploy ../${SHA}`]) {
			const r = rig();
			assert.notEqual(r.run(command).status, 0, command);
			assert.deepEqual(r.calls(), [], command);
		}
	});

	it("does not start a second deployment while one runs", () => {
		const r = rig({ busy: true });
		const out = r.run(`deploy ${SHA}`);
		assert.equal(out.status, 3);
		assert.deepEqual(r.calls(), []);
	});
});
