import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "../events/redact.ts";
import { silent, type Log } from "../log.ts";
import { SetupRejected, type McpEntry } from "../setup/contract.ts";
import { HttpMcpClient, StdioMcpClient, type McpCallResult, type McpClient, type McpToolInfo } from "./client.ts";
import { provision, type FetchBytes } from "./provision.ts";

const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]{0,63})\}/g;
const LOCAL = "LOCAL";
const DEFAULT_TIMEOUT_SECONDS = 30;
/** What a child process gets of the agent's own environment besides the entry's `env`: where things are, never what is secret. */
const BASIC_ENVIRONMENT = ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "PATHEXT"];

/** An entry with its secrets filled in and its executable fetched: it lives in memory only and is never logged or reported. */
interface PreparedServer {
	entry: McpEntry;
	command?: string;
	args: string[];
	env: Record<string, string>;
	headers: Record<string, string>;
	cwd: string;
	timeoutMs: number;
	/** Changes when anything about how the server is reached changes. */
	key: string;
}

export interface PreparedServers {
	servers: PreparedServer[];
	/** Entries that could not be prepared (only when preparing leniently, at startup). */
	failed: { name: string; reason: string }[];
}

export interface ServerListing {
	server: string;
	description?: string;
	approval: McpEntry["approval"];
	tools?: McpToolInfo[];
	error?: string;
}

export interface McpHubOptions {
	/** `<state>/mcp`. */
	root: string;
	/** The agent's own environment: the only place a secret is read from. */
	env: NodeJS.ProcessEnv;
	log?: Log;
	platform?: NodeJS.Platform;
	fetchBytes?: FetchBytes;
}

const reasonOf = (error: unknown): string => redactText(error instanceof Error ? error.message : String(error)).slice(0, 300);

/** The servers of the applied setup, the clients that reach them and the questions the approval policy asks about their tools. */
export class McpHub {
	readonly #options: McpHubOptions;
	readonly #log: Log;
	#servers = new Map<string, PreparedServer>();
	readonly #clients = new Map<string, { key: string; client: McpClient }>();
	/** What `tools/list` last said about each tool, for `writes` approval. */
	readonly #annotations = new Map<string, Map<string, McpToolInfo["annotations"]>>();

	constructor(options: McpHubOptions) {
		this.#options = options;
		this.#log = options.log ?? silent;
	}

