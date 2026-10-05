import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { PiDurableRuntime } from "../src/pi-runtime.ts";
import { scriptedModels } from "../src/providers/faux.ts";
import { loadKnowledge, parseFrontMatter, parseSkillList, renderKnowledge, skillHash, skillsExtension } from "../src/skills.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "kit-skills-"));
const write = (root: string, path: string, text: string): void => {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), text);
};

const QA = "---\nname: verify-skill\ndescription: Verify frontend tickets in a browser.\n---\n# QA\nDo the thing.\n";
const REVIEW = "---\nname: review-skill\ndescription: >\n  Review someone else's pull request\n  against the ticket.\n---\n# Review\n";

function repo(): string {
	const root = tmp();
	write(root, "AGENTS.md", "# Rules\nAlways run the linter.\n");
	write(root, ".agents/skills/verify-skill/SKILL.md", QA);
	write(root, ".claude/skills/review-skill/SKILL.md", REVIEW);
	write(root, ".agents/skills/secret/SKILL.md", "---\nname: secret\ndescription: not for this agent\n---\n");
	return root;
}

describe("front matter", () => {
	it("reads name and description, single line, quoted and folded", () => {
		assert.deepEqual(parseFrontMatter(QA), { name: "verify-skill", description: "Verify frontend tickets in a browser." });
		assert.equal(parseFrontMatter(REVIEW).description, "Review someone else's pull request against the ticket.", "a folded description is joined, its marker dropped");
		assert.equal(parseFrontMatter("---\nname: z\ndescription: >\n---\n").description, undefined);
		assert.deepEqual(parseFrontMatter("---\nname: \"x\"\ndescription: 'a: b'\n---\n"), { name: "x", description: "a: b" });
		assert.deepEqual(parseFrontMatter("---\nname: y\ndescription: first\n  second line\n---\n"), { name: "y", description: "first second line" });
		assert.deepEqual(parseFrontMatter("no front matter"), {});
	});
});

describe("loadKnowledge", () => {
	it("exposes only allowed skills, from either directory, plus AGENTS.md", async () => {
		const root = repo();
		const knowledge = await loadKnowledge(new NodeExecutionEnv({ cwd: root }), root, { allow: ["verify-skill", "review-skill"] });
		assert.equal(knowledge.instructions?.includes("Always run the linter."), true);
		assert.deepEqual(knowledge.skills.map((s) => [s.name, s.source]), [["verify-skill", ".agents/skills"], ["review-skill", ".claude/skills"]]);
		assert.equal(knowledge.skills[0]!.path, `${root}/.agents/skills/verify-skill/SKILL.md`);
		assert.equal(knowledge.skills.find((s) => s.name === "secret"), undefined, "a skill that is not allowed is invisible");
		const prompt = renderKnowledge(knowledge)!;
		assert.match(prompt, /Always run the linter\./);
		assert.match(prompt, /- verify-skill: Verify frontend tickets in a browser\./);
		assert.doesNotMatch(prompt, /secret|not for this agent/);
	});

	it("reports an allowed skill that the repository does not have, and still works", async () => {
		const root = repo();
		const knowledge = await loadKnowledge(new NodeExecutionEnv({ cwd: root }), root, { allow: ["verify-skill", "absent"] });
		assert.equal(knowledge.skills.length, 1);
		assert.match(knowledge.warnings.join("\n"), /"absent".*not in the repository/);
		assert.match(renderKnowledge(knowledge)!, /"absent" is allowed for this agent but is not in the repository/);
	});

	it("refuses names that could leave the skills directory", async () => {
		const root = repo();
		write(root, "outside/SKILL.md", "---\nname: outside\ndescription: escaped\n---\n");
		const knowledge = await loadKnowledge(new NodeExecutionEnv({ cwd: root }), root, { allow: ["../../outside", "verify-skill/../../outside", "..", "Verify-Skill", "a b", ""] });
		assert.equal(knowledge.skills.length, 0);
		assert.equal(knowledge.warnings.length, 6);
		assert.throws(() => parseSkillList("verify-skill, ../x"), /lowercase/);
		assert.deepEqual(parseSkillList("verify-skill review-skill,verify-skill"), ["verify-skill", "review-skill"]);
	});

	it("reads through the given environment, not the host filesystem", async () => {
		const root = repo();
		const seen: string[] = [];
		const base = new NodeExecutionEnv({ cwd: root });
		const spy = {
			exists: (path: string, ctx: never) => (seen.push(path), base.exists(path, ctx)),
			readTextFile: (path: string, ctx: never) => (seen.push(path), base.readTextFile(path, ctx)),
		};
		await loadKnowledge(spy as never, root, { allow: ["verify-skill"] });
		assert.ok(seen.length >= 3 && seen.every((path) => path.startsWith(root)), seen.join("\n"));
		// an environment that has nothing: the host's real files are not consulted
		const empty = { exists: async () => ({ ok: true, value: false }), readTextFile: async () => ({ ok: false, error: new Error("none") }) };
		const nothing = await loadKnowledge(empty as never, root, { allow: ["verify-skill"] });
		assert.deepEqual([nothing.instructions, nothing.skills.length], [undefined, 0]);
	});

	it("applies size caps to instructions, descriptions, overlays and the whole section", async () => {
		const root = tmp();
		write(root, "AGENTS.md", "x".repeat(40_000));
		write(root, ".agents/skills/verify-skill/SKILL.md", `---\nname: verify-skill\ndescription: ${"d".repeat(2000)}\n---\n`);
		const knowledge = await loadKnowledge(new NodeExecutionEnv({ cwd: root }), root, { allow: ["verify-skill"], readOverlay: () => "o".repeat(100_000), limits: { maxInstructionsBytes: 1000, maxDescriptionChars: 50, maxOverlayBytes: 300 } });
		assert.ok(Buffer.byteLength(knowledge.instructions!) < 1100);
		assert.ok(knowledge.skills[0]!.description.length <= 52);
		assert.ok(knowledge.skills[0]!.overlay!.length < 340);
		const rendered = renderKnowledge(knowledge, { maxPromptBytes: 600 })!;
		assert.ok(Buffer.byteLength(rendered) < 700);
		assert.match(rendered, /cut\]$/);
	});
});

