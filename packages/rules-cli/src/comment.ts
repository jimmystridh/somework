import { PLAN_MARKER } from "./plan.ts";

export interface CommentTarget {
	apiUrl: string;
	token: string;
	repo: string;
	pullRequest: number;
}

interface GithubComment {
	id: number;
	body?: string;
}

async function github<T>(target: CommentTarget, method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(`${target.apiUrl.replace(/\/$/, "")}${path}`, {
		method,
		headers: { authorization: `Bearer ${target.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body === undefined ? {} : { "content-type": "application/json" }) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`GitHub ${method} ${path} answered ${response.status}`);
	return (response.status === 204 ? undefined : await response.json()) as T;
}

/** Posts the plan as a pull request comment, or edits the comment an earlier run left (found by its marker), so a pull request carries one plan. */
export async function postPlanComment(target: CommentTarget, markdown: string): Promise<"created" | "updated"> {
	if (!markdown.includes(PLAN_MARKER)) throw new Error("the comment does not carry the plan marker; refusing to post it");
	if (!/^[A-Za-z0-9_-][\w.-]*\/[A-Za-z0-9_-][\w.-]*$/.test(target.repo)) throw new Error(`invalid repository ${JSON.stringify(target.repo)}`);
	const base = `/repos/${target.repo}/issues/${target.pullRequest}/comments`;
	for (let page = 1; ; page++) {
		const comments = await github<GithubComment[]>(target, "GET", `${base}?per_page=100&page=${page}`);
		const existing = comments.find((comment) => comment.body?.includes(PLAN_MARKER));
		if (existing) {
			await github(target, "PATCH", `/repos/${target.repo}/issues/comments/${existing.id}`, { body: markdown });
			return "updated";
		}
		if (comments.length < 100) break;
	}
	await github(target, "POST", base, { body: markdown });
	return "created";
}
