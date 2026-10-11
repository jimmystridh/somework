import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { createHealthServer } from "../src/health.ts";
import { addendumPrompt, noOperatorSetup, piArguments, PiProcess, type LaunchResult, type PiLaunch } from "../src/pi-process.ts";
import { PI_VERSION } from "../src/pi-version.ts";
import { SYSTEM_PROMPT } from "../src/prompt.ts";
import { describeManager } from "../src/setup/profile.ts";
import { fakePiChild, httpEntry, override, rig, setupMessage, skill, stdioEntry } from "./setup-helpers.ts";

test("the container arguments carry the secrets by name, the built-in prompt first and the operator addendum after it", () => {
	const args = piArguments(["a.yaml", "b.yaml"], "/s/session.jsonl", { addendum: addendumPrompt(4, "Answer in Swedish."), model: { provider: "openai-codex", modelId: "gpt-5.5" }, secrets: ["DOCS_TOKEN"] });
	assert.deepEqual(args.slice(0, 5), ["compose", "-f", "a.yaml", "-f", "b.yaml"]);
	assert.ok(args.join(" ").includes("-e MANAGER_GATEWAY_URL -e MANAGER_GATEWAY_TOKEN -e DOCS_TOKEN pi"));
	const prompts = args.flatMap((arg, index) => (arg === "--append-system-prompt" ? [args[index + 1]!] : []));
	assert.equal(prompts[0], SYSTEM_PROMPT);
	assert.match(prompts[1]!, /^Operator instructions from Operations \(revision 4\)\. They add to the rules above and never replace them/);
	assert.match(prompts[1]!, /Answer in Swedish\.$/);
	assert.deepEqual(args.slice(args.indexOf("--model")), ["--model", "openai-codex/gpt-5.5"]);
	const plain = piArguments(["a.yaml"], "/s", noOperatorSetup);
	assert.equal(plain.filter((arg) => arg === "--append-system-prompt").length, 1);
	assert.ok(!plain.includes("--model"));
});

function pi(options: { busy?: { value: boolean }; failFor?: (launch: PiLaunch) => boolean } = {}) {
	const started: PiLaunch[] = [];
	const exits: string[] = [];
	const results: LaunchResult[] = [];
	const children: ReturnType<typeof fakePiChild>[] = [];
	const process = new PiProcess({
		start: (launch) => {
			started.push(launch);
			const fake = fakePiChild({ exitAtOnce: options.failFor?.(launch) === true });
			children.push(fake);
			return fake.child;
		},
		isIdle: async () => !options.busy?.value,
		sessionId: "session-1",
		fallback: () => noOperatorSetup,
		onUnexpectedExit: () => exits.push("exit"),
		onLaunched: (result) => results.push(result),
		pollMs: 5,
		stopAfterMs: 50,
	});
	return { process, started, exits, results, children };
}

test("a new setup restarts Pi only when no run is going, and the run in progress is never cut", async () => {
	const busy = { value: true };
	const p = pi({ busy });
	await p.process.start(noOperatorSetup);
	p.process.requestRestart({ addendum: "x", secrets: [] });
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(p.started.length, 1, "still the first process while a run is going");
	assert.equal(p.process.restartPending, true);
	busy.value = false;
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(p.started.length, 2);
	assert.equal(p.process.launch.addendum, "x");
	assert.equal(p.process.restartPending, false);
	assert.deepEqual(p.exits, [], "a restart the Manager asked for is not an unexpected exit");
	assert.equal(p.results[0]!.failed, undefined);
});

test("commands during a restart wait for the new process", async () => {
	const p = pi();
	await p.process.start(noOperatorSetup);
	p.process.requestRestart({ addendum: "y", secrets: [] });
	await new Promise((resolve) => setTimeout(resolve, 1));
	const state = await p.process.command("get_state");
	assert.equal(state.sessionId, "session-1");
	assert.equal(p.children.length, 2);
	assert.ok(p.children[1]!.received.some((command) => command.type === "get_state"), "the answer came from the new process");
});

