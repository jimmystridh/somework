import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { documentHash, type FleetLimits, type SetupKind, type SetupOverride, type SetupStatus } from "./contract.ts";

interface Remembered {
	status: SetupStatus;
	/** The model Pi ran with before any override named one, so a reset puts it back. */
	baselineModel?: { provider: string; modelId: string };
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

async function writeJson(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	await rename(temporary, path);
}

/** What the Manager keeps of its setup in its own state directory: the last accepted documents and what it reports of them. No secrets are in any of it. */
export class SetupStore {
	override: SetupOverride | undefined;
	limits: FleetLimits | undefined;
	status: SetupStatus = { override: null, limits: null };
	baselineModel: Remembered["baselineModel"];
	readonly #dir: string;
	readonly #now: () => Date;

	constructor(dir: string, now: () => Date = () => new Date()) {
		this.#dir = dir;
		this.#now = now;
	}

	/** Reads what an earlier run saved. The documents are checked again by the caller; a status without its document is not believed. */
	async load(): Promise<void> {
		await mkdir(this.#dir, { recursive: true, mode: 0o700 });
		this.override = await readJson<SetupOverride>(join(this.#dir, "override.json"));
		this.limits = await readJson<FleetLimits>(join(this.#dir, "limits.json"));
		const remembered = await readJson<Remembered>(join(this.#dir, "status.json"));
		this.baselineModel = remembered?.baselineModel;
		this.status = { override: null, limits: null, ...(remembered?.status.rejected ? { rejected: remembered.status.rejected } : {}) };
	}

	/** Called when a persisted document has been put to work again after a start. */
	async restored(kind: SetupKind, appliedAt: string): Promise<void> {
		if (kind === "override" && this.override) this.status.override = { revision: this.override.revision, hash: documentHash(this.override), appliedAt };
		if (kind === "limits" && this.limits) this.status.limits = { revision: this.limits.revision, appliedAt };
		await this.#saveStatus();
	}

	async acceptOverride(document: SetupOverride): Promise<void> {
		this.override = document;
		await writeJson(join(this.#dir, "override.json"), document);
		this.status.override = { revision: document.revision, hash: documentHash(document), appliedAt: this.#now().toISOString() };
		delete this.status.rejected;
		await this.#saveStatus();
	}

	async acceptLimits(document: FleetLimits): Promise<void> {
		this.limits = document;
		await writeJson(join(this.#dir, "limits.json"), document);
		this.status.limits = { revision: document.revision, appliedAt: this.#now().toISOString() };
		delete this.status.rejected;
		await this.#saveStatus();
	}

	async reject(kind: SetupKind, revision: number, reason: string): Promise<void> {
		this.status.rejected = { kind, revision, reason: reason.slice(0, 500), at: this.#now().toISOString() };
		await this.#saveStatus();
	}

	async rememberBaselineModel(model: { provider: string; modelId: string }): Promise<void> {
		if (this.baselineModel) return;
		this.baselineModel = model;
		await this.#saveStatus();
	}

	/** The document was not put to work after all (for example a start with it failed): it is no longer reported as applied. */
	async withdrawOverride(reason: string): Promise<void> {
		const revision = this.override?.revision ?? 0;
		this.status.override = null;
		await this.reject("override", revision, reason);
	}

	#saveStatus(): Promise<void> {
		const remembered: Remembered = { status: this.status, ...(this.baselineModel ? { baselineModel: this.baselineModel } : {}) };
		return writeJson(join(this.#dir, "status.json"), remembered);
	}
}