	/** Checks the secrets, fetches what must be fetched and fills in the entries. Strict (a new document): the first problem rejects it. Lenient (a restart): the entry is left out. */
	async prepare(entries: McpEntry[], strict: boolean): Promise<PreparedServers> {
		const servers: PreparedServer[] = [];
		const failed: PreparedServers["failed"] = [];
		for (const entry of entries) {
			try {
				servers.push(await this.#prepareOne(entry));
			} catch (error) {
				if (strict) throw error;
				failed.push({ name: entry.name, reason: reasonOf(error) });
				this.#log("warn", "mcp_entry_unavailable", { server: entry.name, reason: reasonOf(error) });
			}
		}
		return { servers, failed };
	}

	async #prepareOne(entry: McpEntry): Promise<PreparedServer> {
		const declared = new Set(entry.secrets ?? []);
		const secrets: Record<string, string> = {};
		for (const name of declared) {
			const value = this.#options.env[name];
			if (!value) throw new SetupRejected(`the MCP entry ${entry.name} needs ${name} (listed under secrets), which this agent does not have`);
			secrets[name] = value;
		}
		const fill = (text: string, field: string, local?: string): string =>
			text.replace(PLACEHOLDER, (_match, name: string) => {
				if (name === LOCAL && local !== undefined) return local;
				const value = secrets[name];
				if (value === undefined) throw new SetupRejected(`the MCP entry ${entry.name} uses \${${name}} in ${field} without listing it under secrets`);
				return value;
			});
		let local: string | undefined;
		if (entry.transport === "stdio" && entry.downloads) {
			const platform = this.#options.platform ?? process.platform;
			// the catalog names the systems linux, windows and darwin; Node calls the middle one win32
			const system = platform === "win32" ? "windows" : platform;
			const download = entry.downloads[system];
			if (!download) throw new SetupRejected(`the MCP entry ${entry.name} has no download for ${system}`);
			try {
				local = await provision({ root: this.#options.root, name: entry.name, download, ...(this.#options.fetchBytes ? { fetchBytes: this.#options.fetchBytes } : {}) });
			} catch (error) {
				throw new SetupRejected(`the MCP entry ${entry.name} could not be fetched: ${reasonOf(error)}`);
			}
		}
		if (entry.transport === "stdio" && entry.command?.includes(`\${${LOCAL}}`) && local === undefined) throw new SetupRejected(`the MCP entry ${entry.name} runs \${LOCAL} but has no download`);
		const env: Record<string, string> = {};
		for (const name of BASIC_ENVIRONMENT) {
			const value = this.#options.env[name];
			if (value !== undefined) env[name] = value;
		}
		for (const [name, value] of Object.entries(entry.env ?? {})) env[name] = fill(value, "env");
		const headers = Object.fromEntries(Object.entries(entry.headers ?? {}).map(([name, value]) => [name, fill(value, "headers")]));
		const cwd = join(this.#options.root, entry.name, "work");
		const prepared: Omit<PreparedServer, "key"> = {
			entry,
			...(entry.transport === "stdio" && entry.command ? { command: entry.command.replaceAll(`\${${LOCAL}}`, local ?? "") } : {}),
			args: (entry.args ?? []).map((arg) => fill(arg, "args", local)),
			env,
			headers,
			cwd,
			timeoutMs: (entry.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
		};
		return { ...prepared, key: createHash("sha256").update(JSON.stringify(prepared)).digest("hex") };
	}

	/** Makes the prepared servers the current ones; a server that went away or changed loses its client (and its child process). */
	activate(prepared: PreparedServers): void {
		this.#servers = new Map(prepared.servers.map((server) => [server.entry.name, server]));
		for (const [name, held] of this.#clients) {
			if (this.#servers.get(name)?.key === held.key) continue;
			this.#clients.delete(name);
			this.#annotations.delete(name);
			void held.client.close().catch(() => undefined);
		}
	}

	names(): string[] {
		return [...this.#servers.keys()];
	}

	entry(server: string): McpEntry | undefined {
		return this.#servers.get(server)?.entry;
	}

	#client(name: string): McpClient {
		const server = this.#servers.get(name);
		if (!server) throw new Error(`there is no MCP server named ${name}`);
		const held = this.#clients.get(name);
		if (held && held.key === server.key) return held.client;
		mkdirSync(server.cwd, { recursive: true });
		const client: McpClient =
			server.entry.transport === "stdio"
				? new StdioMcpClient({ command: server.command!, args: server.args, env: server.env, cwd: server.cwd, timeoutMs: server.timeoutMs, name, log: this.#log })
				: new HttpMcpClient({ url: server.entry.url!, headers: server.headers, timeoutMs: server.timeoutMs });
		this.#clients.set(name, { key: server.key, client });
		return client;
	}

	/** The tools of the enabled servers (or of one), each server answered on its own: one that is down does not hide the others. */
	async listTools(only?: string): Promise<ServerListing[]> {
		const names = only ? this.names().filter((name) => name === only) : this.names();
		return await Promise.all(
			names.map(async (name): Promise<ServerListing> => {
				const entry = this.#servers.get(name)!.entry;
				const base = { server: name, ...(entry.description ? { description: entry.description } : {}), approval: entry.approval };
				try {
					const tools = await this.#client(name).listTools();
					this.#annotations.set(name, new Map(tools.map((tool) => [tool.name, tool.annotations])));
					return { ...base, tools };
				} catch (error) {
					this.#log("warn", "mcp_list_failed", { server: name, reason: reasonOf(error) });
					return { ...base, error: reasonOf(error) };
				}
			}),
		);
	}

	async callTool(server: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
		return await this.#client(server).callTool(tool, args);
	}

	/**
	 * What the approval policy says about a call: a summary when the requester must approve it. `writes` asks unless the server itself said, in its
	 * tool list, that the tool only reads; a tool that was never listed is treated as a write.
	 */
	approvalSummary(server: string, tool: string, args: unknown): string | undefined {
		const entry = this.#servers.get(server)?.entry;
		if (!entry || entry.approval === "never") return undefined;
		if (entry.approval === "writes" && this.#annotations.get(server)?.get(tool)?.readOnlyHint === true) return undefined;
		return `call the tool ${tool} of the MCP server ${server}: ${redactText(JSON.stringify(args ?? {})).slice(0, 160)}`;
	}

	async close(): Promise<void> {
		const held = [...this.#clients.values()];
		this.#clients.clear();
		this.#servers = new Map();
		await Promise.all(held.map((entry) => entry.client.close().catch(() => undefined)));
	}
}