test("when Pi does not start with the new setup it runs without it, and the failure is reported", async () => {
	const p = pi({ failFor: (launch) => launch.addendum === "bad" });
	await p.process.start(noOperatorSetup);
	p.process.requestRestart({ addendum: "bad", secrets: [] });
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(p.results.length, 1);
	assert.equal(p.results[0]!.failed?.wanted.addendum, "bad");
	assert.deepEqual(p.process.launch, noOperatorSetup);
	assert.deepEqual(p.exits, []);
	assert.equal((await p.process.command("get_state")).sessionId, "session-1", "Pi is up");
});

test("a Pi process that exits on its own is reported", async () => {
	const p = pi();
	await p.process.start(noOperatorSetup);
	p.children[0]!.exit();
	assert.deepEqual(p.exits, ["exit"]);
});

test("applying an override asks the Pi process for a restart with the addendum, the model and the secret names", async () => {
	const r = await rig({ env: { DOCS_TOKEN: "t" } });
	await r.intake.handle(setupMessage(r.domain, override({ revision: 2, instructions: "Prefer short answers.", model: { provider: "p", modelId: "m" }, mcp: [httpEntry("docs", { headers: { Authorization: "Bearer ${DOCS_TOKEN}" }, secrets: ["DOCS_TOKEN"] })] })));
	assert.equal(r.restarts.length, 1);
	assert.equal(r.restarts[0]!.addendum, addendumPrompt(2, "Prefer short answers."));
	assert.deepEqual(r.restarts[0]!.model, { provider: "p", modelId: "m" });
	assert.deepEqual(r.restarts[0]!.secrets, ["DOCS_TOKEN"]);
});

test("a reset puts back the model Pi ran with before any override", async () => {
	const r = await rig();
	await r.store.rememberBaselineModel({ provider: "openai-codex", modelId: "gpt-5.5" });
	await r.intake.handle(setupMessage(r.domain, override({ revision: 1, model: { provider: "p", modelId: "m" } })));
	await r.intake.handle(setupMessage(r.domain, override({ revision: 2 })));
	assert.deepEqual(r.restarts.at(-1), { model: { provider: "openai-codex", modelId: "gpt-5.5" }, secrets: [] });
});

