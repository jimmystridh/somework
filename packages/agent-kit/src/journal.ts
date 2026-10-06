import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Outcome } from "@somework/sdk";
import { redactText } from "./events/redact.ts";

export interface JobRecord {
	taskId: string;
	capability: string;
	/** `task` for a job from the domain, `chat` for an instruction given in chat. */
	source: "task" | "chat";
	state: "completed" | "failed";
	at: string;
	ms: number;
	tokens?: number;
	/** What the result says it was (`pr_opened`, `completed`, `blocked`, a verdict) or the failure code. */
	outcome?: string;
	summary?: string;
	prUrl?: string;
	branch?: string;
}

const KEEP = 50;
const text = (value: unknown, max: number): string | undefined => {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	// eslint-disable-next-line no-control-regex
	const clean = redactText(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")).replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max)}...` : clean;
};

/** What a finished job says about itself, from its result or failure: names and short text only, redacted. */
export function describeOutcome(outcome: Outcome): Pick<JobRecord, "state" | "outcome" | "summary" | "prUrl" | "branch" | "tokens"> | undefined {
	if (outcome.type === "detach") return undefined;
	if (outcome.type === "failed") return { state: "failed", outcome: text(outcome.failure.code, 60), summary: text(outcome.failure.message, 300) };
	const result = (outcome.result ?? {}) as Record<string, any>;
	const tokens = Number(result.usage?.totalTokens);
	return {
		state: "completed",
		outcome: text(result.outcome ?? result.verdict ?? result.status, 60),
		summary: text(result.summary, 300),
		prUrl: text(result.prUrl, 200),
		branch: text(result.branch, 120),
		...(Number.isFinite(tokens) ? { tokens } : {}),
	};
}

/**
 * The agent's own record of what it did lately, kept in its state directory: what the chat answers from. It is written by the service when a
 * job ends, never by the model, and holds names, outcomes and counts, not task input or output.
 */
export class JobJournal {
	readonly #file: string;
	readonly #keep: number;

	constructor(file: string, keep = KEEP) {
		this.#file = file;
		this.#keep = keep;
		mkdirSync(dirname(file), { recursive: true });
	}

	#read(): JobRecord[] {
		try {
			const stored = JSON.parse(readFileSync(this.#file, "utf8"));
			return Array.isArray(stored) ? stored : [];
		} catch {
			return [];
		}
	}

	record(entry: JobRecord): void {
		const all = [...this.#read().filter((existing) => !(existing.taskId === entry.taskId && existing.source === entry.source)), entry].slice(-this.#keep);
		writeFileSync(`${this.#file}.tmp`, JSON.stringify(all));
		renameSync(`${this.#file}.tmp`, this.#file);
	}

	/** Newest first. */
	recent(limit = 10): JobRecord[] {
		return this.#read().slice(-limit).reverse();
	}

	/** The lines the chat summary shows. */
	lines(limit = 10): string[] {
		return this.recent(limit).map(
			(job) => redactText(`${job.at.slice(0, 16)} ${job.source} ${job.capability} ${job.taskId.slice(0, 24)}: ${job.state}${job.outcome ? ` (${job.outcome})` : ""}${job.tokens ? `, ${job.tokens} tokens` : ""}${job.branch ? `, branch ${job.branch}` : ""}${job.prUrl ? `, ${job.prUrl}` : ""}${job.summary ? ` - ${job.summary.slice(0, 160)}` : ""}`),
		);
	}
}
