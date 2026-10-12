import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "deploy", "agents", "roll-agent.sh");

interface Options {
	newVersionReady?: boolean;
	runningJobPolls?: number;
	upFails?: boolean;
	touchFails?: boolean;
	removeFails?: boolean;
	throwAwayRemoveFails?: boolean;
}

/**
 * A stack directory with fake `docker`, `curl` and `sleep`. `docker compose exec` and `run` act on a real state directory of the temp tree (DRAIN_STATE_DIR
 * points at it, so the path inside the "container" is the path here), and every docker call, metrics poll and start is logged in order together with whether
 * the drain file existed at that moment.
 */
function rig(options: Options = {}) {
	const root = mkdtempSync(join(tmpdir(), "roll-drain-"));
	const bin = join(root, "bin");
	const stack = join(root, "stack");
	const state = join(root, "state");
	for (const dir of [bin, stack, state]) mkdirSync(dir);
	const drainFile = join(state, "drain");
	const order = join(root, "order.log");
	const write = (path: string, text: string) => {
		writeFileSync(path, text);
		chmodSync(path, 0o755);
	};
	writeFileSync(join(stack, "compose.yaml"), "services: {}\n");
	writeFileSync(join(stack, ".env"), "AGENT_VERSION=pilot-1\n");
	writeFileSync(join(root, "running"), "pilot-1\n");
	const present = `$([ -e "${drainFile}" ] && echo present || echo absent)`;
	write(
		join(bin, "docker"),
		`#!/bin/sh
echo "docker $* (drain file: ${present})" >> "${order}"
case "$1 $2" in
  "compose up")
    ${options.upFails ? "exit 1" : ""}
    . ./.env
    echo "$AGENT_VERSION" > "${root}/running"
    exit 0;;
  "compose exec")
    shift 4
    case "$1" in
      touch) ${options.touchFails ? "exit 1" : ":"};;
      rm) ${options.removeFails ? "exit 1" : ":"};;
    esac
    exec "$@";;
  "compose run")
    ${options.throwAwayRemoveFails ? "exit 1" : ""}
    for last; do :; done
    rm -f "$last"
    exit 0;;
esac
exit 0
`,
	);
	write(
		join(bin, "curl"),
		`#!/bin/sh
case "$*" in
  */metrics*)
    echo "curl metrics (drain file: ${present})" >> "${order}"
    polls=$(cat "${root}/polls" 2>/dev/null || echo 0)
    echo $((polls + 1)) > "${root}/polls"
    if [ "$polls" -lt ${options.runningJobPolls ?? 0} ]; then echo 'somework_jobs{agent="agent/qa",state="running"} 1'; else echo 'somework_jobs{agent="agent/qa",state="running"} 0'; fi
    exit 0;;
esac
read tag < "${root}/running"
[ "$tag" = pilot-1 ] || ${options.newVersionReady === false ? "false" : "true"}
`,
	);
	write(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
	const env = (extra: Record<string, string> = {}) => ({ PATH: `${bin}:${process.env.PATH}`, READY_SECONDS: "9", DRAIN_STATE_DIR: state, ...extra });
	const args = [stack, "AGENT_VERSION", "pilot-2", "http://agent/ready"];
	return {
		root,
		bin,
		stack,
		state,
		drainFile,
		write,
		env,
		args,
		run: (extra: Record<string, string> = {}) => spawnSync("sh", [SCRIPT, ...args], { encoding: "utf8", env: env(extra) }),
		calls: () => (existsSync(order) ? readFileSync(order, "utf8").trim().split("\n") : []),
		removals: () => (existsSync(order) ? readFileSync(order, "utf8").split("\n").filter((line) => /exec -T agent rm|compose run/.test(line)) : []),
	};
}

describe("roll-agent.sh with DRAIN_SERVICE", () => {
	it("makes the drain file, waits for the running jobs while it exists, replaces the agent drained and removes the file as soon as the new container runs", () => {
		const r = rig({ runningJobPolls: 2 });
		const out = r.run({ DRAIN_SERVICE: "agent" });
		assert.equal(out.status, 0, out.stderr);
		assert.match(out.stderr, /draining: the agent starts no new job/);
		assert.deepEqual(r.calls(), [
			`docker compose exec -T agent touch ${r.drainFile} (drain file: absent)`,
			"curl metrics (drain file: present)",
			"curl metrics (drain file: present)",
			"curl metrics (drain file: present)",
			"docker compose up -d (drain file: present)",
			`docker compose exec -T agent rm -f ${r.drainFile} (drain file: present)`,
		]);
		assert.equal(existsSync(r.drainFile), false);
	});

	it("drains nothing without DRAIN_SERVICE", () => {
		const r = rig();
		assert.equal(r.run().status, 0);
		assert.ok(!r.calls().some((line) => line.includes("exec") || line.includes("compose run")), r.calls().join("\n"));
	});

	it("removes the file when the new version does not become ready and the old one is started again", () => {
		const r = rig({ newVersionReady: false });
		const out = r.run({ DRAIN_SERVICE: "agent" });
		assert.equal(out.status, 1);
		assert.match(out.stderr, /going back to pilot-1/);
		assert.equal(existsSync(r.drainFile), false, "the agent is not left drained");
		assert.equal(r.removals().length, 1, "the file was already gone when the old version was started");
	});

	it("removes the file when docker compose up itself fails", () => {
		const r = rig({ upFails: true });
		const out = r.run({ DRAIN_SERVICE: "agent" });
		assert.notEqual(out.status, 0);
		assert.equal(existsSync(r.drainFile), false);
		assert.equal(r.removals().length, 1);
	});

	it("takes the state directory of the container from DRAIN_STATE_DIR, /state by default", () => {
		const r = rig();
		assert.equal(r.run({ DRAIN_SERVICE: "agent", DRAIN_STATE_DIR: r.state }).status, 0);
		assert.ok(r.calls()[0]!.startsWith(`docker compose exec -T agent touch ${r.state}/drain`));
		const defaults = rig({ touchFails: true });
		const env = { ...defaults.env({ DRAIN_SERVICE: "agent" }) } as Record<string, string | undefined>;
		delete env.DRAIN_STATE_DIR;
		spawnSync("sh", [SCRIPT, ...defaults.args], { encoding: "utf8", env });
		assert.ok(defaults.calls()[0]!.startsWith("docker compose exec -T agent touch /state/drain"));
	});

	it("removes the file with a throw-away container when the agent container cannot be reached", () => {
		const r = rig({ removeFails: true });
		const out = r.run({ DRAIN_SERVICE: "agent" });
		assert.equal(out.status, 0, out.stderr);
		assert.ok(r.calls().some((line) => line.startsWith("docker compose run --rm --no-deps -T --entrypoint rm agent -f ")), r.calls().join("\n"));
		assert.equal(existsSync(r.drainFile), false);
	});

	it("says so, and does not fail a roll that worked, when the file cannot be removed at all", () => {
		const r = rig({ removeFails: true, throwAwayRemoveFails: true });
		const out = r.run({ DRAIN_SERVICE: "agent" });
		assert.equal(out.status, 0, out.stderr);
		assert.match(out.stderr, /could not be removed: remove it by hand/);
	});

	it("rolls on, only waiting for the jobs, when the drain file cannot be made", () => {
		const r = rig({ touchFails: true, runningJobPolls: 1 });
		const out = r.run({ DRAIN_SERVICE: "agent" });
		assert.equal(out.status, 0, out.stderr);
		assert.match(out.stderr, /could not drain/);
		assert.deepEqual(r.removals(), [], "there is nothing to remove");
	});

	it("removes the file when the script is stopped while it waits for jobs", async () => {
		const r = rig({ runningJobPolls: 1_000_000 });
		r.write(join(r.bin, "sleep"), "#!/bin/sh\nexec /bin/sleep 0.05\n");
		const child = spawn("sh", [SCRIPT, ...r.args], { env: r.env({ DRAIN_SERVICE: "agent", IDLE_SECONDS: "3600" }) });
		const closed = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
		for (let waited = 0; !existsSync(r.drainFile) && waited < 100; waited++) await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(existsSync(r.drainFile), true, "the agent is drained while the script waits");
		child.kill("SIGTERM");
		assert.equal(await closed, 143);
		assert.equal(existsSync(r.drainFile), false, "stopping the roll does not leave the agent drained");
	});
});
