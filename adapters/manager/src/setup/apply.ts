import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalRules, type ApprovalSettings } from "../policy.ts";
import { addendumPrompt, noOperatorSetup, type PiLaunch } from "../pi-process.ts";
import type { FleetLimits, SetupOverride } from "./contract.ts";
import { ensureLocalServer, type FetchBytes } from "./download.ts";
import { buildMcpServers, requireSecrets, usesLocalServer, type McpBuild } from "./mcp.ts";
import { skillFiles, writeSkills } from "./skills.ts";
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

	constructor(deps: ApplierDeps) {
		this.#deps = deps;
	}

	/** What Pi is started with before any override, and what it falls back to when a setup does not start. */
	baselineLaunch(): PiLaunch {
		const model = this.#deps.store.baselineModel;
		return model ? { ...noOperatorSetup, model } : noOperatorSetup;
	}

	async apply(override: SetupOverride): Promise<void> {
		const prepared = await this.#prepare(override);
		await this.#materialise(prepared);
		await this.#deps.store.acceptOverride(override);
		this.#deps.restart(prepared.launch);
	}

	async applyLimits(limits: FleetLimits): Promise<void> {
		await this.#deps.store.acceptLimits(limits);
	}

	/** At start: reads the saved documents and puts them to work again. Returns how Pi is to be started; a saved override that cannot be applied any more is reported as rejected. */
	async restore(): Promise<PiLaunch> {
		const { store } = this.#deps;
		await store.load();
		const at = (this.#deps.now ?? (() => new Date()))().toISOString();
		if (store.limits) await store.restored("limits", at);
		if (!store.override) return this.baselineLaunch();
		try {
			const prepared = await this.#prepare(store.override);
			await this.#materialise(prepared);
			await store.restored("override", at);
			return prepared.launch;
		} catch (error) {
			await store.reject("override", store.override.revision, `the saved setup could not be applied at start: ${error instanceof Error ? error.message.slice(0, 300) : "error"}`);
			return this.baselineLaunch();
		}
	}

	async #prepare(override: SetupOverride): Promise<Prepared> {
		const { env, store } = this.#deps;
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
		const model = override.model ?? store.baselineModel;
		const launch: PiLaunch = {
			...(override.instructions?.trim() ? { addendum: addendumPrompt(override.revision, override.instructions.trim()) } : {}),
			...(model ? { model } : {}),
			secrets: mcp.secrets,
		};
		return { mcp, skills: skillFiles(override), approvals, launch };
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
