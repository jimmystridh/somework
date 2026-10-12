import { isGitHubRepo, parseGitHubRepo } from "./githost.ts";
import type { PreflightCheck } from "./preflight.ts";
import type { RoleHooks, ServiceContext } from "./profile.ts";

export const GITHUB_REPOSITORY_CHECK = "github-repository";
export const GITHUB_PULL_REQUESTS_CHECK = "github-pull-requests";

export interface GitHubPreflightOptions {
	/** Clone URLs of the repositories the agent works on. */
	repositories: readonly string[];
	/** The token for a repository owner (lower case), or none: a repository without one is not checked. */
	token: (owner: string) => Promise<string | undefined>;
	/** Hosts the token may be sent to (the kit's `GIT_TOKEN_HOSTS`). */
	tokenHosts: readonly string[];
	apiBase?: string;
	/** What the role does without the Pull requests permission, after "the token lacks Pull requests: read". */
	withoutPullRequests: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

interface Probe {
	slug: string;
	ok: boolean;
	status?: number;
	failure?: string;
}

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Whether the git token can read what the agent needs of each repository: its contents (clone, read) and its pull requests. A token that
 * lacks one of them answers 403 or 404 to every call, and the role only notices when a job goes wrong. A failure to read the contents is an
 * `error`, a missing pull request permission a `warning`: the role works without it, with less. Only statuses reach the detail, never a body.
 */
export function githubPreflight(options: GitHubPreflightOptions): () => Promise<PreflightCheck[]> {
	const doFetch = options.fetch ?? fetch;
	const apiBase = (options.apiBase || "https://api.github.com").replace(/\/+$/, "");
	const repositories = options.repositories.filter((url) => isGitHubRepo(url) && hostAllowed(url, options.tokenHosts));

	async function probe(slug: string, token: string, path: string): Promise<Probe> {
		try {
			const response = await doFetch(`${apiBase}/repos/${slug}${path}`, {
				headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "somework-agent", authorization: `Bearer ${token}` },
				redirect: "error",
				signal: AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS),
			});
			await response.body?.cancel().catch(() => {});
			return { slug, ok: response.status === 200, status: response.status };
		} catch (error) {
			return { slug, ok: false, failure: error instanceof Error && error.name === "TimeoutError" ? "GitHub did not answer in time" : "GitHub could not be reached" };
		}
	}

	return async () => {
		const contents: Probe[] = [];
		const pulls: Probe[] = [];
		for (const url of repositories) {
			const { owner, repo } = parseGitHubRepo(url);
			const slug = `${owner}/${repo}`;
			let token: string | undefined;
			try {
				token = await options.token(owner.toLowerCase());
			} catch {
				contents.push({ slug, ok: false, failure: "no token could be obtained" });
				continue;
			}
			if (!token) continue;
			contents.push(await probe(slug, token, "/contents"));
			pulls.push(await probe(slug, token, "/pulls?per_page=1"));
		}
		const checks: PreflightCheck[] = [];
		if (contents.length > 0) checks.push(combine(GITHUB_REPOSITORY_CHECK, contents, "error", contentsDetail, (found) => (rejected(found) ? "error" : "warning")));
		if (pulls.length > 0) checks.push(combine(GITHUB_PULL_REQUESTS_CHECK, pulls, "warning", (found) => pullsDetail(found, options.withoutPullRequests), () => "warning"));
		return checks;
	};
}

const rejected = (found: Probe): boolean => found.status === 401 || found.status === 403 || found.status === 404;

function contentsDetail(found: Probe): string {
	if (found.failure) return found.failure;
	if (found.status === 401) return "GitHub does not accept the token (401)";
	if (rejected(found)) return `the token cannot read the repository's contents (GitHub answered ${found.status})`;
	return `GitHub answered ${found.status}`;
}

function pullsDetail(found: Probe, consequence: string): string {
	if (found.failure) return found.failure;
	if (found.status === 403) return `the token lacks Pull requests: read; ${consequence}`;
	return `GitHub answered ${found.status} to the pull request listing`;
}

function combine(name: string, probes: Probe[], declared: "error" | "warning", detailOf: (found: Probe) => string, severityOf: (found: Probe) => "error" | "warning"): PreflightCheck {
	const failed = probes.filter((found) => !found.ok);
	if (failed.length === 0) return { name, ok: true, severity: declared };
	const severity = failed.some((found) => severityOf(found) === "error") ? "error" : "warning";
	const detail = failed.map((found) => (probes.length > 1 ? `${found.slug}: ${detailOf(found)}` : detailOf(found))).join("; ");
	return { name, ok: false, severity, detail };
}

function hostAllowed(repoUrl: string, hosts: readonly string[]): boolean {
	try {
		return hosts.includes(new URL(repoUrl).hostname);
	} catch {
		return /^[^@/\s]+@github\.com:/.test(repoUrl) && hosts.includes("github.com");
	}
}

/** The repositories a service is set up to work on: where chat and events default to (`CHAT_REPOSITORY_URL`) and what its mirror keeps. */
export function configuredRepositories(context: Pick<ServiceContext, "env" | "config">): string[] {
	return [...new Set([context.env.CHAT_REPOSITORY_URL, ...(context.config.git.mirror?.repositories ?? [])].filter((url): url is string => Boolean(url)))];
}

/** The GitHub checks for a role that holds a git token, with the token the way the service holds it (own token per owner, a GitHub App's live token). Nothing without a token or a configured repository. */
export function githubPreflightFor(context: ServiceContext, options: { withoutPullRequests: string; fetch?: typeof fetch }): RoleHooks["preflight"] | undefined {
	const repositories = configuredRepositories(context);
	const holdsToken = Boolean(context.gitToken || context.gitTokenSource || Object.keys(context.ownerTokens ?? {}).length > 0);
	if (!holdsToken || repositories.length === 0) return undefined;
	return githubPreflight({
		repositories,
		token: async (owner) => context.ownerTokens?.[owner] ?? (context.gitTokenSource ? await context.gitTokenSource() : context.gitToken),
		tokenHosts: context.config.git.tokenHosts,
		apiBase: context.config.git.githubApi,
		withoutPullRequests: options.withoutPullRequests,
		...(options.fetch ? { fetch: options.fetch } : {}),
	});
}
