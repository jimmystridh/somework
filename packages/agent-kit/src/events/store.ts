import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const HANDLER_NAME = /^[a-z][a-z0-9-]{0,39}$/;
export const MAX_HANDLER_BYTES = 64 * 1024;
const TOPICS_PRAGMA = /^\s*\/\/\s*@topics\s+(.+)$/m;

export class HandlerError extends Error {
	override readonly name = "HandlerError";
}

export interface HandlerVersion {
	version: number;
	hash: string;
	savedAt: string;
	bytes: number;
	topics: string[];
}

export interface HandlerInfo extends HandlerVersion {
	name: string;
	enabled: boolean;
	disabledReason?: string;
	disabledBy?: string;
}

interface Disabled {
	reason: string;
	by: string;
	at: string;
}

interface ControlFile {
	all?: Disabled;
	handlers: Record<string, Disabled>;
}

export interface HandlerStoreOptions {
	now?: () => Date;
	/** Returns an error message when `file` is not a valid module. Default: `node --check`. */
	syntaxCheck?: (file: string) => string | undefined;
}

const nodeCheck = (file: string): string | undefined => {
	try {
		execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"], timeout: 10_000 });
		return undefined;
	} catch (error) {
		const stderr = String((error as { stderr?: Buffer }).stderr ?? error);
		return stderr.split("\n").find((line) => /Error/.test(line))?.trim().slice(0, 300) ?? "syntax error";
	}
};

export const parseTopics = (source: string): string[] => {
	const match = TOPICS_PRAGMA.exec(source.split("\n").slice(0, 12).join("\n"));
	const topics = (match?.[1] ?? "*").split(/[\s,]+/).filter(Boolean);
	return topics.length > 0 ? topics : ["*"];
};

const hashOf = (source: string): string => createHash("sha256").update(source).digest("hex");

/**
 * The agent's handlers on the service host: `<dir>/<name>.mjs` is live, every saved version is kept under `<dir>/.versions/<name>/`, and
 * `<dir>/control.json` holds the kill switches (per handler and for all handlers). The control file may be edited by an operator while the
 * service runs: it is read again for every event.
 */
export class HandlerStore {
	readonly dir: string;
	readonly #now: () => Date;
	readonly #check: (file: string) => string | undefined;

	constructor(dir: string, options: HandlerStoreOptions = {}) {
		this.dir = dir;
		this.#now = options.now ?? (() => new Date());
		this.#check = options.syntaxCheck ?? nodeCheck;
		mkdirSync(join(dir, ".versions"), { recursive: true });
	}

