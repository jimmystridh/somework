import type { Verdict } from "./result.ts";

/** Everything the tools need to know about the one job that is running. The QA agent runs one job at a time, so there is one of these. */
export interface QaJob {
	taskId: string;
	ticket: string;
	/** Directory of the browser's videos and screenshots (and the only place the attach tool reads from). */
	evidenceDir: string;
	/** Set by `qa_record_verdict`; the ticket-system tools check it. */
	verdict?: Verdict;
	/** What happened in the ticket system during this job. */
	jira: { commented: boolean; attachedVideo: boolean; labelled: boolean; transitioned: boolean; skippedReason?: string };
	/** Calls of this job that failed because the ticket system could not be reached (no answer, a timeout or a 5xx), not because it said no. */
	jiraUnreachable: { count: number; last?: string };
}

export class QaSession {
	#job: QaJob | undefined;

	start(job: Pick<QaJob, "taskId" | "ticket" | "evidenceDir">): QaJob {
		this.#job = { ...job, jira: { commented: false, attachedVideo: false, labelled: false, transitioned: false }, jiraUnreachable: { count: 0 } };
		return this.#job;
	}

	get job(): QaJob | undefined {
		return this.#job;
	}

	end(): void {
		this.#job = undefined;
	}
}
