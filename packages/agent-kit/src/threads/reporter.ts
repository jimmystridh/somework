import type { Outcome } from "../job-types.ts";
import { describeOutcome } from "../journal.ts";
import { silent, type Log } from "../log.ts";
import type { JobEntry, JobReporter, Party } from "./jobs.ts";
import type { Sender } from "./message.ts";

export type JobEventState = "started" | "waiting" | "finished";

export interface JobEventPayload {
	jobId: string;
	label: string;
	capability: string;
	requestedBy: string;
	conversationId?: string;
	waitingFor?: string;
	result?: "completed" | "failed" | "cancelled";
	summary?: string;
}

export interface JobReporterDeps {
	sender: Sender;
	agentId: string;
	/** Publishes `agent.<slug>.job.<state>`; failing to publish never disturbs a job. */
	publish?: (state: JobEventState, payload: JobEventPayload) => Promise<void>;
	/** The role's words for a finished job's result (see `ChatRoleHooks.describeResult`). */
	describeResult?: (result: unknown) => string | undefined;
	log?: Log;
}

const slug = (id: string): string => id.replace(/^agent\//, "").toLowerCase().replace(/[^a-z0-9_]+/g, "_");

/** The topic segment of an agent: lower case, digits and underscores, so that it is valid in an event topic. */
export const topicSlug = slug;

/** Who hears about a job: the audience of the message that asked for it, else its requester; never the agent itself. */
export function audienceOf(entry: JobEntry, self: string): Party[] {
	const seen = new Set<string>();
	return (entry.audience && entry.audience.length > 0 ? entry.audience : entry.requestedBy.kind === "service" ? [] : [entry.requestedBy]).filter((party) => {
		if (party.id === self || seen.has(party.id)) return false;
		seen.add(party.id);
		return true;
	});
}

const payloadOf = (entry: JobEntry): JobEventPayload => ({
	jobId: entry.id,
	label: entry.label,
	capability: `${entry.capability.id}@${entry.capability.version}`,
	requestedBy: entry.requestedBy.id,
	...(entry.conversationId ? { conversationId: entry.conversationId } : {}),
	...(entry.waitingFor ? { waitingFor: entry.waitingFor } : {}),
	...(entry.end ? { result: entry.end.kind, ...(entry.end.summary ? { summary: entry.end.summary } : {}) } : {}),
});

/** Words for how a job ended: the role's own description of its result, or the outcome, summary, pull request and branch. */
export function describeEnding(entry: JobEntry, outcome: Outcome | undefined, describe?: (result: unknown) => string | undefined): string {
	const head = `${entry.label} (${entry.id})`;
	if (entry.end?.kind === "cancelled" || !outcome) return `${head}: cancelled before it ran.`;
	if (outcome.type === "failed") return `${head}: I could not do that (${outcome.failure.code}): ${outcome.failure.message}.`;
	const custom = outcome.type === "completed" ? describe?.(outcome.result) : undefined;
	if (custom) return `${head}\n${custom}`;
	const described = describeOutcome(outcome);
	return [`${head}: done${described?.outcome ? ` (${described.outcome})` : ""}.`, ...(described?.summary ? [described.summary] : []), ...(described?.prUrl ? [`Pull request: ${described.prUrl}`] : []), ...(described?.branch ? [`Branch: ${described.branch}`] : [])].join("\n");
}

/** Turns what happens to a job into messages in its conversation and into events anyone may subscribe to. */
export function createJobReporter(deps: JobReporterDeps): JobReporter {
	const log = deps.log ?? silent;
	const publish = async (state: JobEventState, entry: JobEntry): Promise<void> => {
		try {
			await deps.publish?.(state, payloadOf(entry));
		} catch (error) {
			log("warn", "job_event_failed", { jobId: entry.id, state, error: String(error).slice(0, 160) });
		}
	};
	const tell = async (entry: JobEntry, text: string, key: string, artifacts: unknown[] = []): Promise<void> => {
		const to = audienceOf(entry, deps.agentId);
		if (to.length === 0) return;
		await deps.sender.send({ recipients: to, ...(entry.conversationId ? { conversationId: entry.conversationId } : {}), ...(entry.replyTo ? { causationId: entry.replyTo } : {}), text, artifacts, key, labels: { jobId: entry.id, ...(entry.source === "event" ? { eventNotice: "true" } : {}) } });
	};
	return {
		async waiting(entry, blocking) {
			await publish("waiting", entry);
			await tell(entry, `${entry.label} (${entry.id}) waits for ${blocking.map((hold) => `${hold.resource}, which ${hold.label} is using`).join("; ")}. It starts when that is free.`, `job-waiting:${entry.id}`);
		},
		async started(entry) {
			await publish("started", entry);
		},
		async finished(entry, outcome, artifacts) {
			await publish("finished", entry);
			await tell(entry, describeEnding(entry, outcome, deps.describeResult), `job-finished:${entry.id}`, artifacts);
		},
	};
}
