import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SetupRejected, SKILL_NAME, type SetupOverride } from "./contract.ts";

export const LIBRARY_FOLDER = "library";
export const OVERLAY_PREFIX = "overlay-";

/** What an operator's overlay is for Pi: a skill of its own that says it belongs to another one, because the Manager has no repository skill to change. */
export function overlaySkill(name: string, overlay: string): string {
	return [
		"---",
		`name: ${OVERLAY_PREFIX}${name}`,
		`description: Operator additions to the ${name} skill. Read this together with ${name} every time you use it.`,
		"---",
		"",
		overlay,
		"",
	].join("\n");
}

/** Folder name to file content for everything the override gives Pi as skills. */
export function skillFiles(override: SetupOverride): Map<string, string> {
	const files = new Map<string, string>();
	for (const skill of override.skills.library) files.set(skill.name, skill.content);
	for (const [name, overlay] of Object.entries(override.skills.overlays)) {
		const folder = `${OVERLAY_PREFIX}${name}`;
		if (!SKILL_NAME.test(folder)) throw new SetupRejected(`the overlay for ${name} would have a skill name that is too long`);
		if (files.has(folder)) throw new SetupRejected(`the overlay for ${name} collides with the library skill ${folder}`);
		files.set(folder, overlaySkill(name, overlay));
	}
	return files;
}

/**
 * Writes the skills as folders under `<agentDir>/skills/library/<name>/SKILL.md`, where Pi finds them (it scans `skills/` recursively),
 * and replaces what an earlier override put there. The folder is built beside the old one and swapped in by a rename.
 */
export async function writeSkills(agentDir: string, files: Map<string, string>): Promise<void> {
	const skills = join(agentDir, "skills");
	const target = join(skills, LIBRARY_FOLDER);
	const building = join(skills, `${LIBRARY_FOLDER}.new`);
	await rm(building, { recursive: true, force: true });
	await mkdir(skills, { recursive: true });
	if (files.size > 0) {
		for (const [name, content] of files) {
			await mkdir(join(building, name), { recursive: true });
			await writeFile(join(building, name, "SKILL.md"), content, { mode: 0o600 });
		}
	}
	await rm(target, { recursive: true, force: true });
	if (files.size > 0) await rename(building, target);
}
