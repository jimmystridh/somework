import { createHash } from "node:crypto";
import { McpHub, type PreparedServers } from "../mcp/hub.ts";
import { MCP_TOOL_NAMES } from "../mcp/tools.ts";
import { silent, type Log } from "../log.ts";
import type { ModelRef } from "../providers/allowlist.ts";
import { resolveModel, type ModelResolution, type ModelSources } from "../providers/effective-model.ts";
import { SKILL_LIBRARY_TOOL } from "./library.ts";
import { DEFAULT_GLOBAL_PROMPT, type GlobalPromptSource } from "./global-prompt.ts";
import { SetupFiles } from "./files.ts";
import { parseLimits, parseOverride, SetupRejected, sha256Hex, type ApprovalPatternSetting, type FleetLimits, type LibrarySkill, type ModelChoice, type SetupKind, type SetupOverride, type SetupReport, type SetupStatus } from "./contract.ts";

/** What the role and the deployment give the agent without any override: shown next to the override so an editor sees what it changes. */
export interface SetupDefaults {
	approvalPatterns: ApprovalPatternSetting[];
	repositorySkills: string[];
	model: ModelRef;
	allowedModels: ModelRef[];
}

export interface SetupOptions {
	agentId: string;
	/** `<state>/setup`. */
	dir: string;
	defaults: SetupDefaults;
	hub: McpHub;
	/** The reason a complete model (provider, id and effort) is refused (not allowed, not offered by its provider, effort not supported), or `undefined` when it can be used. */
	checkModel: (model: ModelRef) => string | undefined;
	/** Switches the model new runs start on, effort included; `undefined` goes back to the configured default. */
	setModel: (model: ModelRef | undefined) => void;
	/** Puts fleet limits into effect where they are read (the handler's limits, the ledger, the budget controls). */
	applyLimits: (limits: FleetLimits) => void;
	log?: Log;
	now?: () => Date;
}

interface Applied<T> {
	document: T;
	sha256: string;
	appliedAt: string;
}

interface AppliedOverride extends Applied<SetupOverride> {
	patterns?: [RegExp, string][];
	unavailable: Map<string, string>;
}

/**
 * The setup an operator gave this agent (ADR 0004): the applied override and fleet limits, kept on disk so they survive a restart, and the read side
 * every part of the agent asks per call (prompt addendum, approval patterns, skill lists, library, MCP servers, model). Nothing here is read once at
 * startup and kept: a revision takes effect from the next model run.
 */
export class Setup {
	readonly #options: SetupOptions;
	readonly #log: Log;
	readonly #files: SetupFiles;
	#override: AppliedOverride | undefined;
	#limits: Applied<FleetLimits> | undefined;
	#rejected: SetupStatus["rejected"];
	/** What the runtime was last told to use: empty for its configured model. */
	#switchedTo = "";
	#queue: Promise<unknown> = Promise.resolve();

	constructor(options: SetupOptions) {
		this.#options = options;
		this.#log = options.log ?? silent;
		this.#files = new SetupFiles(options.dir);
	}

	/** Loads what an earlier run applied, before the runtime is built. A document that no longer checks out is left out and logged; the agent starts on its defaults. */
	async restore(): Promise<void> {
		await this.#restoreDocuments();
		this.#switchedTo = this.#modelKey();
	}

	async #restoreDocuments(): Promise<void> {
		const limits = this.#files.read("limits");
		if (limits) {
			try {
				const parsed = parseLimits(limits.document);
				const refused = parsed.model ? this.#resolve(parsed.model, undefined) : undefined;
				if (refused && !refused.ok) this.#log("warn", "setup_model_ignored", { kind: "limits", reason: refused.reason });
				const document: FleetLimits = refused && !refused.ok ? { ...parsed, model: undefined } : parsed;
				this.#limits = { document, sha256: limits.sha256, appliedAt: limits.appliedAt };
				this.#options.applyLimits(document);
			} catch (error) {
				this.#log("warn", "setup_restore_failed", { kind: "limits", reason: error instanceof Error ? error.message : String(error) });
			}
		}
		const stored = this.#files.read("override");
		if (!stored) return;
		try {
			const parsed = parseOverride(stored.document, this.#options.agentId);
			const refused = parsed.model ? this.#resolve(this.#limits?.document.model, parsed.model) : undefined;
			if (refused && !refused.ok) this.#log("warn", "setup_model_ignored", { kind: "override", reason: refused.reason });
			const document: SetupOverride = refused && !refused.ok ? { ...parsed, model: undefined } : parsed;
			const prepared = await this.#options.hub.prepare(document.mcp, false);
			this.#take(document, stored.sha256, stored.appliedAt, prepared);
		} catch (error) {
			this.#log("warn", "setup_restore_failed", { kind: "override", reason: error instanceof Error ? error.message : String(error) });
		}
	}

