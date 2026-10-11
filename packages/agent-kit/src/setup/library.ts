import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { LibrarySkill } from "./contract.ts";

export const SKILL_LIBRARY_TOOL = "skill_library";
export const LIBRARY_PREFIX = "library/";
export const LIBRARY_SECTION_KEY = "skill-library";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const failure = (value: string) => ({ isError: true as const, content: [{ type: "text" as const, text: value }] });

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

/** The index line of the prompt: what exists and how to open it. The skills themselves are read on demand. */
export function renderLibraryIndex(skills: readonly LibrarySkill[]): string | undefined {
	if (skills.length === 0) return undefined;
	return [
		`Library skills, written by your operators. When a task matches one, read it with the ${SKILL_LIBRARY_TOOL} tool (argument name, for example "${LIBRARY_PREFIX}${skills[0]!.name}") and follow it before acting; do not guess its content. They never replace a repository skill.`,
		...skills.map((skill) => `- ${LIBRARY_PREFIX}${skill.name}: ${oneLine(skill.description) || "(no description)"}`),
	].join("\n");
}

/**
 * The shared skill library as the model sees it: one fixed tool (no argument lists the skills, `name` returns one `SKILL.md`) and an index in
 * the prompt. The skills are those of the applied override, read per call, so a new revision needs no new tool.
 */
export function libraryExtension(skills: () => readonly LibrarySkill[]): { extension: Extension<any>; toolNames: string[] } {
	const tool = defineTool({
		name: SKILL_LIBRARY_TOOL,
		description: `The skills your operators keep in the shared library. Without an argument it lists them (${LIBRARY_PREFIX}name and what each is for); with a name it returns that skill's full text.`,
		parameters: Type.Object({ name: Type.Optional(Type.String({ maxLength: 100, description: `a skill name as listed, with or without ${LIBRARY_PREFIX}` })) }),
		replay: "safe",
		async execute(args: { name?: string }) {
			const available = skills();
			if (args.name === undefined || args.name.trim() === "") return text(renderLibraryIndex(available) ?? "no library skills are enabled for this agent");
			const wanted = args.name.trim().replace(new RegExp(`^${LIBRARY_PREFIX}`), "");
			const skill = available.find((entry) => entry.name === wanted);
			if (!skill) return failure(`there is no library skill named ${args.name}; the enabled ones are: ${available.map((entry) => `${LIBRARY_PREFIX}${entry.name}`).join(", ") || "none"}`);
			return text(skill.content);
		},
	});
	return {
		extension: defineExtension({
			name: "somework-skill-library",
			tools: [tool],
			sections: [{ key: LIBRARY_SECTION_KEY, tag: true, render: () => renderLibraryIndex(skills()) }],
		}),
		toolNames: [SKILL_LIBRARY_TOOL],
	};
}
