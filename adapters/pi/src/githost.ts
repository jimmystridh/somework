export interface PullRequestRef {
	url: string;
}

/** The code host's pull request API. Branch push goes through git itself; this is only the PR record. */
export interface GitHost {
	findPullRequest(query: { repoUrl: string; head: string }): Promise<PullRequestRef | undefined>;
	createPullRequest(request: { repoUrl: string; head: string; base: string; title: string; body: string }): Promise<PullRequestRef | undefined>;
}

/** Pushes the branch and stops there: for repositories without a pull request API, or before a token for it exists. */
export const noPullRequests: GitHost = {
	findPullRequest: async () => undefined,
	createPullRequest: async () => undefined,
};

export function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } {
	const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repoUrl);
	if (!match) throw new Error(`not a GitHub repository URL: ${repoUrl}`);
	return { owner: match[1]!, repo: match[2]! };
}

/** GitHub REST. Not exercised against the real API in this repository's tests (needs a token); unit-tested against a stand-in server. */
export class GitHubHost implements GitHost {
	readonly #token: string;
	readonly #apiBase: string;
	readonly #fetch: typeof fetch;
	readonly #draft: boolean;

	constructor(options: { token: string; apiBase?: string; draft?: boolean; fetch?: typeof fetch }) {
		this.#token = options.token;
		this.#draft = options.draft ?? false;
		this.#apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "");
		this.#fetch = options.fetch ?? fetch;
	}

	async #call(method: string, path: string, body?: unknown): Promise<any> {
		const response = await this.#fetch(`${this.#apiBase}${path}`, {
			method,
			headers: { authorization: `Bearer ${this.#token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
			body: body ? JSON.stringify(body) : undefined,
		});
		if (!response.ok) throw new Error(`GitHub ${method} ${path} answered ${response.status}`);
		return response.json();
	}

	async findPullRequest(query: { repoUrl: string; head: string }): Promise<PullRequestRef | undefined> {
		const { owner, repo } = parseGitHubRepo(query.repoUrl);
		const open = await this.#call("GET", `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${query.head}`)}`);
		return open[0] ? { url: open[0].html_url } : undefined;
	}

	async createPullRequest(request: { repoUrl: string; head: string; base: string; title: string; body: string }): Promise<PullRequestRef | undefined> {
		const { owner, repo } = parseGitHubRepo(request.repoUrl);
		const created = await this.#call("POST", `/repos/${owner}/${repo}/pulls`, { head: request.head, base: request.base, title: request.title, body: request.body, draft: this.#draft });
		return { url: created.html_url };
	}
}
