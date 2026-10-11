import { JiraError, type Comment, type Issue, type JiraUser, type SearchHit } from "../src/jira/client.ts";

export interface MemoryIssue {
	key: string;
	summary: string;
	description: string | null;
	environment: string | null;
	type: string;
	project: string;
	status: string;
	labels: string[];
	components: string[];
	priority: string;
	reporter: JiraUser | null;
	attachments: { id: string; filename: string; mimeType?: string }[];
	comments: Comment[];
	created: string;
	assignee: JiraUser | null;
}

export const BOT: JiraUser = { name: "triage-bot", displayName: "Triage Bot", active: true };

export const dana: JiraUser = { name: "dana", displayName: "Dana Dev", emailAddress: "dana@example.test", active: true };

export const issueOf = (key: string, over: Partial<MemoryIssue> = {}): MemoryIssue => ({
	key,
	summary: "The total is wrong on the invoice form",
	description: "Reproduce on the invoice form.",
	environment: null,
	type: "Bug",
	project: key.split("-")[0]!,
	status: "Open",
	labels: [],
	components: [],
	priority: "Medium",
	reporter: dana,
	attachments: [],
	comments: [],
	created: "2026-10-11T07:00:00.000+0000",
	assignee: null,
	...over,
});

/**
 * A ticket system in memory: the same methods the engine and the tools use, and the same state the HTTPS fake serves, with a switch for an outage. `writes`
 * lists every write it was asked to make, so a test can see what the bot did and what it never did.
 */
export class MemoryJira {
	readonly issues = new Map<string, MemoryIssue>();
	readonly users = new Map<string, JiraUser>();
	readonly writes: { op: string; key: string; detail?: unknown }[] = [];
	/** All calls fail while `down`; the next `failNext` calls fail with a 503. */
	down = false;
	failNext = 0;
	/** Fail the next write of this kind once (`labels`, `fields`, `comment`). */
	failWrite: string | undefined;
	/** Make the next comment, then lose the answer: the way a write that was applied can still look like a failure. */
	loseCommentAnswer = false;
	clock = () => "2026-10-11T09:00:00.000+0000";
	/** Called before each call: lets a test change the ticket in between. */
	beforeCall?: (method: string, key?: string) => void;
	#nextComment = 100;
	#nextKey = 900;

	constructor(issues: MemoryIssue[] = []) {
		for (const issue of issues) this.issues.set(issue.key, issue);
		this.users.set("dana", dana);
	}

