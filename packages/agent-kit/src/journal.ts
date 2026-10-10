import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Outcome } from "@somework/sdk";
import { redactText } from "./events/redact.ts";

export interface JobRecord {
	taskId: string;
	capability: string;
	/** `job` for work an agent started (from a message or an event); `task` and `chat` are what older records say. */
	source: "job" | "task" | "chat";
	state: "completed" | "failed";
	/** When the job ended. */
	at: string;
	startedAt?: string;
	ms: number;
	tokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	costUsd?: number;
	/** What the result says it was (`pr_opened`, `completed`, `blocked`, a verdict) or the failure code. */
	outcome?: string;
	summary?: string;
	prUrl?: string;
	branch?: string;
	/** What the job was about: a ticket key, an Aikido issue number. */
	subject?: string;
	/** Acceptance checks of a verification: how many passed and failed. */
	checks?: { passed: number; failed: number };
}

const KEEP = 500;
const SUMMARY = 800;
const text = (value: unknown, max: number): string | undefined => {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	// eslint-disable-next-line no-control-regex
	const clean = redactText(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")).replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max)}...` : clean;
};

/** What a finished job says about itself, from its result or failure: names and short text only, redacted. */
export function describeOutcome(outcome: Outcome): Pick<JobRecord, "state" | "outcome" | "summary" | "prUrl" | "branch" | "tokens" | "inputTokens" | "outputTokens" | "costUsd" | "subject" | "checks"> | undefined {
	if (outcome.type === "detach") return undefined;
	if (outcome.type === "failed") return { state: "failed", outcome: text(outcome.failure.code, 60), summary: text(outcome.failure.message, SUMMARY) };
	const result = (outcome.result ?? {}) as Record<string, any>;
	const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
	const tokens = count(result.usage?.totalTokens);
	const inputTokens = count(result.usage?.inputTokens);
	const outputTokens = count(result.usage?.outputTokens);
	const costUsd = count(result.usage?.costUsd);
	const subject = text(result.ticket, 60) ?? (count(result.aikidoIssueId) !== undefined ? `Aikido #${result.aikidoIssueId}` : undefined);
	const checks = Array.isArray(result.acceptanceChecks) ? { passed: result.acceptanceChecks.filter((check: any) => check?.passed === true).length, failed: result.acceptanceChecks.filter((check: any) => check?.passed === false).length } : undefined;
	return {
		state: "completed",
		outcome: text(result.outcome ?? result.verdict ?? result.status, 60),
		summary: text(result.summary ?? result.notes, SUMMARY),
		prUrl: text(result.prUrl, 200),
		branch: text(result.branch, 120),
		...(subject ? { subject } : {}),
		...(checks ? { checks } : {}),
		...(tokens !== undefined ? { tokens } : {}),
		...(inputTokens !== undefined ? { inputTokens } : {}),
		...(outputTokens !== undefined ? { outputTokens } : {}),
		...(costUsd !== undefined ? { costUsd } : {}),
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
