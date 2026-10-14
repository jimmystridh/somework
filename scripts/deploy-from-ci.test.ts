import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "deploy", "agents", "deploy-from-ci.sh");
const SHA = "0123456789abcdef0123456789abcdef01234567";

/** A pilot directory with a fake roll-agent.sh, and fake `docker` and `flock` that record what they were asked to do. */
function rig(options: { failRoll?: string; busy?: boolean; jiraStack?: boolean; productManagerStack?: boolean; smokeInventory?: boolean; smokeFails?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "deploy-"));
	const bin = join(root, "bin");
	const pilot = join(root, "pilot");
	mkdirSync(bin);
	mkdirSync(join(pilot, "bin"), { recursive: true });
	if (options.jiraStack) {
		mkdirSync(join(pilot, "jira-triage"));
		writeFileSync(join(pilot, "jira-triage", "compose.yaml"), "name: somework-jira-triage\n");
	}
	if (options.productManagerStack) {
		mkdirSync(join(pilot, "product-manager"));
		writeFileSync(join(pilot, "product-manager", "compose.yaml"), "name: somework-product-manager\n");
	}
	const write = (path: string, text: string) => {
		writeFileSync(path, text);
		chmodSync(path, 0o755);
	};
	write(join(bin, "docker"), `#!/bin/sh\necho "docker $*" >> "${root}/calls.log"\n`);
	write(join(bin, "flock"), options.busy ? "#!/bin/sh\nexit 1\n" : "#!/bin/sh\nexit 0\n");
	write(join(pilot, "bin", "roll-agent.sh"), `#!/bin/sh\necho "roll $(basename "$1") $2 $3 $4 $(cat "$5")" >> "${root}/calls.log"\necho "$(basename "$1") \${DRAIN_SERVICE:-none}" >> "${root}/drain.log"\n[ "$(basename "$1")" != "${options.failRoll ?? "-"}" ]\n`);
	const repository = join(root, "repository");
	for (const dir of ["adapters/pi", "adapters/reviewer", "adapters/aikido-fixer", "adapters/datadog-triage", "adapters/jira-triage", "adapters/product-manager", "packages/events-hub"]) {
		mkdirSync(join(repository, dir, "deploy"), { recursive: true });
		writeFileSync(join(repository, dir, "deploy", "compose.yaml"), `# ${dir.split("/")[1]}\n`);
	}
	mkdirSync(join(repository, "scripts"));
	write(join(repository, "scripts", "smoke-cluster.sh"), `#!/bin/sh\necho "smoke $*" >> "${root}/calls.log"\n${options.smokeFails ? "echo 'FAIL pi-agent: not ready'; exit 1" : "exit 0"}\n`);
	if (options.smokeInventory) writeFileSync(join(pilot, "smoke.inventory"), "agent pi-agent http://10.10.10.11:8081\n");
	const archive = join(root, "repository.tgz");
	spawnSync("tar", ["czf", archive, "-C", repository, "."]);
	const run = (command: string, input = readFileSync(archive)) =>
		spawnSync("sh", [SCRIPT], { encoding: "utf8", input, env: { PATH: `${bin}:${process.env.PATH}`, PILOT_DIR: pilot, SSH_ORIGINAL_COMMAND: command } });
	const calls = () => (existsSync(join(root, "calls.log")) ? readFileSync(join(root, "calls.log"), "utf8").trim().split("\n") : []);
	const drains = () => (existsSync(join(root, "drain.log")) ? readFileSync(join(root, "drain.log"), "utf8").trim().split("\n") : []);
	return { run, calls, drains, pilot };
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

	it("has the agent stacks drain while they are replaced, in their `agent` service, and the hub not", () => {
		const r = rig({ jiraStack: true });
		assert.equal(r.run(`deploy ${SHA}`).status, 0);
		assert.deepEqual(r.drains(), ["events-hub none", "datadog-triage agent", "reviewer agent", "aikido-fixer agent", "jira-triage agent", "pi-agent agent"]);
	});

	it("skips the Jira triage stack until it exists on the host: no image is built for it and nothing is rolled", () => {
		const r = rig();
		const out = r.run(`deploy ${SHA}`);
		assert.equal(out.status, 0, out.stderr);
		assert.match(out.stdout, /jira-triage: no stack on this host yet, skipped/);
		assert.ok(!r.calls().some((call) => call.includes("jira-triage")), r.calls().join("\n"));
	});

	it("builds and rolls the Jira triage stack, with its own health port, once the host has it", () => {
		const r = rig({ jiraStack: true });
		const out = r.run(`deploy ${SHA}`);
		assert.equal(out.status, 0, out.stderr);
		const calls = r.calls();
		assert.ok(calls.some((call) => call.startsWith("docker build") && call.includes("-f adapters/jira-triage/Dockerfile --target agent -t somework-jira-triage:ci-0123456")));
		assert.deepEqual(
			calls.filter((call) => call.startsWith("roll")).map((call) => call.replace(/ http\S* /, " ")),
			["roll events-hub HUB_VERSION ci-0123456 # events-hub", "roll datadog-triage DATADOG_VERSION ci-0123456 # datadog-triage", "roll reviewer REVIEWER_VERSION,SANDBOX_VERSION ci-0123456 # reviewer", "roll aikido-fixer FIXER_VERSION,SANDBOX_VERSION ci-0123456 # aikido-fixer", "roll jira-triage TRIAGE_VERSION,SANDBOX_VERSION ci-0123456 # jira-triage", "roll pi-agent PI_VERSION ci-0123456 # pi"],
		);
		assert.match(calls.find((call) => call.startsWith("roll jira-triage")) ?? "", /http:\/\/10\.10\.10\.11:8085\/ready/);
	});

	it("skips the product manager stack until it exists on the host: no image is built for it and nothing is rolled", () => {
		const r = rig();
		const out = r.run(`deploy ${SHA}`);
		assert.equal(out.status, 0, out.stderr);
		assert.match(out.stdout, /product-manager: no stack on this host yet, skipped/);
		assert.ok(!r.calls().some((call) => call.includes("product-manager")), r.calls().join("\n"));
	});

	it("builds and rolls the product manager stack, with its own health port, once the host has it", () => {
		const r = rig({ productManagerStack: true });
		const out = r.run(`deploy ${SHA}`);
		assert.equal(out.status, 0, out.stderr);
		const calls = r.calls();
		assert.ok(calls.some((call) => call.startsWith("docker build") && call.includes("-f adapters/product-manager/Dockerfile --target agent -t somework-product-manager:ci-0123456")));
		assert.match(calls.find((call) => call.startsWith("roll product-manager")) ?? "", /roll product-manager PRODUCT_MANAGER_VERSION,SANDBOX_VERSION ci-0123456 http:\/\/10\.10\.10\.11:8086\/ready/);
		assert.ok(calls.findIndex((call) => call.startsWith("roll product-manager")) < calls.findIndex((call) => call.startsWith("roll pi-agent")), "it is rolled before the developer agent, with the other optional stack");
		assert.deepEqual(r.drains().filter((line) => line.startsWith("product-manager")), ["product-manager agent"]);
	});

	it("runs the smoke test after the last roll, for the tag it just rolled, when the host has an inventory", () => {
		const r = rig({ smokeInventory: true });
		const out = r.run(`deploy ${SHA}`);
		assert.equal(out.status, 0, out.stderr);
		const calls = r.calls();
		assert.equal(calls.filter((call) => call.startsWith("smoke")).length, 1);
		assert.equal(calls.at(-1), `smoke ${r.pilot}/smoke.inventory --version ci-0123456`);
		assert.ok(calls.findIndex((call) => call.startsWith("roll pi-agent")) < calls.findIndex((call) => call.startsWith("smoke")));
		assert.match(out.stdout, /deployed ci-0123456/);
	});

	it("fails with status 5 and says the code is deployed when the smoke test fails", () => {
		const r = rig({ smokeInventory: true, smokeFails: true });
		const out = r.run(`deploy ${SHA}`);
		assert.equal(out.status, 5);
		assert.match(out.stderr, /deployed ci-0123456, but the smoke test failed/);
		assert.equal(r.calls().filter((call) => call.startsWith("roll")).length, 5, "every stack was rolled: the smoke test does not undo anything");
	});

	it("skips the smoke test, and says so, without an inventory on the host", () => {
		const r = rig();
		const out = r.run(`deploy ${SHA}`);
		assert.equal(out.status, 0, out.stderr);
		assert.match(out.stdout, /smoke test skipped/);
		assert.ok(!r.calls().some((call) => call.startsWith("smoke")));
	});

	it("does not run the smoke test when a stack did not become ready", () => {
		const r = rig({ smokeInventory: true, failRoll: "reviewer" });
		assert.notEqual(r.run(`deploy ${SHA}`).status, 0);
		assert.ok(!r.calls().some((call) => call.startsWith("smoke")));
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