	#path(name: string): string {
		if (!HANDLER_NAME.test(name)) throw new HandlerError("a handler name is lowercase letters, digits and dashes, starting with a letter (at most 40 characters)");
		return join(this.dir, `${name}.mjs`);
	}

	#versionsDir(name: string): string {
		return join(this.dir, ".versions", name);
	}

	#index(name: string): HandlerVersion[] {
		try {
			return JSON.parse(readFileSync(join(this.#versionsDir(name), "index.json"), "utf8")) as HandlerVersion[];
		} catch {
			return [];
		}
	}

	save(name: string, source: string, topics?: string[]): HandlerVersion {
		const path = this.#path(name);
		if (Buffer.byteLength(source) > MAX_HANDLER_BYTES) throw new HandlerError(`a handler is at most ${MAX_HANDLER_BYTES / 1024} KiB`);
		if (!/export\s+default\s/.test(source)) throw new HandlerError("a handler must `export default` a function (input, kit) => decision");
		const scratch = mkdtempSync(join(tmpdir(), "handler-check-"));
		try {
			const candidate = join(scratch, `${name}.mjs`);
			writeFileSync(candidate, source);
			const problem = this.#check(candidate);
			if (problem) throw new HandlerError(`the handler does not parse: ${problem}`);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
		const effectiveTopics = topics && topics.length > 0 ? topics : parseTopics(source);
		const history = this.#index(name);
		const hash = hashOf(source);
		const latest = history.at(-1);
		if (latest && latest.hash === hash && JSON.stringify(latest.topics) === JSON.stringify(effectiveTopics) && existsSync(path)) return latest;
		const entry: HandlerVersion = { version: (latest?.version ?? 0) + 1, hash, savedAt: this.#now().toISOString(), bytes: Buffer.byteLength(source), topics: effectiveTopics };
		const versions = this.#versionsDir(name);
		mkdirSync(versions, { recursive: true });
		writeFileSync(join(versions, `${entry.version}-${hash.slice(0, 12)}.mjs`), source);
		writeFileSync(join(versions, "index.json.tmp"), JSON.stringify([...history, entry]));
		renameSync(join(versions, "index.json.tmp"), join(versions, "index.json"));
		writeFileSync(`${path}.tmp`, source);
		renameSync(`${path}.tmp`, path);
		return entry;
	}

	/** The live version of a handler, or undefined. */
	current(name: string): (HandlerVersion & { source: string }) | undefined {
		const latest = this.#index(name).at(-1);
		if (!latest) return undefined;
		try {
			const source = readFileSync(this.#path(name), "utf8");
			if (hashOf(source) !== latest.hash) {
				const matching = this.#index(name).findLast((entry) => entry.hash === hashOf(source));
				return { ...(matching ?? { ...latest, hash: hashOf(source), version: latest.version, bytes: Buffer.byteLength(source), topics: parseTopics(source) }), source };
			}
			return { ...latest, source };
		} catch {
			return undefined;
		}
	}

	history(name: string): HandlerVersion[] {
		this.#path(name);
		return this.#index(name);
	}

	/** Source of an earlier version, for reading or restoring it. */
	version(name: string, version: number): string | undefined {
		const entry = this.#index(name).find((candidate) => candidate.version === version);
		if (!entry) return undefined;
		try {
			return readFileSync(join(this.#versionsDir(name), `${entry.version}-${entry.hash.slice(0, 12)}.mjs`), "utf8");
		} catch {
			return undefined;
		}
	}

	names(): string[] {
		return readdirSync(this.dir)
			.filter((file) => file.endsWith(".mjs"))
			.map((file) => file.slice(0, -4))
			.filter((name) => HANDLER_NAME.test(name))
			.sort();
	}

	list(): HandlerInfo[] {
		const control = this.#control();
		return this.names().flatMap((name) => {
			const current = this.current(name);
			if (!current) return [];
			const off = control.handlers[name] ?? control.all;
			const { source: _source, ...version } = current;
			return [{ name, ...version, enabled: off === undefined, ...(off ? { disabledReason: off.reason, disabledBy: off.by } : {}) }];
		});
	}

	// ---- kill switches ---------------------------------------------------------------------------------------------
	#control(): ControlFile {
		try {
			const stored = JSON.parse(readFileSync(join(this.dir, "control.json"), "utf8")) as Partial<ControlFile>;
			return { ...(stored.all ? { all: stored.all } : {}), handlers: stored.handlers ?? {} };
		} catch {
			return { handlers: {} };
		}
	}

	#writeControl(control: ControlFile): void {
		writeFileSync(join(this.dir, "control.json.tmp"), JSON.stringify(control, null, 1));
		renameSync(join(this.dir, "control.json.tmp"), join(this.dir, "control.json"));
	}

	/** Why a handler must not run right now (its own switch or the kill-all switch), or undefined. */
	disabled(name: string): Disabled | undefined {
		const control = this.#control();
		return control.handlers[name] ?? control.all;
	}

	disable(name: string, reason: string, by: string): void {
		this.#path(name);
		const control = this.#control();
		control.handlers[name] = { reason: reason.slice(0, 300), by, at: this.#now().toISOString() };
		this.#writeControl(control);
	}

	enable(name: string): void {
		this.#path(name);
		const control = this.#control();
		delete control.handlers[name];
		this.#writeControl(control);
	}

	disableAll(reason: string, by: string): void {
		const control = this.#control();
		control.all = { reason: reason.slice(0, 300), by, at: this.#now().toISOString() };
		this.#writeControl(control);
	}

	enableAll(): void {
		const control = this.#control();
		delete control.all;
		this.#writeControl(control);
	}
}
