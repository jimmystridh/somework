import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { override, rig, setupMessage, skill } from "./setup-helpers.ts";

test("library skills are written as skill folders under library/<name> where Pi finds them", async () => {
	const r = await rig();
	const triage = skill("triage", "Look at the alert first.");
	await r.intake.handle(setupMessage(r.domain, override({ skills: { library: [triage, skill("release-notes")], overlays: {} } })));
	assert.equal(r.store.status.override?.revision, 1);
	assert.deepEqual((await readdir(join(r.agentDir, "skills", "library"))).sort(), ["release-notes", "triage"]);
	assert.equal(await readFile(join(r.agentDir, "skills", "library", "triage", "SKILL.md"), "utf8"), triage.content, "exactly the checked content");
});

test("an overlay becomes a skill of its own that says which skill it belongs to", async () => {
	const r = await rig();
	await r.intake.handle(setupMessage(r.domain, override({ skills: { library: [], overlays: { "pr-review": "Also check the changelog." } } })));
	const text = await readFile(join(r.agentDir, "skills", "library", "overlay-pr-review", "SKILL.md"), "utf8");
	assert.match(text, /^---\nname: overlay-pr-review\ndescription: Operator additions to the pr-review skill/);
	assert.match(text, /Also check the changelog\./);
});

test("the next revision replaces the library; skills Pi has from elsewhere are left alone; a reset removes the library", async () => {
	const r = await rig();
	await mkdir(join(r.agentDir, "skills", "mine"), { recursive: true });
	await writeFile(join(r.agentDir, "skills", "mine", "SKILL.md"), "mine");
	await r.intake.handle(setupMessage(r.domain, override({ revision: 1, skills: { library: [skill("one")], overlays: {} } })));
	await r.intake.handle(setupMessage(r.domain, override({ revision: 2, skills: { library: [skill("two")], overlays: {} } })));
	assert.deepEqual(await readdir(join(r.agentDir, "skills", "library")), ["two"]);
	await r.intake.handle(setupMessage(r.domain, override({ revision: 3 })));
	assert.deepEqual((await readdir(join(r.agentDir, "skills"))).sort(), ["mine"]);
	assert.equal(await readFile(join(r.agentDir, "skills", "mine", "SKILL.md"), "utf8"), "mine");
});

test("an overlay whose skill name would be too long is rejected", async () => {
	const r = await rig();
	await r.intake.handle(setupMessage(r.domain, override({ skills: { library: [], overlays: { [`a${"b".repeat(60)}`]: "x" } } })));
	assert.match(r.store.status.rejected?.reason ?? "", /too long/);
});

test("a library skill that does not match its checksum rejects the document", async () => {
	const r = await rig();
	const broken = { ...skill("bad"), content: "---\nname: bad\n---\nchanged" };
	await r.intake.handle(setupMessage(r.domain, override({ skills: { library: [broken], overlays: {} } })));
	assert.match(r.store.status.rejected?.reason ?? "", /does not match its checksum/);
});