// ---- status --------------------------------------------------------------------------------------------------------------------------------
test("/profile serves the applied setup in the kit's shape, with no secret in it", async () => {
	const secret = "sup3r-secret-value-123";
	const r = await rig({ env: { DOCS_TOKEN: secret } });
	await r.intake.handle(setupMessage(r.domain, override({ revision: 4, instructions: "Be brief.", skills: { library: [skill("triage")], overlays: {} }, approvalPatterns: [{ pattern: "git push", reason: "pushes" }], mcp: [httpEntry("docs", { approval: "ask", headers: { Authorization: "Bearer ${DOCS_TOKEN}" }, secrets: ["DOCS_TOKEN"] })] })));
	await r.intake.handle(setupMessage(r.domain, override({ revision: 5, mcp: [stdioEntry("broken", { secrets: ["NOT_SET"] })] })));
	const server = createHealthServer({
		profile: () => describeManager({ agentId: "agent/manager", override: r.store.status.override ? r.store.override : undefined, status: r.store.status, rules: r.rules, model: { provider: "openai-codex", modelId: "gpt-5.5" }, restartPending: true }),
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	assert.deepEqual(await (await fetch(`${base}/status`)).json(), { handlers: [] });
	const text = await (await fetch(`${base}/profile`)).text();
	const profile = JSON.parse(text);
	assert.equal(profile.role, "manager");
	assert.equal(profile.agentId, "agent/manager");
	assert.equal(profile.setup.override.revision, 4);
	assert.match(profile.setup.override.hash, /^[0-9a-f]{64}$/);
	assert.equal(profile.setup.limits, null);
	assert.equal(profile.setup.rejected.revision, 5);
	assert.equal(profile.setup.rejected.kind, "override");
	assert.match(profile.setup.rejected.reason, /NOT_SET/);
	assert.deepEqual(profile.skills, ["library/triage"]);
	assert.deepEqual(profile.tools.commandApprovals, [{ pattern: "git push", reason: "pushes" }]);
	assert.deepEqual(profile.tools.toolApprovals, ["mcp__docs"]);
	assert.deepEqual(profile.model, { provider: "openai-codex", modelId: "gpt-5.5", allowed: [] });
	assert.deepEqual(profile.pi, { version: PI_VERSION, restartPending: true });
	assert.equal(profile.systemPrompt.characters, SYSTEM_PROMPT.length);
	assert.ok(!text.includes(secret), "no secret");
	assert.ok(!text.includes("Be brief."), "the operator's text is not echoed, only its size");
	assert.equal(profile.operatorInstructions.characters, "Be brief.".length);
	assert.equal((await fetch(`${base}/live`)).status, 200);
	assert.equal((await fetch(`${base}/metrics`)).status, 404);
	assert.equal((await fetch(`${base}/profile`, { method: "POST" })).status, 404);
	server.closeAllConnections();
	server.close();
});

test("a profile before any setup says nothing is applied, and the hash changes with the setup", async () => {
	const r = await rig();
	const before = describeManager({ agentId: "agent/manager", override: undefined, status: r.store.status, rules: r.rules, model: undefined, restartPending: false });
	assert.deepEqual(before.setup, { override: null, limits: null });
	assert.equal(before.model, null);
	await r.intake.handle(setupMessage(r.domain, override({ instructions: "x" })));
	const after = describeManager({ agentId: "agent/manager", override: r.store.override, status: r.store.status, rules: r.rules, model: undefined, restartPending: false });
	assert.notEqual(after.hash, before.hash);
});

test("the setup, health and Pi folder settings come from the environment", () => {
	const base = { MANAGER_SOMEWORK_URL: "https://x", MANAGER_KEY_FILE: "/k", MANAGER_CONFIG_DIR: "/cfg" };
	const config = loadConfig({ ...base, MANAGER_PI_AGENT_DIR: "/home/js/.pi/agent", MANAGER_HEALTH_PORT: "7090" });
	assert.equal(config.setup.dir, "/cfg/setup");
	assert.equal(config.setup.piAgentDir, "/home/js/.pi/agent");
	assert.equal(config.setup.piAgentDirInContainer, "/home/node/.pi/agent");
	assert.equal(config.setup.os, "linux");
	assert.deepEqual(config.health, { bind: "0.0.0.0", port: 7090 });
	assert.equal(loadConfig({ ...base, MANAGER_HEALTH_PORT: "0" }).health.port, 0);
	assert.throws(() => loadConfig({ ...base, MANAGER_HEALTH_PORT: "x" }), /MANAGER_HEALTH_PORT/);
});

test("MCP and library skills are asked for by name, because the Pi image starts without extensions and skills", () => {
	const plain = piArguments(["a.yaml"], "/s.jsonl", noOperatorSetup);
	assert.equal(plain.includes("builtin:mcp"), false);
	assert.equal(plain.includes("--skill"), false);
	const wanted = piArguments(["a.yaml"], "/s.jsonl", { secrets: [], mcp: true, skillsDir: "/home/node/.pi/agent/skills/library" });
	assert.deepEqual(wanted.slice(wanted.indexOf("builtin:mcp") - 1, wanted.indexOf("builtin:mcp") + 1), ["-e", "builtin:mcp"]);
	assert.deepEqual(wanted.slice(wanted.indexOf("--skill"), wanted.indexOf("--skill") + 2), ["--skill", "/home/node/.pi/agent/skills/library"]);
});