describe("overlays", () => {
	const hash = skillHash(QA);
	const overlay = (first: string | undefined) => (name: string) => (name === "verify-skill" ? `${first ? `${first}\n` : ""}Use headless Playwright instead of the Chrome extension.\n` : undefined);

	it("appends an overlay whose recorded hash matches, without a warning", async () => {
		const root = repo();
		const knowledge = await loadKnowledge(new NodeExecutionEnv({ cwd: root }), root, { allow: ["verify-skill"], readOverlay: overlay(`<!-- base-sha256: ${hash} -->`) });
		assert.deepEqual(knowledge.warnings, []);
		assert.equal(knowledge.skills[0]!.drifted, undefined);
		const prompt = renderKnowledge(knowledge)!;
		assert.match(prompt, /Adjustments for the skill "verify-skill"/);
		assert.match(prompt, /headless Playwright/);
		assert.doesNotMatch(prompt, /base-sha256/);
	});

	it("warns the model and the log when the repository's skill changed after the overlay was written", async () => {
		const root = repo();
		write(root, ".agents/skills/verify-skill/SKILL.md", `${QA}\nA new section.\n`);
		const logged: string[] = [];
		const knowledge = await loadKnowledge(new NodeExecutionEnv({ cwd: root }), root, { allow: ["verify-skill"], readOverlay: overlay(`<!-- base-sha256: ${hash} -->`) }, (_level, event, fields) => logged.push(`${event}: ${fields?.warning}`));
		assert.equal(knowledge.skills[0]!.drifted, true);
		assert.match(knowledge.warnings[0]!, /changed since its overlay was written/);
		assert.match(logged[0]!, /skills_warning/);
		assert.match(renderKnowledge(knowledge)!, /the repository's skill changed after this overlay was written/);
	});

	it("flags an overlay that does not record what it adjusts, and reads overlays from the overlay directory", async () => {
		const root = repo();
		const dir = tmp();
		write(dir, "verify-skill.md", "Be brief.\n");
		const knowledge = await loadKnowledge(new NodeExecutionEnv({ cwd: root }), root, { allow: ["verify-skill"], overlayDir: dir });
		assert.equal(knowledge.skills[0]!.overlay, "Be brief.");
		assert.match(knowledge.warnings[0]!, /does not record the hash/);
	});
});

describe("what the model receives", () => {
	const open: PiDurableRuntime[] = [];
	afterEach(async () => {
		for (const runtime of open.splice(0)) await runtime.close();
	});

	async function run(skills: { allow: string[]; overlayDir?: string }, root: string): Promise<string[]> {
		const contexts: string[] = [];
		const fake = scriptedModels(["final:ok"], (context) => contexts.push(JSON.stringify(context)));
		const dir = tmp();
		const runtime = new PiDurableRuntime({
			storagePath: join(dir, "state.sqlite"),
			models: fake.models,
			model: fake.model,
			env: (cwd) => new NodeExecutionEnv({ cwd: cwd ?? dir }),
			extensions: [skillsExtension({ ...skills, cacheMs: 0 })],
		});
		await runtime.start();
		open.push(runtime);
		const outcome = await runtime.execute(
			{ requestId: "j1", agentKey: "k", instruction: "go", workspace: root, budget: { maxTokens: 1_000_000, maxMinutes: 5 } },
			{ signal: new AbortController().signal, onProgress: () => {}, requestApproval: async () => ({ approved: true }) },
		);
		assert.equal(outcome.status, "done");
		return contexts;
	}

	it("puts the repository instructions and the skill index in the system prompt", async () => {
		const root = repo();
		const [first] = await run({ allow: ["verify-skill"] }, root);
		assert.match(first!, /repository-knowledge/);
		assert.match(first!, /Always run the linter\./);
		assert.match(first!, /Verify frontend tickets in a browser\./);
		assert.match(first!, new RegExp(`${root.replaceAll("/", "\\\\?/")}\\\\?/\\.agents\\\\?/skills\\\\?/verify-skill\\\\?/SKILL\\.md`));
		assert.doesNotMatch(first!, /not for this agent/);
	});

	it("changes nothing when no skill is allowed", async () => {
		const [first] = await run({ allow: [] }, repo());
		assert.doesNotMatch(first!, /repository-knowledge|Always run the linter/);
	});
});
