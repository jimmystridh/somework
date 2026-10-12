import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalRules, type ApprovalSettings } from "../policy.ts";
import { addendumPrompt, noOperatorSetup, type PiLaunch } from "../pi-process.ts";
import { SetupRejected, type FleetLimits, type ModelChoice, type SetupOverride } from "./contract.ts";
import { ensureLocalServer, type FetchBytes } from "./download.ts";
import { buildMcpServers, requireSecrets, usesLocalServer, type McpBuild } from "./mcp.ts";
import { LIBRARY_FOLDER, skillFiles, writeSkills } from "./skills.ts";
import type { SetupStore } from "./store.ts";

export interface ApplierDeps {
	store: SetupStore;
	rules: ApprovalRules;
	/** Pi's agent folder on this host (the one its container mounts): `mcp.json` and `skills/` go in it. */
	agentDir: string;
	/** The same folder as Pi sees it in its container; `~/.pi/agent` unless the mount says otherwise. */
	containerAgentDir: string;
	/** Operating system Pi runs on, for the catalog's downloads. */
	os: string;
	env: NodeJS.ProcessEnv;
	/** Asks the Pi process to start again with this setup once no run is going. */
	restart: (launch: PiLaunch) => void;
	fetchBytes?: FetchBytes;
	now?: () => Date;
}

interface Prepared {
	mcp: McpBuild;
	skills: Map<string, string>;
	approvals: ApprovalSettings;
	launch: PiLaunch;
}

/**
 * Puts a setup override to work on the stock Pi: `mcp.json` (from the document's MCP entries), skill folders, the prompt addendum and the model
 * (both are arguments of the Pi process), and the approval rules of the Manager's own policy. Everything that can fail is done before the first
 * file is written, so a rejected document leaves the earlier setup untouched.
 */
export class SetupApplier {
	readonly #deps: ApplierDeps;
	/** What Pi is, or is about to be, started with: a new fleet document changes its model part and leaves the rest. */
	#wanted: PiLaunch | undefined;

	constructor(deps: ApplierDeps) {
		this.#deps = deps;
	}

	/** What Pi is started with before any override, and what it falls back to when a setup does not start. */
	baselineLaunch(): PiLaunch {
		const model = this.#deps.store.baselineModel;
		return model ? { ...noOperatorSetup, model } : noOperatorSetup;
	}

	async apply(override: SetupOverride): Promise<void> {
		const prepared = await this.#prepare(override, this.#deps.store.limits?.model);
		await this.#materialise(prepared);
		await this.#deps.store.acceptOverride(override);
		this.#wanted = prepared.launch;
		this.#deps.restart(prepared.launch);
	}

	/** The fleet's model, when it names one, is the Manager's default model under the override's own; the other limits are only recorded. */
	async applyLimits(limits: FleetLimits): Promise<void> {
		const { store } = this.#deps;
		const modelPart = this.#modelPart(limits.model, store.override?.model);
		await store.acceptLimits(limits);
		const current = this.#wanted ?? this.baselineLaunch();
		const { model: _model, thinking: _thinking, ...rest } = current;
		const wanted: PiLaunch = { ...rest, ...modelPart };
		this.#wanted = wanted;
		if (JSON.stringify([current.model, current.thinking]) !== JSON.stringify([wanted.model, wanted.thinking])) this.#deps.restart(wanted);
	}

