import { InvalidInput, redactText } from "@somework/agent-kit";

/** A pull request this agent opened, as the follow-up task is told about it. */
export interface FollowUpInput {
	pullRequest: string;
	number: number;
	branch: string;
	round: number;
}

const PULL_REQUEST_URL = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/([0-9]{1,9})$/;
const BRANCH = /^agent\/[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/;

export function parseFollowUp(raw: any): FollowUpInput {
	const url = typeof raw?.pullRequest === "string" ? raw.pullRequest.trim() : "";
	const match = PULL_REQUEST_URL.exec(url);
	if (!match) throw new InvalidInput("followUp.pullRequest must be a https://github.com/<owner>/<repo>/pull/<number> address");
	const branch = typeof raw?.branch === "string" ? raw.branch : "";
	if (!BRANCH.test(branch) || branch.includes("..") || branch.includes("//") || branch.endsWith("/")) throw new InvalidInput("followUp.branch must be one of this agent's agent/ branches");
	const round = Number(raw?.round);
	if (!Number.isInteger(round) || round < 1 || round > 10) throw new InvalidInput("followUp.round must be a whole number from 1 to 10");
	return { pullRequest: url, number: Number(match[3]), branch, round };
}

/** The repository a pull request address belongs to, as `owner/name` in lower case. */
export const pullRequestRepository = (url: string): string | undefined => {
	const match = PULL_REQUEST_URL.exec(url);
	return match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined;
};

export interface FeedbackItem {
	kind: "review" | "review_comment" | "comment" | "check";
	author: string;
	at: string;
	/** What was said, or for a check what it concluded. Outside text: the instruction frames it as data. */
	body: string;
	path?: string;
	line?: number;
}

export interface PullRequestState {
	state: "open" | "closed" | "merged";
	headSha: string;
	/** Who opened the pull request (the account the agent pushes as). */
	author: string;
	/** Reviews, review comments, comments from people and failing checks that came after the newest commit on the branch. */
	feedback: FeedbackItem[];
	/** What the credential can see of the pull request's CI: `visible` is false when GitHub refused both check runs and commit statuses (the token lacks the permission). */
	ci: { visible: boolean; pending: number };
}

export interface PullRequestReader {
	read(pullRequest: string): Promise<PullRequestState>;
}

/** GitHub said the credential may not read this (a fine-grained token has no permission for check runs or commit statuses, but can read GitHub Actions). */
class ForbiddenError extends Error {
	override readonly name = "ForbiddenError";
}

const MAX_ITEMS = 40;
const MAX_BODY = 1500;
const FAILED_RUNS = new Set(["failure", "timed_out", "startup_failure"]);
const MAX_FAILED_JOBS = 3;
const LOG_TAIL_LINES = 40;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/** Reads a pull request over GitHub's REST API with the agent's own credential (read access is enough). Everything returned is text from outside. */
export class GitHubPullRequestReader implements PullRequestReader {
	readonly #apiBase: string;
	readonly #token: () => Promise<string>;
	readonly #fetch: typeof fetch;

	constructor(options: { apiBase?: string; token: () => Promise<string>; fetch?: typeof fetch }) {
		this.#apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
		this.#token = options.token;
		this.#fetch = options.fetch ?? fetch;
	}

	/** A read the credential may not be allowed to make: the answer is "not available", not a failed follow-up. */
	async #getIfAllowed(path: string): Promise<any | undefined> {
		try {
			return await this.#get(path);
		} catch (error) {
			if (error instanceof ForbiddenError || error instanceof InvalidInput) return undefined;
			throw error;
		}
	}

	async #get(path: string): Promise<any> {
		const response = await this.#fetch(`${this.#apiBase}${path}`, { headers: { authorization: `Bearer ${await this.#token()}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "somework-aikido-fixer" }, signal: AbortSignal.timeout(20_000), redirect: "error" });
		if (response.status === 403) throw new ForbiddenError(`GitHub refused ${path.split("?")[0]} for this credential`);
		if (response.status === 404) throw new InvalidInput("the pull request cannot be read with this agent's credential");
		if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path.split("?")[0]}`);
		return await response.json();
	}

	async read(pullRequest: string): Promise<PullRequestState> {
		const match = PULL_REQUEST_URL.exec(pullRequest);
		if (!match) throw new InvalidInput("not a pull request address");
		const repo = `/repos/${match[1]}/${match[2]}`;
		const number = match[3];
		const pull = await this.#get(`${repo}/pulls/${number}`);
		const headSha = String(pull?.head?.sha ?? "");
		if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("GitHub gave no head commit for the pull request");
		const state = pull.merged === true || pull.merged_at ? "merged" : pull.state === "closed" ? "closed" : "open";
		const author = String(pull?.user?.login ?? "");
		if (state !== "open") return { state, headSha, author, feedback: [], ci: { visible: false, pending: 0 } };
		const commit = await this.#get(`${repo}/git/commits/${headSha}`);
		const since = Date.parse(String(commit?.committer?.date ?? commit?.author?.date ?? ""));
		if (!Number.isFinite(since)) throw new Error("GitHub gave no date for the head commit");
		const [reviews, inline, comments, ci] = await Promise.all([
			this.#get(`${repo}/pulls/${number}/reviews?per_page=100`),
			this.#get(`${repo}/pulls/${number}/comments?per_page=100`),
			this.#get(`${repo}/issues/${number}/comments?per_page=100`),
			this.#ci(match[1]!, match[2]!, Number(number), headSha),
		]);
		const items: FeedbackItem[] = [];
		const later = (at: unknown) => Date.parse(String(at)) > since;
		// the agent writes no comments of its own (the service only commits and opens the pull request), so nobody is left out, not even the account it pushes as;
		// a bot's plain comment (a preview deployment, a summary) is noise, while its reviews, inline comments and failed checks are the point
		const person = (comment: any) => comment?.user?.type !== "Bot" && !String(comment?.user?.login ?? "").endsWith("[bot]");
		for (const review of Array.isArray(reviews) ? reviews : []) {
			const body = String(review?.body ?? "").trim();
			if (later(review?.submitted_at) && (body !== "" || review?.state === "CHANGES_REQUESTED")) items.push({ kind: "review", author: String(review?.user?.login ?? "unknown"), at: String(review.submitted_at), body: clip(`${review.state}${body ? `: ${body}` : ""}`, MAX_BODY) });
		}
		for (const comment of Array.isArray(inline) ? inline : []) {
			if (later(comment?.created_at) && String(comment?.body ?? "").trim() !== "") items.push({ kind: "review_comment", author: String(comment?.user?.login ?? "unknown"), at: String(comment.created_at), body: clip(String(comment.body).trim(), MAX_BODY), ...(typeof comment.path === "string" ? { path: comment.path } : {}), ...(Number.isInteger(comment.line) ? { line: comment.line } : {}) });
		}
		for (const comment of Array.isArray(comments) ? comments : []) {
			if (later(comment?.created_at) && person(comment) && String(comment?.body ?? "").trim() !== "") items.push({ kind: "comment", author: String(comment?.user?.login ?? "unknown"), at: String(comment.created_at), body: clip(String(comment.body).trim(), MAX_BODY) });
		}
		items.push(...ci.items);
		items.sort((a, b) => a.at.localeCompare(b.at));
		return { state, headSha, author, feedback: items.slice(-MAX_ITEMS), ci: { visible: ci.visible, pending: ci.pending } };
	}

	/**
	 * What the repository's CI says about the head commit, through what a fine-grained token can read: GitHub Actions (runs, their failed jobs and steps and the
	 * end of each failed job's log) and the pull request's overall status (GraphQL), which does not need the checks permission. Anything else that reports
	 * to the commit only shows up as the overall state.
	 */
	async #ci(owner: string, name: string, number: number, headSha: string): Promise<{ items: FeedbackItem[]; visible: boolean; pending: number }> {
		const repo = `/repos/${owner}/${name}`;
		const items: FeedbackItem[] = [];
		const runs = await this.#getIfAllowed(`${repo}/actions/runs?head_sha=${headSha}&per_page=50`);
		const rollup = await this.#rollupState(owner, name, number);
		const list: any[] = Array.isArray(runs?.workflow_runs) ? runs.workflow_runs : [];
		let pending = list.filter((run) => run?.status !== "completed").length;
		if (rollup === "PENDING" || rollup === "EXPECTED") pending = Math.max(pending, 1);
		let jobsRead = 0;
		for (const run of list.filter((candidate) => FAILED_RUNS.has(String(candidate?.conclusion)))) {
			const jobs = await this.#getIfAllowed(`${repo}/actions/runs/${Number(run.id)}/jobs?filter=latest&per_page=50`);
			for (const job of (Array.isArray(jobs?.jobs) ? jobs.jobs : []).filter((candidate: any) => FAILED_RUNS.has(String(candidate?.conclusion)))) {
				if (jobsRead >= MAX_FAILED_JOBS) break;
				jobsRead++;
				const step = (Array.isArray(job?.steps) ? job.steps : []).find((candidate: any) => FAILED_RUNS.has(String(candidate?.conclusion)));
				const tail = await this.#logTail(`${repo}/actions/jobs/${Number(job.id)}/logs`);
				items.push({
					kind: "check",
					author: "github-actions",
					at: String(job?.completed_at ?? run?.updated_at ?? ""),
					body: clip(`workflow "${String(run?.name ?? "?")}", job "${String(job?.name ?? "?")}" ${String(job?.conclusion)}${step ? ` at step "${String(step?.name ?? "?")}"` : ""}${tail ? `\n${tail}` : ""}`, MAX_BODY),
				});
			}
		}
		if (items.length === 0 && (rollup === "FAILURE" || rollup === "ERROR")) {
			items.push({ kind: "check", author: "ci", at: new Date().toISOString(), body: `the pull request's overall status is ${rollup}; the failing check is not one this credential can read (it is not a GitHub Actions run)` });
		}
		return { items, visible: runs !== undefined || rollup !== undefined, pending };
	}

	/** SUCCESS, FAILURE, PENDING, ERROR or EXPECTED for the pull request's head commit, or undefined when it cannot be read. */
	async #rollupState(owner: string, name: string, number: number): Promise<string | undefined> {
		try {
			const response = await this.#fetch(`${this.#apiBase}/graphql`, {
				method: "POST",
				headers: { authorization: `Bearer ${await this.#token()}`, "content-type": "application/json", "user-agent": "somework-aikido-fixer" },
				body: JSON.stringify({ query: "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}", variables: { owner, name, number } }),
				signal: AbortSignal.timeout(20_000),
				redirect: "error",
			});
			if (!response.ok) return undefined;
			const state = ((await response.json()) as any)?.data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
			return typeof state === "string" ? state : undefined;
		} catch {
			return undefined;
		}
	}

	/** The last lines of a job's log: the API answers with a redirect to the log file, which is fetched without the token. Empty when it cannot be had. */
	async #logTail(path: string): Promise<string> {
		try {
			const first = await this.#fetch(`${this.#apiBase}${path}`, { headers: { authorization: `Bearer ${await this.#token()}`, accept: "application/vnd.github+json", "user-agent": "somework-aikido-fixer" }, signal: AbortSignal.timeout(20_000), redirect: "manual" });
			const location = first.headers.get("location");
			const body = location ? await this.#fetch(location, { signal: AbortSignal.timeout(30_000), redirect: "error" }) : first;
			if (!body.ok) return "";
			const lines = (await body.text()).split("\n").map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "").trimEnd()).filter((line) => line !== "");
			return redactText(lines.slice(-LOG_TAIL_LINES).join("\n"));
		} catch {
			return "";
		}
	}
}
