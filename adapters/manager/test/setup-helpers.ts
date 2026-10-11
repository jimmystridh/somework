import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import type { InboundMessage } from "../src/domain.ts";
import { ApprovalRules } from "../src/policy.ts";
import type { PiChild } from "../src/rpc.ts";
import { SetupApplier } from "../src/setup/apply.ts";
import { documentHash, sha256Hex, SETUP_LABELS, type McpEntry, type SetupOverride } from "../src/setup/contract.ts";
import { SetupIntake } from "../src/setup/intake.ts";
import { SetupStore } from "../src/setup/store.ts";
import type { PiLaunch } from "../src/pi-process.ts";
import { FakeDomain } from "./helpers.ts";

export const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "manager-setup-"));

export const override = (extra: Partial<SetupOverride> = {}): SetupOverride => ({
	schema: 1,
	kind: "override",
	agent: "agent/manager",
	revision: 1,
	savedBy: "editor@example.com",
	savedAt: "2026-10-10T12:00:00Z",
	skills: { library: [], overlays: {} },
	mcp: [],
	...extra,
});

export const stdioEntry = (name: string, extra: Partial<McpEntry> = {}): McpEntry => ({ name, transport: "stdio", command: "/usr/bin/true", approval: "never", ...extra });
export const httpEntry = (name: string, extra: Partial<McpEntry> = {}): McpEntry => ({ name, transport: "http", url: "https://mcp.example.com/mcp", approval: "never", ...extra });

export const skill = (name: string, body = "Do the thing."): SetupOverride["skills"]["library"][number] => {
	const content = `---\nname: ${name}\ndescription: Test skill ${name}\n---\n${body}\n`;
	return { name, version: 1, description: `Test skill ${name}`, content, sha256: sha256Hex(content) };
};

export const OPERATIONS = { senderKind: "service", from: "operations" };

/** The message Operations sends: labels, and the document as an artifact the fake domain can serve. */
export function setupMessage(domain: FakeDomain, document: unknown, extra: Partial<InboundMessage> & { sha256?: string; kind?: string; revision?: number } = {}): InboundMessage {
	const bytes = Buffer.from(JSON.stringify(document));
	const artifactId = `art_${Object.keys(domain.artifacts).length + 1}`;
	domain.artifacts[artifactId] = bytes;
	const revision = extra.revision ?? (document as any)?.revision ?? 1;
	const { sha256, kind, revision: _revision, ...message } = extra;
	return {
		messageId: `msg_${artifactId}`,
		...OPERATIONS,
		text: "setup",
		type: "chat.notice",
		conversationId: "conv_setup",
		labels: { [SETUP_LABELS.kind]: kind ?? "override", [SETUP_LABELS.revision]: String(revision), [SETUP_LABELS.sha256]: sha256 ?? sha256Hex(bytes) },
		artifacts: [{ artifactId, version: 1, mediaType: "application/json" }],
		...message,
	};
}

export interface Rig {
	domain: FakeDomain;
	store: SetupStore;
	rules: ApprovalRules;
	applier: SetupApplier;
	intake: SetupIntake;
	logs: { event: string; [key: string]: unknown }[];
	restarts: PiLaunch[];
	dir: string;
	agentDir: string;
	env: NodeJS.ProcessEnv;
}

/** The setup parts wired as in main.ts over a temporary state directory and a temporary Pi agent folder. */
export async function rig(options: { dir?: string; env?: NodeJS.ProcessEnv; fetchBytes?: (url: string, max: number) => Promise<Buffer> } = {}): Promise<Rig> {
	const dir = options.dir ?? (await tempDir());
	const domain = new FakeDomain();
	const store = new SetupStore(join(dir, "setup"));
	const rules = new ApprovalRules();
	const restarts: PiLaunch[] = [];
	const env = options.env ?? {};
	const agentDir = join(dir, "pi-agent");
	const applier = new SetupApplier({ store, rules, agentDir, containerAgentDir: "~/.pi/agent", os: "linux", env, restart: (launch) => restarts.push(launch), ...(options.fetchBytes ? { fetchBytes: options.fetchBytes } : {}) });
	await store.load();
	const logs: Rig["logs"] = [];
	const intake = new SetupIntake({ domain, applier, store, log: (event, fields) => logs.push({ event, ...fields }) });
	return { domain, store, rules, applier, intake, logs, restarts, dir, agentDir, env };
}

export const hashOf = documentHash;

/** A Pi child process that answers `get_state` like Pi does; the test decides whether it starts, and when it exits. */
export function fakePiChild(options: { sessionId?: string; exitAtOnce?: boolean; streaming?: () => boolean } = {}) {
	const emitter = new EventEmitter();
	const stdout = new PassThrough();
	const received: any[] = [];
	const child = {
		stdin: {
			write(data: string, callback?: (error?: Error | null) => void) {
				for (const line of data.split("\n").filter(Boolean)) {
					const command = JSON.parse(line);
					received.push(command);
					if (options.exitAtOnce) continue;
					const state = { sessionId: options.sessionId ?? "session-1", isStreaming: options.streaming?.() ?? false, model: { provider: "openai-codex", id: "gpt-5.5" } };
					stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: state })}\n`);
				}
				callback?.();
				return true;
			},
			end() {},
		},
		stdout,
		stderr: new PassThrough(),
		on: (event: "error" | "exit", listener: () => void) => emitter.on(event, listener),
		kill: () => {
			setImmediate(() => emitter.emit("exit"));
		},
	} satisfies PiChild;
	if (options.exitAtOnce) setImmediate(() => emitter.emit("exit"));
	return { child, received, exit: () => emitter.emit("exit") };
}

// ---- archives, built by hand so the tests do not depend on tar or zip being installed -----------------------------------------------------------
export interface ArchiveEntry {
	name: string;
	data?: string;
	/** tar type flag ("2" is a symbolic link) */
	type?: string;
	mode?: number;
	linkTarget?: string;
}

export function tarGz(entries: ArchiveEntry[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const data = Buffer.from(entry.data ?? "");
		const header = Buffer.alloc(512);
		header.write(entry.name, 0, "utf8");
		header.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100);
		header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
		header.write(entry.type ?? "0", 156);
		if (entry.linkTarget) header.write(entry.linkTarget, 157);
		header.write("ustar\0", 257);
		header.write("        ", 148);
		const sum = [...header].reduce((total, byte) => total + byte, 0);
		header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
		blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

export function zip(entries: ArchiveEntry[]): Buffer {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const data = Buffer.from(entry.data ?? "");
		const name = Buffer.from(entry.name);
		const packed = deflateRawSync(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(crc32(data), 14);
		local.writeUInt32LE(packed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		const header = Buffer.alloc(46);
		header.writeUInt32LE(0x02014b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(20, 6);
		header.writeUInt16LE(8, 10);
		header.writeUInt32LE(crc32(data), 16);
		header.writeUInt32LE(packed.length, 20);
		header.writeUInt32LE(data.length, 24);
		header.writeUInt16LE(name.length, 28);
		header.writeUInt32LE(((entry.type === "2" ? 0o120777 : 0o100000 | (entry.mode ?? 0o644)) << 16) >>> 0, 38);
		header.writeUInt32LE(offset, 42);
		parts.push(local, name, packed);
		central.push(header, name);
		offset += local.length + name.length + packed.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, directory, end]);
}
