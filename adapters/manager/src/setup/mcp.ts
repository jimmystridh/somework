import { SECRET_NAME, SetupRejected, type McpEntry } from "./contract.ts";

/** One entry of Pi's `mcpServers` (`docs/mcp.md` of Pi 1.1.0). */
export interface PiMcpServer {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	description?: string;
	timeout?: number;
	enabled?: false;
}

/** A catalog entry as the document carries it; `enabled: false` keeps an entry in the file without connecting to it. */
export type ManagedMcpEntry = McpEntry & { enabled?: boolean };

export interface McpBuild {
	servers: Record<string, PiMcpServer>;
	/** Names of the environment variables Pi's `${NAME}` expansion reads: they must reach Pi's container, their values never the file. */
	secrets: string[];
}

export const LOCAL = "${LOCAL}";
const REFERENCE = /\$\{([^}]*)\}/g;

const referencesIn = (value: string): string[] => [...value.matchAll(REFERENCE)].map((match) => match[1]!);

export const usesLocalServer = (entry: ManagedMcpEntry): boolean => entry.enabled !== false && entry.transport === "stdio" && [entry.command ?? "", ...(entry.args ?? [])].some((part) => part.includes(LOCAL));

/** Pi treats server names that differ only in `-` and `_` as one server. */
const piName = (name: string): string => name.replace(/-/g, "_");

/** Throws when this host lacks a secret the entry needs; checked before any download so a missing secret costs nothing. */
export function requireSecrets(entry: ManagedMcpEntry, env: NodeJS.ProcessEnv): void {
	if (entry.enabled === false) return;
	for (const name of entry.secrets ?? []) {
		if (!env[name]) throw new SetupRejected(`the secret ${name} that the MCP entry ${entry.name} needs is not set on this host`);
	}
}

function checkReferences(entry: ManagedMcpEntry, field: "env" | "headers", values: Record<string, string>): void {
	for (const [key, value] of Object.entries(values)) {
		if (value.startsWith("!")) throw new SetupRejected(`the MCP entry ${entry.name} runs a command to get ${field} ${key}, which is not allowed`);
		for (const name of referencesIn(value)) {
			if (!SECRET_NAME.test(name) || !(entry.secrets ?? []).includes(name)) {
				throw new SetupRejected(`the MCP entry ${entry.name} refers to \${${name.slice(0, 40)}} in ${field} ${key} but does not list it in secrets`);
			}
		}
	}
}

function substituteLocal(entry: ManagedMcpEntry, text: string, locals: Record<string, string>): string {
	const path = locals[entry.name];
	for (const name of referencesIn(text)) {
		if (`\${${name}}` !== LOCAL) throw new SetupRejected(`the MCP entry ${entry.name} puts \${${name.slice(0, 40)}} in its command line; secrets go in env`);
	}
	if (!text.includes(LOCAL)) return text;
	if (!path) throw new SetupRejected(`the MCP entry ${entry.name} runs a local server that was not downloaded`);
	return text.split(LOCAL).join(path);
}

/**
 * Pi's `mcpServers` from the document's catalog entries. A secret is only ever a `${NAME}` reference that Pi expands from its own environment:
 * the file never holds a value. A document is rejected when an entry needs a secret this host does not have, refers to a variable it does not
 * list (Pi would otherwise hand any variable of the container, such as the gateway token, to a server), or asks Pi to run a command for a value.
 * `locals` maps the entries that run a downloaded server to the executable's path in Pi's container.
 */
export function buildMcpServers(entries: ManagedMcpEntry[], context: { env: NodeJS.ProcessEnv; locals: Record<string, string> }): McpBuild {
	const servers: Record<string, PiMcpServer> = {};
	const secrets = new Set<string>();
	const seen = new Set<string>();
	for (const entry of entries) {
		if (seen.has(piName(entry.name))) throw new SetupRejected(`the MCP entries ${entry.name} and another one have names that Pi treats as the same`);
		seen.add(piName(entry.name));
		const enabled = entry.enabled !== false;
		requireSecrets(entry, context.env);
		if (enabled) for (const name of entry.secrets ?? []) secrets.add(name);
		checkReferences(entry, "env", entry.env ?? {});
		checkReferences(entry, "headers", entry.headers ?? {});
		const server: PiMcpServer = {};
		if (entry.transport === "stdio") {
			const locals = enabled ? context.locals : {};
			server.command = enabled ? substituteLocal(entry, entry.command ?? "", locals) : (entry.command ?? "");
			if (entry.args) server.args = entry.args.map((arg) => (enabled ? substituteLocal(entry, arg, locals) : arg));
			if (entry.env) server.env = { ...entry.env };
		} else {
			server.url = entry.url;
			if (entry.headers) server.headers = { ...entry.headers };
		}
		if (entry.description) server.description = entry.description;
		if (entry.timeoutSeconds) server.timeout = entry.timeoutSeconds;
		if (!enabled) server.enabled = false;
		servers[entry.name] = server;
	}
	return { servers, secrets: [...secrets].sort() };
}
