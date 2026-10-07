import { InvalidInput } from "@somework/agent-kit";

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
}

export interface PullRequestReader {
	read(pullRequest: string): Promise<PullRequestState>;
}

/** GitHub said the credential may not read this (for example check runs, which a fine-grained token needs the checks permission for). */
class ForbiddenError extends Error {
	override readonly name = "ForbiddenError";
}

const MAX_ITEMS = 40;
const MAX_BODY = 1500;
const FAILED_CHECKS = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

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

	/** A read the credential may not be allowed to make (a token without the checks permission): the answer is "not available", not a failed follow-up. */
	async #getIfAllowed(path: string): Promise<any | undefined> {
		try {
			return await this.#get(path);
		} catch (error) {
			if (error instanceof ForbiddenError) return undefined;
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
		if (state !== "open") return { state, headSha, author, feedback: [] };
		const commit = await this.#get(`${repo}/git/commits/${headSha}`);
		const since = Date.parse(String(commit?.committer?.date ?? commit?.author?.date ?? ""));
		if (!Number.isFinite(since)) throw new Error("GitHub gave no date for the head commit");
		const [reviews, inline, comments, checks] = await Promise.all([
			this.#get(`${repo}/pulls/${number}/reviews?per_page=100`),
			this.#get(`${repo}/pulls/${number}/comments?per_page=100`),
			this.#get(`${repo}/issues/${number}/comments?per_page=100`),
			this.#getIfAllowed(`${repo}/commits/${headSha}/check-runs?per_page=100`),
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
		for (const run of Array.isArray(checks?.check_runs) ? checks.check_runs : []) {
			if (FAILED_CHECKS.has(String(run?.conclusion))) items.push({ kind: "check", author: String(run?.app?.slug ?? "check"), at: String(run?.completed_at ?? ""), body: clip(`check "${String(run?.name ?? "?")}" ${run.conclusion}${run?.output?.title ? `: ${String(run.output.title)}` : ""}`, 400) });
		}
		items.sort((a, b) => a.at.localeCompare(b.at));
		return { state, headSha, author, feedback: items.slice(-MAX_ITEMS) };
	}
}
