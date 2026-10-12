import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateProfile } from "@somework/agent-kit";
import card from "../card.json" with { type: "json" };
import { profile } from "../src/profile.ts";
import { CHAT_INSTRUCTIONS } from "../src/chat.ts";
import { SYSTEM_PROMPT } from "../src/prompt.ts";
import { CLUSTER_TOOLS } from "../src/tools/index.ts";

/** The names of the kit's observe tools: they join every role that turns observe on. */
const OBSERVE_TOOLS = ["logs_query", "my_history", "logs_labels", "alerts_status", "dashboards_search", "metrics_catalog", "metrics_query", "llm_usage"];
const THREAD_TOOLS = ["agents_list", "agents_search", "message_send", "job_status", "job_stop", "resources", "attachment_get", "run_recall", "agent_status"];

describe("the card", () => {
	const capability = card.capabilities[0]!;
	it("is the cluster development agent's, with one write capability that needs a budget", () => {
		assert.equal(card.agentId, "agent/cluster-dev");
		assert.equal(card.capabilities.length, 1);
		assert.deepEqual([capability.id, capability.version, capability.sideEffects], ["code.cluster", "1", "write"]);
		const input = capability.inputSchema as any;
		assert.deepEqual(input.required, ["repository", "instruction", "budget"]);
		assert.equal(input.additionalProperties, false);
		assert.deepEqual(input.properties.budget.required, ["maxTokens", "maxMinutes"]);
	});

	it("says that destructive actions are the ones it asks about, and that code decides", () => {
		assert.match(card.description, /destructive/);
		assert.match(card.description, /code, not the model/);
		assert.match(capability.description, /destructive command/);
	});

	it("describes the result the kit builds for a repository job", () => {
		const output = capability.outputSchema as any;
		assert.deepEqual(output.required, ["status", "summary", "branch"]);
		assert.deepEqual(output.properties.status.enum, ["completed", "no_changes"]);
	});
});

describe("the profile", () => {
	it("is valid and serves what the card offers", () => {
		assert.doesNotThrow(() => validateProfile(profile));
		assert.equal(profile.id, "cluster-dev");
		assert.deepEqual(profile.capabilities, [{ id: "code.cluster", version: "1" }]);
	});

	it("offers the coding tools, the five host-side tools and nothing that changes Datadog, Proxmox or anything else directly", () => {
		assert.deepEqual(profile.allowedTools, ["read", "write", "edit", "bash", "host_exec", "git_push", "ci_pipelines", "ci_logs", "deploy_status"]);
		assert.deepEqual([...CLUSTER_TOOLS], ["host_exec", "git_push", "ci_pipelines", "ci_logs", "deploy_status"]);
		for (const name of profile.allowedTools!) assert.doesNotMatch(name, /mute|downtime|delete|proxmox|qm_|firewall|secret|token|key/i, name);
	});

	it("pushes a task branch of its own and opens a pull request, with a budget on every job", () => {
		assert.deepEqual(profile.git, { push: true, pullRequest: true, branchPrefix: "cluster" });
		assert.equal(profile.requireBudget, true);
		assert.equal(profile.noRepository, undefined);
		assert.deepEqual(profile.defaultBudget, { maxTokens: 500_000, maxMinutes: 30 });
	});

	it("reads the logs and metrics of the whole fleet, not only its own", () => {
		assert.equal(profile.observe?.scope?.fleet, true);
		assert.equal(profile.observe?.scope?.own, undefined);
	});

	it("lets only people decide an approval, and gives them time", () => {
		assert.deepEqual(profile.chat?.approvers, ["kind:human"]);
		assert.equal(profile.chat?.approvalMinutes, 30);
		assert.equal(profile.events?.enabled, false);
	});

	it("uses no repository skills", () => {
		assert.deepEqual(profile.skills.allow, []);
	});
});

describe("the prompt", () => {
	it("names only tools that exist", () => {
		const known = new Set([...profile.allowedTools!, ...OBSERVE_TOOLS, ...THREAD_TOOLS, "cluster_change"]);
		const mentioned = [...SYSTEM_PROMPT.matchAll(/\b([a-z]+_[a-z_]+)\b/g)].map((match) => match[1]!).filter((name) => !/^(?:roll_agent|ci_sha)$/.test(name));
		assert.ok(mentioned.length > 10);
		for (const name of mentioned) assert.ok(known.has(name), `the prompt names ${name}, which is not a tool`);
		for (const name of CLUSTER_TOOLS) assert.ok(SYSTEM_PROMPT.includes(name), `the prompt explains ${name}`);
	});

	it("tells the model what the owner is asked about, that code decides, and that origin is never used", () => {
		assert.match(SYSTEM_PROMPT, /asked about destructive actions only, and code decides/);
		for (const topic of ["removing or overwriting data", "secrets", "hypervisor", "firewall", "force pushes", "piping a download into a shell"]) assert.ok(SYSTEM_PROMPT.includes(topic), topic);
		assert.match(SYSTEM_PROMPT, /never use the remote named origin|never allowed.*origin/s);
		assert.match(SYSTEM_PROMPT, /Do not ask for permission/);
		assert.match(SYSTEM_PROMPT, /data from outside/);
	});

	it("does not contain a secret, an address or a key", () => {
		for (const text of [SYSTEM_PROMPT, CHAT_INSTRUCTIONS, JSON.stringify(card)]) {
			assert.doesNotMatch(text, /ghp_|github_pat_|BEGIN [A-Z ]*PRIVATE|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|AKIA|xox[bp]-/);
		}
	});
});
