import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { silent, type Log } from "./log.ts";

/**
 * The repository the agent works on is the source of truth for how to work on it: `AGENTS.md` and its skills
 * (`.agents/skills/<name>/SKILL.md` or `.claude/skills/<name>/SKILL.md`). They are read from the checked-out ref, through the
 * sandbox, when a request is prepared, and shown to the model as an index (name, description, path). The model opens the
 * skill file it needs with its normal file tool, so a long skill costs nothing until it is used.
 *
 * Nothing is exposed unless a role lists the skill by name. Where a skill needs adjusting for an agent, an overlay file
 * (`<overlayDir>/<name>.md`, kept with the deployment, not in the repository) states only the differences; it is shown next to
 * the index entry and wins where it conflicts. An overlay records the hash of the skill it was written against on its first
 * line (`<!-- base-sha256: <hex> -->`); when the repository's skill has changed since, the model and the logs are told.
 */

export const SKILL_DIRECTORIES = [".agents/skills", ".claude/skills"] as const;
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const BASE_HASH_LINE = /^<!--\s*base-sha256:\s*([0-9a-f]{64})\s*-->\s*\n?/;

export interface SkillLimits {
	/** `AGENTS.md` is cut here. */
	maxInstructionsBytes: number;
	/** Only the head of a `SKILL.md` is read for its front matter. */
	maxSkillHeadBytes: number;
	maxDescriptionChars: number;
	maxOverlayBytes: number;
	/** The whole rendered section is cut here. */
	maxPromptBytes: number;
}

export const DEFAULT_SKILL_LIMITS: SkillLimits = {
	maxInstructionsBytes: 16 * 1024,
	maxSkillHeadBytes: 8 * 1024,
	maxDescriptionChars: 500,
	maxOverlayBytes: 16 * 1024,
	maxPromptBytes: 48 * 1024,
};

export interface SkillsOptions {
	allow: readonly string[];
	/** Host directory with `<name>.md` overlays. Not read through the sandbox: it is deployment configuration. */
	overlayDir?: string;
	limits?: Partial<SkillLimits>;
	/** For tests: where overlays come from. Default: files in `overlayDir`. */
	readOverlay?: (name: string) => string | undefined;
}

export interface LoadedSkill {
	name: string;
	description: string;
	/** Path inside the sandbox, as the model's file tool takes it. */
	path: string;
	/** Which directory it was found in. */
	source: (typeof SKILL_DIRECTORIES)[number];
	overlay?: string;
	/** The overlay was written against another version of the skill than the one in the repository. */
	drifted?: boolean;
}

export interface LoadedKnowledge {
	/** `AGENTS.md`, possibly cut. */
	instructions?: string;
	skills: LoadedSkill[];
	/** Allowed skills that were not found or could not be used, and overlay drift. For logs; the model sees the relevant ones too. */
	warnings: string[];
}

type Readable = Pick<ExecutionEnv, "readTextFile" | "exists">;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const skillHash = sha256;

const cut = (text: string, bytes: number, marker: string): string => (Buffer.byteLength(text) <= bytes ? text : `${Buffer.from(text).subarray(0, bytes).toString("utf8").replace(/�$/, "")}\n${marker}`);