	/** At start: reads the saved documents and puts them to work again. Returns how Pi is to be started; a saved override that cannot be applied any more is reported as rejected. */
	async restore(): Promise<PiLaunch> {
		const { store } = this.#deps;
		await store.load();
		const at = (this.#deps.now ?? (() => new Date()))().toISOString();
		let fleetModel: ModelChoice | undefined;
		if (store.limits) {
			try {
				this.#modelPart(store.limits.model, undefined);
				fleetModel = store.limits.model;
			} catch (error) {
				await store.reject("limits", store.limits.revision, `the saved fleet model could not be applied at start: ${error instanceof Error ? error.message.slice(0, 300) : "error"}`);
			}
			await store.restored("limits", at);
		}
		const launch = await this.#restoredLaunch(fleetModel, at);
		this.#wanted = launch;
		return launch;
	}

	async #restoredLaunch(fleetModel: ModelChoice | undefined, at: string): Promise<PiLaunch> {
		const { store } = this.#deps;
		if (!store.override) return { ...this.baselineLaunch(), ...this.#modelPart(fleetModel, undefined) };
		try {
			const prepared = await this.#prepare(store.override, fleetModel);
			await this.#materialise(prepared);
			await store.restored("override", at);
			return prepared.launch;
		} catch (error) {
			await store.reject("override", store.override.revision, `the saved setup could not be applied at start: ${error instanceof Error ? error.message.slice(0, 300) : "error"}`);
			return { ...this.baselineLaunch(), ...this.#modelPart(fleetModel, undefined) };
		}
	}

	/**
	 * The provider, model and effort Pi is started with: the model Pi ran with before any setup, then the fleet's choice, then the override's, field by field.
	 * Nothing chosen above the baseline leaves it as it is; an effort nobody sets leaves Pi's own thinking level.
	 */
	#modelPart(fleet: ModelChoice | undefined, override: ModelChoice | undefined): Pick<PiLaunch, "model" | "thinking"> {
		const baseline = this.#deps.store.baselineModel;
		const provider = override?.provider ?? fleet?.provider ?? baseline?.provider;
		const modelId = override?.modelId ?? fleet?.modelId ?? baseline?.modelId;
		const chosen = [override, fleet].some((layer) => layer?.provider !== undefined || layer?.modelId !== undefined);
		if (chosen && (provider === undefined || modelId === undefined)) throw new SetupRejected("the model names only a provider or only a model id, and the Manager does not know yet which model Pi runs with to fill in the other");
		const thinking = override?.effort ?? fleet?.effort;
		return { ...(provider !== undefined && modelId !== undefined ? { model: { provider, modelId } } : {}), ...(thinking ? { thinking } : {}) };
	}

	async #prepare(override: SetupOverride, fleetModel: ModelChoice | undefined): Promise<Prepared> {
		const { env } = this.#deps;
		for (const entry of override.mcp) requireSecrets(entry, env);
		const locals: Record<string, string> = {};
		for (const entry of override.mcp.filter(usesLocalServer)) {
			locals[entry.name] = await ensureLocalServer(entry, {
				cacheDir: join(this.#deps.agentDir, "mcp-servers"),
				containerDir: `${this.#deps.containerAgentDir}/mcp-servers`,
				os: this.#deps.os,
				...(this.#deps.fetchBytes ? { fetchBytes: this.#deps.fetchBytes } : {}),
			});
		}
		const mcp = buildMcpServers(override.mcp, { env, locals });
		const approvals: ApprovalSettings = { patterns: override.approvalPatterns ?? [], mcp: Object.fromEntries(override.mcp.map((entry) => [entry.name, entry.approval])) };
		new ApprovalRules().replace(approvals);
		const modelPart = this.#modelPart(fleetModel, override.model);
		const skills = skillFiles(override);
		const launch: PiLaunch = {
			...(override.instructions?.trim() ? { addendum: addendumPrompt(override.revision, override.instructions.trim()) } : {}),
			...modelPart,
			...(override.mcp.length > 0 ? { mcp: true } : {}),
			...(skills.size > 0 ? { skillsDir: `${this.#deps.containerAgentDir}/skills/${LIBRARY_FOLDER}` } : {}),
			secrets: mcp.secrets,
		};
		return { mcp, skills, approvals, launch };
	}

	async #materialise(prepared: Prepared): Promise<void> {
		await writeSkills(this.#deps.agentDir, prepared.skills);
		await this.#writeMcpJson(prepared.mcp);
		this.#deps.rules.replace(prepared.approvals);
	}

	/** Replaces `mcpServers` and keeps every other key Pi's file may hold (such as `autoEnableCodemode`). */
	async #writeMcpJson(mcp: McpBuild): Promise<void> {
		const path = join(this.#deps.agentDir, "mcp.json");
		let existing: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(await readFile(path, "utf8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
		} catch {
			// no file yet, or one Pi could not read either
		}
		await mkdir(this.#deps.agentDir, { recursive: true, mode: 0o700 });
		const temporary = `${path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify({ ...existing, mcpServers: mcp.servers }, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, path);
	}
}