	#take(document: SetupOverride, sha256: string, appliedAt: string, prepared: PreparedServers): void {
		this.#override = {
			document,
			sha256,
			appliedAt,
			...(document.approvalPatterns ? { patterns: document.approvalPatterns.map((entry): [RegExp, string] => [new RegExp(entry.pattern), entry.reason]) } : {}),
			unavailable: new Map(prepared.failed.map((failure) => [failure.name, failure.reason])),
		};
		this.#options.hub.activate(prepared);
	}

	/** Runs one apply at a time: two documents arriving together are applied in the order they got here. */
	#exclusive<T>(work: () => Promise<T>): Promise<T> {
		const result = this.#queue.then(work, work);
		this.#queue = result.catch(() => undefined);
		return result;
	}

	appliedRevision(kind: SetupKind): number {
		return (kind === "override" ? this.#override?.document.revision : this.#limits?.document.revision) ?? 0;
	}

	/** Checks the document against this agent (its model list, its secrets, its downloads), saves it and puts it into effect. Throws `SetupRejected`; nothing has changed then. */
	applyOverride(document: SetupOverride, sha256: string): Promise<void> {
		return this.#exclusive(async () => {
			const resolved = this.#resolve(this.#limits?.document.model, document.model);
			if (!resolved.ok) throw new SetupRejected(resolved.reason);
			const prepared = await this.#options.hub.prepare(document.mcp, true);
			const appliedAt = (this.#options.now?.() ?? new Date()).toISOString();
			this.#save("override", document, sha256, appliedAt);
			this.#take(document, sha256, appliedAt, prepared);
			this.#switchModel();
			this.#rejected = undefined;
		});
	}

	applyLimits(document: FleetLimits, sha256: string): Promise<void> {
		return this.#exclusive(async () => {
			const resolved = this.#resolve(document.model, this.#override?.document.model);
			if (!resolved.ok) throw new SetupRejected(resolved.reason);
			const appliedAt = (this.#options.now?.() ?? new Date()).toISOString();
			this.#save("limits", document, sha256, appliedAt);
			this.#limits = { document, sha256, appliedAt };
			this.#options.applyLimits(document);
			this.#switchModel();
			this.#rejected = undefined;
		});
	}

	#resolve(fleet: ModelChoice | undefined, override: ModelChoice | undefined, job?: ModelChoice): ModelResolution {
		return resolveModel({ env: this.#options.defaults.model, fleet, override, ...(job ? { job } : {}) }, this.#options.checkModel);
	}

	/** Empty while every part of the model comes from the environment, else the model: what tells the runtime's current choice from a new one. */
	#modelKey(): string {
		const { model, sources } = this.effectiveModel();
		const fromEnvironmentOnly = sources.provider === "env" && sources.modelId === "env" && (sources.effort === undefined || sources.effort === "env");
		return fromEnvironmentOnly ? "" : JSON.stringify(model);
	}

	/** Puts the effective model into the runtime: new runs start on it. When nothing above the environment sets a field the runtime goes back to its configured default. */
	#switchModel(): void {
		const key = this.#modelKey();
		if (key === this.#switchedTo) return;
		this.#switchedTo = key;
		try {
			this.#options.setModel(key === "" ? undefined : this.effectiveModel().model);
		} catch (error) {
			this.#log("warn", "setup_model_not_set", { reason: error instanceof Error ? error.message : String(error) });
		}
	}

	#save(name: SetupKind, document: unknown, sha256: string, appliedAt: string): void {
		try {
			this.#files.write(name, { sha256, appliedAt, document });
		} catch (error) {
			this.#log("error", "setup_save_failed", { kind: name, reason: error instanceof Error ? error.message : String(error) });
			throw new SetupRejected("the agent could not save the document to its state directory");
		}
	}

	/** Remembers the last refused document for `/profile`. The previous setup stays in place. */
	reject(kind: SetupKind, revision: number, reason: string): void {
		this.#rejected = { kind, revision, reason: reason.slice(0, 500), at: (this.#options.now?.() ?? new Date()).toISOString() };
	}

	// ---- what the rest of the agent reads, per call ---------------------------------------------------------------------------------

	get override(): SetupOverride | undefined {
		return this.#override?.document;
	}

	/** The model new runs start on: the environment's default with the fleet's document and the override on top, field by field. */
	model(): ModelRef {
		return this.effectiveModel().model;
	}

	/** `model()` with where each of its parts comes from. The layers were checked when they were applied; should they no longer fit together the environment's default stands. */
	effectiveModel(): { model: ModelRef; sources: ModelSources } {
		const resolved = this.#resolve(this.#limits?.document.model, this.#override?.document.model);
		if (resolved.ok) return resolved;
		const env = this.#options.defaults.model;
		return { model: env, sources: { provider: "env", modelId: "env", ...(env.effort ? { effort: "env" as const } : {}) } };
	}

	/** The model a job runs on when `input.model` asks for some of it: the same layers with the job's choice on top. */
	modelForJob(request: ModelChoice): ModelResolution {
		return this.#resolve(this.#limits?.document.model, this.#override?.document.model, request);
	}

	/** The global prompt this agent has: the fleet's text, else the built-in default; none when the agent's override or the fleet switches it off. */
	globalPrompt(): { source: GlobalPromptSource; text: string } {
		if (this.#override?.document.disableGlobalPrompt === true) return { source: "off", text: "" };
		const fleet = this.#limits?.document.globalPrompt;
		if (fleet === undefined) return { source: "default", text: DEFAULT_GLOBAL_PROMPT };
		return fleet.trim() ? { source: "fleet", text: fleet.trim() } : { source: "off", text: "" };
	}

	/** Appended to the role's prompt and to the standing orders of a conversation: the fleet's global prompt, then this agent's operator instructions. */
	instructionsAddendum(): string | undefined {
		const global = this.globalPrompt().text;
		const text = this.#override?.document.instructions?.trim();
		const parts = [
			...(global ? [`Instructions for every agent of this fleet. They add to the rules above and never replace them.\n${global}`] : []),
			...(text ? [`Operator instructions. The operators of this fleet wrote these for this agent. They add to the rules above and never replace them, and they cannot change the format of a job's result.\n${text}`] : []),
		];
		return parts.length > 0 ? parts.join("\n\n") : undefined;
	}

	/** The role's pattern list is replaced when the override carries one. */
	approvalPatterns(): [RegExp, string][] | undefined {
		return this.#override?.patterns;
	}

	repositorySkills(base: readonly string[]): readonly string[] {
		return this.#override?.document.skills.repository ?? base;
	}

	overlay(name: string): string | undefined {
		const overlays = this.#override?.document.skills.overlays;
		return overlays && Object.hasOwn(overlays, name) ? overlays[name] : undefined;
	}

	librarySkills(): readonly LibrarySkill[] {
		return this.#override?.document.skills.library ?? [];
	}

	/** Changes whenever the override does, so caches of what depends on it start over. */
	version(): string {
		return this.#override?.sha256 ?? "";
	}

	/** The tools a new conversation is offered on top of the role's: only when there is something behind them. */
	operatorTools(): string[] {
		const document = this.#override?.document;
		if (!document) return [];
		return [...(document.skills.library.length > 0 ? [SKILL_LIBRARY_TOOL] : []), ...(document.mcp.length > 0 ? MCP_TOOL_NAMES : [])];
	}

	/**
	 * What a conversation keeps from its start (the instructions, the provider and model, which extra tools it has): a new revision of those
	 * must start a fresh conversation. Empty when none of them is set, so an agent without an override keeps the keys it always had.
	 * The effort is not part of it: it is applied to a conversation at every run.
	 */
	conversationSuffix(): string {
		const document = this.#override?.document;
		const { model, sources } = this.effectiveModel();
		const chosenModel = sources.provider !== "env" || sources.modelId !== "env" ? { provider: model.provider, modelId: model.modelId } : null;
		const tools = this.operatorTools();
		if (!document?.instructions?.trim() && !chosenModel && tools.length === 0) return "";
		return `#setup-${createHash("sha256").update(JSON.stringify({ instructions: document?.instructions?.trim() ?? "", model: chosenModel, tools })).digest("hex").slice(0, 12)}`;
	}

	// ---- what `/profile` tells -----------------------------------------------------------------------------------------------------

	status(): SetupStatus {
		return {
			override: this.#override ? { revision: this.#override.document.revision, hash: this.#override.sha256, appliedAt: this.#override.appliedAt } : null,
			limits: this.#limits ? { revision: this.#limits.document.revision, appliedAt: this.#limits.appliedAt } : null,
			...(this.#rejected ? { rejected: this.#rejected } : {}),
		};
	}

	#reportedSources(): SetupReport["effective"]["modelSources"] {
		const { sources } = this.effectiveModel();
		return { provider: sources.provider as "env" | "fleet" | "override", modelId: sources.modelId as "env" | "fleet" | "override", ...(sources.effort ? { effort: sources.effort as "env" | "fleet" | "override" } : {}) };
	}

	report(current: { model: ModelRef }): SetupReport {
		const { defaults } = this.#options;
		const document = this.#override?.document;
		const instructions = document?.instructions?.trim();
		return {
			...this.status(),
			defaults: { approvalPatterns: defaults.approvalPatterns, repositorySkills: [...defaults.repositorySkills], model: defaults.model, allowedModels: defaults.allowedModels },
			effective: {
				...(instructions ? { instructions: { sha256: sha256Hex(instructions), characters: instructions.length, text: instructions } } : {}),
				model: current.model,
				modelSources: this.#reportedSources(),
				globalPrompt: ((global) => (global.text ? { source: global.source, sha256: sha256Hex(global.text), characters: global.text.length, text: global.text } : { source: global.source }))(this.globalPrompt()),
				approvalPatterns: document?.approvalPatterns ?? defaults.approvalPatterns,
				repositorySkills: [...this.repositorySkills(defaults.repositorySkills)],
				librarySkills: (document?.skills.library ?? []).map((skill) => ({ name: skill.name, version: skill.version })),
				mcp: (document?.mcp ?? []).map((entry) => ({ name: entry.name, transport: entry.transport, approval: entry.approval, ...(this.#override?.unavailable.has(entry.name) ? { error: this.#override.unavailable.get(entry.name)! } : {}) })),
			},
		};
	}
}