/** The front matter of a skill file: `name` and `description`, single line or indented continuation lines. */
export function parseFrontMatter(text: string): { name?: string; description?: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (!match) return {};
	const fields: Record<string, string> = {};
	let key: string | undefined;
	for (const line of match[1]!.split(/\r?\n/)) {
		const head = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
		if (head && !/^\s/.test(line)) {
			key = head[1]!;
			// a block scalar marker (`>`, `|-`, ...) only announces the indented lines that follow
			fields[key] = /^[>|][+-]?$/.test(head[2]!.trim()) ? "" : head[2]!;
		} else if (key && /^\s+\S/.test(line)) fields[key] = `${fields[key]} ${line.trim()}`.trim();
	}
	const unquote = (value: string | undefined): string | undefined => {
		if (value === undefined) return undefined;
		const trimmed = value.trim();
		const quoted = /^(["'])([\s\S]*)\1$/.exec(trimmed);
		const plain = quoted ? quoted[2]! : trimmed;
		return plain === "" ? undefined : plain;
	};
	return { name: unquote(fields.name), description: unquote(fields.description) };
}

/** Reads the repository's instructions and the allowed skills from `workspace` through `env`. Never throws for missing files. */
export async function loadKnowledge(env: Readable, workspace: string, options: SkillsOptions, log: Log = silent): Promise<LoadedKnowledge> {
	const limits = { ...DEFAULT_SKILL_LIMITS, ...options.limits };
	const root = workspace.replace(/\/+$/, "");
	const warnings: string[] = [];
	const ctx = BACKGROUND_CONTEXT;
	const read = async (path: string): Promise<string | undefined> => {
		const exists = await env.exists(path, ctx);
		if (!exists.ok || !exists.value) return undefined;
		const result = await env.readTextFile(path, ctx);
		return result.ok ? result.value : undefined;
	};
	const readOverlay =
		options.readOverlay ??
		((name: string) => {
			if (!options.overlayDir) return undefined;
			try {
				return readFileSync(join(options.overlayDir, `${name}.md`), "utf8");
			} catch {
				return undefined;
			}
		});

	const agents = await read(`${root}/AGENTS.md`);
	const instructions = agents === undefined ? undefined : cut(agents, limits.maxInstructionsBytes, "[AGENTS.md cut: open the file for the rest]");

	const skills: LoadedSkill[] = [];
	for (const name of options.allow) {
		if (!SKILL_NAME.test(name)) {
			warnings.push(`skill name "${name}" is not allowed (lowercase letters, digits and dashes only); ignored`);
			continue;
		}
		let found: { source: LoadedSkill["source"]; path: string; text: string } | undefined;
		for (const source of SKILL_DIRECTORIES) {
			const path = `${root}/${source}/${name}/SKILL.md`;
			const text = await read(path);
			if (text !== undefined) {
				found = { source, path, text };
				break;
			}
		}
		if (!found) {
			warnings.push(`skill "${name}" is allowed for this agent but is not in the repository`);
			continue;
		}
		const head = parseFrontMatter(found.text.slice(0, limits.maxSkillHeadBytes));
		if (head.name && head.name !== name) warnings.push(`skill "${name}" declares the name "${head.name}"; the directory name is used`);
		const skill: LoadedSkill = { name, description: cut(head.description ?? "(no description)", limits.maxDescriptionChars, "…").replace(/\s+/g, " "), path: found.path, source: found.source };

		const overlayText = readOverlay(name);
		if (overlayText !== undefined) {
			const recorded = BASE_HASH_LINE.exec(overlayText)?.[1];
			const body = overlayText.replace(BASE_HASH_LINE, "").trim();
			skill.overlay = cut(body, limits.maxOverlayBytes, "[overlay cut]");
			if (!recorded) warnings.push(`the overlay of skill "${name}" does not record the hash of the skill it adjusts (first line: <!-- base-sha256: <hex> -->)`);
			else if (recorded !== sha256(found.text)) {
				skill.drifted = true;
				warnings.push(`the repository's skill "${name}" changed since its overlay was written (recorded ${recorded.slice(0, 12)}, now ${sha256(found.text).slice(0, 12)}); review the overlay`);
			}
		}
		skills.push(skill);
	}
	for (const warning of warnings) log("warn", "skills_warning", { warning });
	return { instructions, skills, warnings };
}

/** The system prompt section, or `undefined` when there is nothing to show. */
export function renderKnowledge(knowledge: LoadedKnowledge, limits: Partial<SkillLimits> = {}): string | undefined {
	const maxBytes = { ...DEFAULT_SKILL_LIMITS, ...limits }.maxPromptBytes;
	const parts: string[] = [];
	if (knowledge.instructions) parts.push(`Repository instructions (from AGENTS.md, follow them):\n${knowledge.instructions.trim()}`);
	if (knowledge.skills.length > 0) {
		const lines = knowledge.skills.map((skill) => `- ${skill.name}: ${skill.description}\n  file: ${skill.path}`);
		parts.push(
			[
				"Repository skills. When a task matches a skill, open its file with your file tool and follow it before acting; do not guess its content.",
				...lines,
			].join("\n"),
		);
		for (const skill of knowledge.skills) {
			if (!skill.overlay) continue;
			const note = skill.drifted ? "\nWarning: the repository's skill changed after this overlay was written; where the two disagree, say so in your answer instead of guessing." : "";
			parts.push(`Adjustments for the skill "${skill.name}" for this agent. They win over the skill file where they conflict.${note}\n${skill.overlay}`);
		}
	}
	const missing = knowledge.warnings.filter((warning) => /is not in the repository/.test(warning));
	if (missing.length > 0) parts.push(`Note:\n${missing.map((warning) => `- ${warning}`).join("\n")}`);
	if (parts.length === 0) return undefined;
	return cut(parts.join("\n\n"), maxBytes, "[repository knowledge cut]");
}

export const SKILLS_SECTION_KEY = "repository-knowledge";

/**
 * A Pi Durable extension that renders the section before every request from the conversation's own workspace. Results are
 * cached briefly per workspace so a long run does not read the same files on every model turn.
 */
export function skillsExtension(options: SkillsOptions & { log?: Log; cacheMs?: number; now?: () => number }): Extension<any> {
	const cache = new Map<string, { at: number; text: string | undefined }>();
	const ttl = options.cacheMs ?? 30_000;
	const now = options.now ?? Date.now;
	return defineExtension({
		name: "somework-repository-knowledge",
		sections: [
			{
				key: SKILLS_SECTION_KEY,
				tag: true,
				async render(input) {
					if (options.allow.length === 0 || !input.env) return undefined;
					const workspace = input.env.cwd;
					const hit = cache.get(workspace);
					if (hit && now() - hit.at < ttl) return hit.text;
					const text = renderKnowledge(await loadKnowledge(input.env, workspace, options, options.log), options.limits);
					cache.set(workspace, { at: now(), text });
					return text;
				},
			},
		],
	});
}

/** `SKILLS_ALLOW` is a comma or space separated list; an invalid name is an error at startup, not a silently hidden skill. */
export function parseSkillList(text: string | undefined): string[] {
	const names = (text ?? "").split(/[\s,]+/).filter(Boolean);
	for (const name of names) if (!SKILL_NAME.test(name)) throw new Error(`SKILLS_ALLOW entry "${name}" must be lowercase letters, digits and dashes`);
	return [...new Set(names)];
}
