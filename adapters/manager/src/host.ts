import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clip, defang } from "./redact.ts";

/**
 * The part of the kill switch that is not a message to an agent: the processes themselves. The Manager runs on the agents VM, so it stops and starts the
 * agent stacks there with docker; the Windows agents are reached over ssh with a key that can run only the machine's `fleet-control` command (`suspend` or
 * `resume`, a forced command on the other side), so a leaked key can stop or start the agents and do nothing else.
 */
export interface HostConfig {
	/** Directory with one folder per stack (`<pilotDir>/<stack>/compose.yaml`); the flag file `SUSPENDED` lives here. */
	pilotDir: string;
	/** Stacks that start first and stop last (the event hub: the agents may use what it offers). */
	firstStacks: string[];
	stacks: string[];
	windows: { name: string; host: string }[];
	ssh?: { user: string; keyFile: string; knownHostsFile: string };
}

export type Exec = (file: string, args: string[], options: { cwd?: string; timeoutMs: number }) => Promise<{ code: number; output: string }>;

export const realExec: Exec = (file, args, options) =>
	new Promise((resolve) => {
		execFile(file, args, { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((error as unknown as { code: number }).code) : 1) : 0;
			resolve({ code, output: `${stdout}${stderr}` });
		});
	});

const STACK = /^[a-z0-9][a-z0-9-]{0,40}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,60}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;

export function parseHostConfig(raw: unknown): HostConfig {
	const object = (value: unknown, what: string): Record<string, any> => {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} must be an object`);
		return value as Record<string, any>;
	};
	const list = (value: unknown, what: string, pattern: RegExp): string[] => {
		if (value === undefined) return [];
		if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !pattern.test(item))) throw new Error(`${what} must be a list of plain names`);
		return value as string[];
	};
	const doc = object(raw, "the host control file");
	if (typeof doc.pilotDir !== "string" || !doc.pilotDir.startsWith("/")) throw new Error("pilotDir must be an absolute path");
	const windows = (Array.isArray(doc.windows) ? doc.windows : []).map((entry: unknown) => {
		const item = object(entry, "a windows entry");
		if (!NAME.test(String(item.name)) || !HOST.test(String(item.host))) throw new Error("a windows entry needs a plain name and host");
		return { name: String(item.name), host: String(item.host) };
	});
	let ssh: HostConfig["ssh"];
	if (doc.ssh !== undefined) {
		const s = object(doc.ssh, "ssh");
		for (const key of ["user", "keyFile", "knownHostsFile"]) if (typeof s[key] !== "string" || s[key] === "") throw new Error(`ssh.${key} is required`);
		ssh = { user: s.user, keyFile: s.keyFile, knownHostsFile: s.knownHostsFile };
	}
	if (windows.length > 0 && !ssh) throw new Error("windows machines need an ssh section");
	return { pilotDir: doc.pilotDir.replace(/\/$/, ""), firstStacks: list(doc.firstStacks, "firstStacks", STACK), stacks: list(doc.stacks, "stacks", STACK), windows, ...(ssh ? { ssh } : {}) };
}

export const loadHostConfig = (path: string): HostConfig => parseHostConfig(JSON.parse(readFileSync(path, "utf8")));

export class HostControls {
	readonly #config: HostConfig;
	readonly #exec: Exec;
	readonly #now: () => Date;

	constructor(config: HostConfig, exec: Exec = realExec, now: () => Date = () => new Date()) {
		this.#config = config;
		this.#exec = exec;
		this.#now = now;
	}

	get #flag(): string {
		return join(this.#config.pilotDir, "SUSPENDED");
	}

	/** True while the flag file is there: set by this class and by `scripts/fleet-suspend.sh`, and read by the CI deploy wrapper, which then refuses to deploy. */
	isSuspended(): boolean {
		return existsSync(this.#flag);
	}

	async #windows(action: "suspend" | "resume"): Promise<string[]> {
		const ssh = this.#config.ssh;
		const lines: string[] = [];
		if (!ssh) return lines;
		await Promise.all(
			this.#config.windows.map(async ({ name, host }) => {
				const result = await this.#exec(
					"ssh",
					["-i", ssh.keyFile, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${ssh.knownHostsFile}`, "-o", "ConnectTimeout=10", `${ssh.user}@${host}`, action],
					{ timeoutMs: 180_000 },
				);
				lines.push(result.code === 0 ? `${name}: ${action === "suspend" ? "stopped" : "started"}` : `${name}: ${action} FAILED (${clip(defang(result.output.trim().split("\n").at(-1) ?? "no answer"), 100)})`);
			}),
		);
		return lines.sort();
	}

	async #stack(action: "stop" | "up", name: string): Promise<string> {
		const result = await this.#exec("docker", action === "stop" ? ["compose", "stop"] : ["compose", "up", "-d"], { cwd: join(this.#config.pilotDir, name), timeoutMs: 300_000 });
		return result.code === 0 ? `${name}: ${action === "stop" ? "stopped" : "started"}` : `${name}: ${action === "stop" ? "stop" : "start"} FAILED (${clip(defang(result.output.trim().split("\n").at(-1) ?? ""), 100)})`;
	}

	/** Stops the agents first and the hub last, then the Windows agents; the flag file is written before anything stops. */
	async suspend(): Promise<string[]> {
		await writeFile(this.#flag, `${this.#now().toISOString()}\n`);
		const lines: string[] = [];
		for (const name of this.#config.stacks) lines.push(await this.#stack("stop", name));
		for (const name of this.#config.firstStacks) lines.push(await this.#stack("stop", name));
		lines.push(...(await this.#windows("suspend")));
		return lines;
	}

	/** Starts the hub first, then the agents, then the Windows agents. The flag file goes only when every step worked, so a retry has something to retry. */
	async resume(): Promise<string[]> {
		const lines: string[] = [];
		for (const name of this.#config.firstStacks) lines.push(await this.#stack("up", name));
		for (const name of this.#config.stacks) lines.push(await this.#stack("up", name));
		lines.push(...(await this.#windows("resume")));
		if (!lines.some((line) => line.includes("FAILED"))) await rm(this.#flag, { force: true });
		return lines;
	}
}