	#guard(method: string, key?: string): void {
		this.beforeCall?.(method, key);
		if (this.down) throw new JiraError(0, "cannot reach the ticket system: connect ECONNREFUSED");
		if (this.failNext > 0) {
			this.failNext -= 1;
			throw new JiraError(503, `${method} answered 503: service unavailable`);
		}
	}

	#issue(key: string): MemoryIssue {
		const issue = this.issues.get(key);
		if (!issue) throw new JiraError(404, "GET /rest/api/2/issue answered 404: Issue Does Not Exist");
		return issue;
	}

	async getIssue(key: string): Promise<Issue> {
		this.#guard("getIssue", key);
		return this.view(this.#issue(key));
	}

	view(issue: MemoryIssue): Issue {
		return {
			key: issue.key,
			fields: {
				summary: issue.summary,
				description: issue.description,
				environment: issue.environment,
				status: { name: issue.status },
				issuetype: { name: issue.type },
				project: { key: issue.project },
				labels: [...issue.labels],
				components: issue.components.map((name) => ({ name })),
				priority: { name: issue.priority },
				reporter: issue.reporter,
				created: issue.created,
				attachment: issue.attachments.map((file) => ({ ...file })),
				comment: { comments: issue.comments.map((comment) => ({ ...comment })) },
			},
		};
	}

	async comments(key: string): Promise<Comment[]> {
		this.#guard("comments", key);
		return this.#issue(key).comments.map((comment) => ({ ...comment }));
	}

	/** A comment by a person, as a test makes one. */
	say(key: string, author: JiraUser, body: string, created = this.clock()): Comment {
		const comment: Comment = { id: String(this.#nextComment++), author, body, created };
		this.#issue(key).comments.push(comment);
		return comment;
	}

	async addComment(key: string, body: string): Promise<{ id: string }> {
		this.#guard("addComment", key);
		if (this.failWrite === "comment") {
			this.failWrite = undefined;
			throw new JiraError(503, "POST comment answered 503");
		}
		const comment = this.say(key, BOT, body);
		this.writes.push({ op: "comment", key, detail: body });
		if (this.loseCommentAnswer) {
			this.loseCommentAnswer = false;
			throw new JiraError(0, "cannot reach the ticket system: socket hang up");
		}
		return { id: comment.id };
	}

	async updateFields(key: string, fields: Partial<Record<"description" | "environment" | "priority" | "components", unknown>>): Promise<void> {
		this.#guard("updateFields", key);
		if (this.failWrite === "fields") {
			this.failWrite = undefined;
			throw new JiraError(503, "PUT answered 503");
		}
		const issue = this.#issue(key);
		for (const [name, value] of Object.entries(fields)) {
			if (name === "description") issue.description = String(value);
			else if (name === "environment") issue.environment = String(value);
			else if (name === "priority") issue.priority = String((value as { name: string }).name);
			else if (name === "components") issue.components = (value as { name: string }[]).map((component) => component.name);
		}
		this.writes.push({ op: "fields", key, detail: Object.keys(fields) });
	}

	async updateLabels(key: string, change: { add?: readonly string[]; remove?: readonly string[] }): Promise<void> {
		this.#guard("updateLabels", key);
		if (this.failWrite === "labels") {
			this.failWrite = undefined;
			throw new JiraError(503, "PUT answered 503");
		}
		const issue = this.#issue(key);
		for (const label of change.add ?? []) if (!issue.labels.includes(label)) issue.labels.push(label);
		issue.labels = issue.labels.filter((label) => !(change.remove ?? []).includes(label));
		this.writes.push({ op: "labels", key, detail: change });
	}

	async user(name: string): Promise<JiraUser | undefined> {
		this.#guard("user");
		return this.users.get(name);
	}

	async createIssue(issue: { project: string; type: string; summary: string; description: string; environment?: string; labels?: readonly string[]; components?: readonly string[] }): Promise<{ id: string; key: string }> {
		this.#guard("createIssue");
		const key = `${issue.project}-${this.#nextKey++}`;
		this.issues.set(key, issueOf(key, { summary: issue.summary, description: issue.description, environment: issue.environment ?? null, type: issue.type, labels: [...(issue.labels ?? [])], components: [...(issue.components ?? [])], reporter: BOT, created: this.clock() }));
		this.writes.push({ op: "create", key, detail: issue });
		return { id: String(this.#nextKey), key };
	}

	async search(jql: string, maxResults = 10): Promise<{ total: number; issues: SearchHit[] }> {
		this.#guard("search");
		const hits = this.match(jql).slice(0, maxResults);
		return { total: hits.length, issues: hits.map((issue) => ({ key: issue.key, fields: { summary: issue.summary, status: { name: issue.status }, issuetype: { name: issue.type }, created: issue.created, labels: [...issue.labels] } })) };
	}

	/** Just enough JQL for the queries this role makes: `project in (...)` or `project = X`, `text ~ "..."` and `labels = "x"` (a `created >=` clause is read as: all). */
	match(jql: string): MemoryIssue[] {
		const single = /project\s*=\s*([A-Z0-9_]+)/i.exec(jql)?.[1];
		const projects = /project\s+in\s+\(([^)]*)\)/i.exec(jql)?.[1]?.split(",").map((value) => value.trim()) ?? (single ? [single] : undefined);
		const terms = /text\s*~\s*"([^"]*)"/i.exec(jql)?.[1]?.toLowerCase().split(/\s+/).filter(Boolean);
		const label = /labels\s*=\s*"([^"]*)"/i.exec(jql)?.[1];
		return [...this.issues.values()]
			.filter((issue) => !projects || projects.includes(issue.project))
			.filter((issue) => !terms || terms.some((term) => `${issue.summary} ${issue.description ?? ""}`.toLowerCase().includes(term)))
			.filter((issue) => !label || issue.labels.includes(label))
			.sort((a, b) => b.created.localeCompare(a.created));
	}

	browseUrl(key: string): string {
		return `https://jira.example.test/browse/${key}`;
	}

	/** The ticket as stored, for assertions. */
	get(key: string): MemoryIssue {
		return this.#issue(key);
	}
}
