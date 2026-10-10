/**
 * The pull requests of a repository as far as verification needs them: which ones belong to a ticket (found by its key in the title, the
 * description or the comments) and what one pull request is (its state, its branches, who it was written for). Read only, GitHub's REST API,
 * one origin, with the token the agent already holds for cloning.
 */
export interface PullInfo {
	number: number;
	title: string;
	body: string;
	state: "open" | "closed";
	merged: boolean;
	headRef: string;
	headSha: string;
	baseRef: string;
	updatedAt: string;
	mergedAt?: string;
}

export interface PullFinder {
	/** Pull requests that mention the ticket key, newest first (at most a handful). */
	forTicket(repoUrl: string, ticket: string): Promise<PullInfo[]>;
	get(repoUrl: string, number: number): Promise<PullInfo | undefined>;
}

const REPO = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const TICKET = /^[A-Z][A-Z0-9]+-\d+$/;
const MAX_BODY = 4000;

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");

export class GitHubPullFinder implements PullFinder {
	readonly #token: (owner: string) => string | undefined;
	readonly #fetch: typeof fetch;
	readonly #apiBase: string;

	constructor(options: { token: (owner: string) => string | undefined; fetch?: typeof fetch; apiBase?: string }) {
		this.#token = options.token;
		this.#fetch = options.fetch ?? fetch;
		this.#apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
	}

	async #get(repoUrl: string, path: (owner: string, repo: string) => string): Promise<any | undefined> {
		const match = REPO.exec(repoUrl);
		if (!match) return undefined;
		const [, owner, repo] = match as unknown as [string, string, string];
		const token = this.#token(owner);
		const response = await this.#fetch(`${this.#apiBase}${path(owner, repo)}`, {
			headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "somework-qa", ...(token ? { authorization: `Bearer ${token}` } : {}) },
			redirect: "error",
			signal: AbortSignal.timeout(20_000),
		});
		if (response.status === 404) return undefined;
		if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
		return await response.json();
	}

	#info(raw: any): PullInfo | undefined {
		if (!raw || !Number.isInteger(raw.number)) return undefined;
		return {
			number: raw.number,
			title: text(raw.title, 300),
			body: text(raw.body, MAX_BODY),
			state: raw.state === "open" ? "open" : "closed",
			merged: raw.merged === true || typeof raw.merged_at === "string",
			headRef: text(raw.head?.ref, 200),
			headSha: text(raw.head?.sha, 64),
			baseRef: text(raw.base?.ref, 200),
			updatedAt: text(raw.updated_at, 40),
			...(typeof raw.merged_at === "string" ? { mergedAt: raw.merged_at } : {}),
		};
	}

	async get(repoUrl: string, number: number): Promise<PullInfo | undefined> {
		if (!Number.isInteger(number) || number <= 0) return undefined;
		return this.#info(await this.#get(repoUrl, (owner, repo) => `/repos/${owner}/${repo}/pulls/${number}`));
	}

	async forTicket(repoUrl: string, ticket: string): Promise<PullInfo[]> {
		if (!TICKET.test(ticket)) return [];
		const found = await this.#get(repoUrl, (owner, repo) => `/search/issues?q=${encodeURIComponent(`repo:${owner}/${repo} is:pr ${ticket} in:title,body,comments`)}&sort=updated&order=desc&per_page=8`);
		const numbers: number[] = (found?.items ?? []).map((item: any) => item?.number).filter((n: unknown): n is number => Number.isInteger(n)).slice(0, 8);
		const pulls = await Promise.all(numbers.map((number) => this.get(repoUrl, number).catch(() => undefined)));
		return pulls.filter((pull): pull is PullInfo => pull !== undefined);
	}
}
