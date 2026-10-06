import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "./events/redact.ts";
import type { Log } from "./log.ts";
import { silent } from "./log.ts";

/** The id of the synthetic job an instruction given in chat runs as. No task with this id exists in the domain. */
export const CHAT_TASK_PREFIX = "chat-";
export const isChatTask = (taskId: unknown): taskId is string => typeof taskId === "string" && taskId.startsWith(CHAT_TASK_PREFIX);

export interface CapturedArtifact {
	filename: string;
	mediaType: string;
	sizeBytes: number;
	/** Where the full copy is on the agent host, when it was kept. */
	path?: string;
	/** Why it was not kept, when it was not. */
	notKept?: string;
	/** The start of a text artifact, for the reply. */
	preview?: string;
	previewTruncated?: boolean;
}

const PREVIEW_BYTES = 16 * 1024;
const MAX_KEPT_BYTES = 200 * 1024 * 1024;
const KEEP_JOBS = 10;
const TEXT = /^(text\/|application\/(json|x-ndjson|xml|x-diff|yaml))/;

const safeName = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 100) || "artifact";

/**
 * What a chat instruction does with the artifacts its job makes. An instruction runs as a synthetic job (`chat-<messageId>`) that the
 * domain has no task for, so the domain would refuse every upload that names it as its source task (404 not_found). The service's task client is
 * wrapped with this: an upload for a chat job is captured on the agent host instead of sent, and the role gets an artifact reference that says
 * so (`inline:`), so the role's own code runs unchanged. The responder then puts the small ones into the reply and names where the rest is.
 * Any other call that names a chat job's task is skipped. Nothing about a task that does exist changes.
 */
export class ChatArtifacts {
	readonly #dir: string;
	readonly #log: Log;
	readonly #jobs = new Map<string, CapturedArtifact[]>();

	constructor(options: { dir: string; log?: Log }) {
		this.#dir = options.dir;
		this.#log = options.log ?? silent;
	}

	/** Wraps a client: uploads for a chat job are captured, calls on a chat job's task are skipped, everything else passes through. */
	wrap<T extends object>(client: T): T {
		const self = this;
		return new Proxy(client, {
			get(target, property) {
				const value = Reflect.get(target, property, target);
				if (typeof value !== "function") return value;
				if (property === "uploadArtifact") {
					return (options: { sourceTaskId?: string; filename: string; mediaType: string; bytes: Uint8Array | string }) =>
						isChatTask(options?.sourceTaskId) ? self.#capture(options.sourceTaskId, options) : value.call(target, options);
				}
				return (...args: unknown[]) => {
					const path = typeof args[0] === "string" ? args[0] : "";
					if (/\/tasks\/chat-/.test(path)) {
						self.#log("info", "chat_task_call_skipped", { method: String(property), path: path.slice(0, 80) });
						return Promise.resolve({});
					}
					return value.apply(target, args);
				};
			},
		});
	}

