import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { approvalPolicy, PLANE_TOOL_NAMES, validateProfile } from "@somework/agent-kit";
import { repoRoot, startDomain } from "../../../sdk/typescript/test/harness.ts";
import card from "../card.json" with { type: "json" };
import { CHAT_INSTRUCTIONS } from "../src/chat.ts";
import { NOT_A_JOB, createProductManagerHooks } from "../src/hooks.ts";
import { profile } from "../src/profile.ts";
import { SYSTEM_PROMPT } from "../src/prompt.ts";

const here = new URL(".", import.meta.url).pathname;
const binary = process.env.SOMEWORK_BIN ?? join(repoRoot, "dist/somework");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The tools the kit adds to every conversation, and the ones a deployment switches on. */
const THREAD_TOOLS = ["agents_list", "agents_search", "message_send", "job_status", "job_stop", "resources", "attachment_get", "run_recall", "agent_status", "skill_library"];
const WATCH_TOOLS = ["watch_pull_request", "list_pull_request_watches", "unwatch_pull_request"];

describe("the card", () => {
	const capability = card.capabilities[0]!;
	it("is the product manager's, with one conversation capability", () => {
		assert.equal(card.agentId, "agent/product-manager");
		assert.deepEqual(card.capabilities.map((entry) => [entry.id, entry.version, entry.sideEffects]), [["product.intake", "1", "write"]]);
		assert.match(capability.description, /not a job/);
		assert.match(capability.description, /approved its exact text/);
	});

	it("says what the agent cannot do", () => {
		assert.match(card.description, /only reads/);
		assert.match(card.description, /never sets a ticket's priority, assignee or state/);
	});

	it("is accepted and approved by the domain's own card validation", { skip: existsSync(binary) ? false : `no domain binary at ${binary}: set SOMEWORK_BIN` }, async () => {
		const domain = await startDomain({ cardFile: join(here, "../card.json") });
		cleanups.push(() => domain.close());
		assert.ok(domain.url.startsWith("http://127.0.0.1:"));
	});
});

describe("the profile", () => {
	it("is valid and serves what the card offers", () => {
		assert.doesNotThrow(() => validateProfile(profile));
		assert.equal(profile.id, "product-manager");
		assert.deepEqual(profile.capabilities, [{ id: "product.intake", version: "1" }]);
	});

	it("is read-only: nothing is pushed, there is no pull request, no events, no repository skills", () => {
		assert.deepEqual(profile.allowedTools, ["read", "bash"]);
		assert.deepEqual(profile.git, { push: false, pullRequest: false, branchPrefix: "product" });
		assert.equal(profile.events?.enabled, false);
		assert.deepEqual(profile.skills.allow, []);
	});

	it("lets only people approve a ticket, and gives them time", () => {
		assert.deepEqual(profile.chat?.approvers, ["kind:human"]);
		assert.equal(profile.chat?.approvalMinutes, 30);
	});

	it("asks for the exact ticket before filing it, and for nothing else of Plane", () => {
		const policy = approvalPolicy([], profile.approvalPatterns, profile.toolApprovals);
		const asked = policy.needsApproval("plane_create", { title: "Add a thing", description: "Why", kind: "feature" });
		assert.match(String(asked), /file this ticket in Plane \(feature\): Add a thing\n\nWhy/);
		for (const name of ["plane_search", "plane_get", "plane_comment"]) assert.equal(policy.needsApproval(name, { ticket: "A-1" }), undefined, name);
		assert.equal(policy.needsApproval("bash", { command: "rm -rf /workspace" }), undefined, "the guard refuses a command; nobody is asked about it");
	});
});

describe("the prompt", () => {
	it("names only tools that exist, and every Plane tool", () => {
		const known = new Set([...profile.allowedTools!, ...PLANE_TOOL_NAMES, ...THREAD_TOOLS, ...WATCH_TOOLS]);
		const mentioned = [...SYSTEM_PROMPT.matchAll(/\b([a-z]+_[a-z_]+)\b/g)].map((match) => match[1]!);
		assert.ok(mentioned.length > 5);
		for (const name of mentioned) assert.ok(known.has(name), `the prompt names ${name}, which is not a tool`);
		for (const name of PLANE_TOOL_NAMES) assert.ok(SYSTEM_PROMPT.includes(name), `the prompt explains ${name}`);
	});

	it("tells the model to interview with grill-me, to ask the agents at most three times, and who approves", () => {
		assert.match(SYSTEM_PROMPT, /library skill grill-me/);
		assert.match(SYSTEM_PROMPT, /at most three times per interview/);
		assert.match(SYSTEM_PROMPT, /Only a human's yes approves a ticket/);
		assert.match(SYSTEM_PROMPT, /no priority and no assignee/);
		assert.match(SYSTEM_PROMPT, /product fit, design and concept/);
		assert.match(SYSTEM_PROMPT, /data from outside/);
		assert.match(CHAT_INSTRUCTIONS, /one interview per conversation/);
	});

	it("does not contain a secret, an address or a key", () => {
		for (const text of [SYSTEM_PROMPT, CHAT_INSTRUCTIONS, JSON.stringify(card)]) {
			assert.doesNotMatch(text, /ghp_|github_pat_|BEGIN [A-Z ]*PRIVATE|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|AKIA|xox[bp]-/);
		}
	});
});

describe("the hooks", () => {
	it("refuse a task: the capability is a conversation", () => {
		const hooks = createProductManagerHooks({});
		assert.throws(() => hooks.prepareInput!({ request: "x" }, { taskId: "t", log: () => undefined }), new RegExp(NOT_A_JOB));
	});

	it("read the repository the deployment names, and none otherwise", () => {
		assert.deepEqual(createProductManagerHooks({ CHAT_REPOSITORY_URL: "https://github.com/acme/somework", CHAT_REPOSITORY_REF: "main" }).chat?.checkout?.(), { repoUrl: "https://github.com/acme/somework", ref: "main" });
		assert.equal(createProductManagerHooks({}).chat?.checkout, undefined);
	});
});

describe("the interview skill kept for Operations", () => {
	const skill = readFileSync(join(here, "../operations/grill-me/SKILL.md"), "utf8");

	it("fits the library (one SKILL.md of at most 64 KiB), is named like its library entry and says where it came from", () => {
		assert.ok(Buffer.byteLength(skill) <= 64 * 1024);
		assert.match(skill, /^---\nname: grill-me\ndescription: [^\n]+\n---\n/);
		assert.match(skill, /github\.com\/mattpocock\/skills.*commit [0-9a-f]{40}.*MIT/);
	});

	it("keeps the upstream method (rounds, frontier, recommended answers, facts are the agent's job) and ends in a ticket", () => {
		for (const part of ["design tree", "frontier", "➡️", 'so "yes" accepts', "Finding _facts_ is your job", "at most three times", "nothing left silently assumed", "plane_create"]) assert.ok(skill.includes(part), part);
		assert.doesNotMatch(skill, /sub-agent to find/);
	});

	it("contains no secret and no address", () => {
		assert.doesNotMatch(skill, /ghp_|github_pat_|BEGIN [A-Z ]*PRIVATE|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|AKIA|xox[bp]-/);
	});
});