	async #capture(taskId: string, options: { filename: string; mediaType: string; bytes: Uint8Array | string }): Promise<unknown> {
		const bytes = typeof options.bytes === "string" ? Buffer.from(options.bytes) : Buffer.from(options.bytes);
		const list = this.#jobs.get(taskId) ?? [];
		this.#jobs.set(taskId, list);
		const index = list.length + 1;
		const captured: CapturedArtifact = { filename: safeName(options.filename), mediaType: options.mediaType, sizeBytes: bytes.length };
		if (bytes.length > MAX_KEPT_BYTES) captured.notKept = `larger than ${MAX_KEPT_BYTES / 1024 / 1024} MB`;
		else {
			try {
				const directory = join(this.#dir, safeName(taskId));
				mkdirSync(directory, { recursive: true });
				captured.path = join(directory, `${index}-${captured.filename}`);
				writeFileSync(captured.path, bytes);
				this.#prune();
			} catch (error) {
				captured.path = undefined;
				captured.notKept = "it could not be written to the agent host";
				this.#log("warn", "chat_artifact_not_kept", { taskId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) });
			}
		}
		if (TEXT.test(options.mediaType)) {
			captured.preview = bytes.subarray(0, PREVIEW_BYTES).toString("utf8");
			captured.previewTruncated = bytes.length > PREVIEW_BYTES;
		}
		list.push(captured);
		this.#log("info", "chat_artifact_captured", { taskId, filename: captured.filename, bytes: bytes.length, kept: captured.path !== undefined });
		const id = `inline:${taskId}:${index}`;
		return { artifactId: id, uri: id, filename: options.filename, mediaType: options.mediaType, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), inline: true };
	}

	/** The artifacts a chat job made, once. */
	take(taskId: string): CapturedArtifact[] {
		const list = this.#jobs.get(taskId) ?? [];
		this.#jobs.delete(taskId);
		return list;
	}

	#prune(): void {
		try {
			const directories = readdirSync(this.#dir).map((name) => ({ name, at: statSync(join(this.#dir, name)).mtimeMs })).sort((a, b) => b.at - a.at);
			for (const old of directories.slice(KEEP_JOBS)) rmSync(join(this.#dir, old.name), { recursive: true, force: true });
		} catch {
			// pruning is housekeeping
		}
	}
}

const bytesOf = (text: string): number => Buffer.byteLength(text);

function cutToBytes(text: string, max: number): string {
	if (max <= 0) return "";
	let cut = text.slice(0, max);
	while (bytesOf(cut) > max) cut = cut.slice(0, -1);
	return cut;
}

const size = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`);

/**
 * The reply's section for the artifacts of a chat job, at most `budget` bytes: a text artifact is shown (cut, with a note and where the full copy is),
 * anything else is named with where it stays. It always says the artifacts were not uploaded.
 */
export function describeCaptured(artifacts: readonly CapturedArtifact[], budget: number): string {
	if (artifacts.length === 0 || budget < 260) return "";
	const lines = ["", "Attachments were not uploaded to the domain (this was a chat instruction):"];
	const reserved = 100;
	let left = budget - bytesOf(lines.join("\n")) - reserved;
	const where = (item: CapturedArtifact): string => (item.path ? `on the agent host at ${item.path}` : `not kept (${item.notKept ?? "unknown reason"})`);
	const head = (item: CapturedArtifact): string => `- ${item.filename} (${item.mediaType}, ${size(item.sizeBytes)})`;
	const named = (item: CapturedArtifact): string => `${head(item)}: ${where(item)}`;
	// every artifact gets at least its name line, so a long text cannot push the rest out; the room that is left is shared among the texts
	const minimal = artifacts.map((item) => bytesOf(named(item)) + 1);
	let listed = 0;
	for (const [index, item] of artifacts.entries()) {
		const later = minimal.slice(index + 1).reduce((sum, bytes) => sum + bytes, 0);
		const textsLeft = artifacts.slice(index).filter((candidate) => candidate.preview !== undefined).length;
		const mine = Math.min(left - later, Math.floor((left - later) / Math.max(1, textsLeft)));
		const nameOnly = (): void => {
			if (bytesOf(named(item)) + 1 > left - later) return;
			lines.push(named(item));
			listed += 1;
			left -= bytesOf(named(item)) + 1;
		};
		if (item.preview === undefined) {
			nameOnly();
			continue;
		}
		const full = redactText(item.preview).trim();
		const note = (shown: number): string => `[truncated: ${shown} of ${item.sizeBytes} bytes shown; full copy ${where(item)}]`;
		if (!item.previewTruncated && bytesOf(`${head(item)}:\n${full}`) + 2 <= mine) {
			lines.push(`${head(item)}:`, full);
			listed += 1;
			left -= bytesOf(`${head(item)}:\n${full}`) + 2;
			continue;
		}
		const frame = bytesOf(`${head(item)}:\n`) + bytesOf(`\n${note(item.sizeBytes)}`) + 2;
		const room = mine - frame;
		if (room < 80) {
			nameOnly();
			continue;
		}
		const shown = cutToBytes(full, room);
		lines.push(`${head(item)}:`, shown, note(bytesOf(shown)));
		listed += 1;
		left -= frame + bytesOf(shown);
	}
	if (listed < artifacts.length) lines.push(`(${artifacts.length - listed} more not shown here; they are in the chat artifact folder on the agent host)`);
	return lines.join("\n");
}
