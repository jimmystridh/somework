import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import type { TestTls } from "./tls.ts";

export const PAT = "pat_test_token_0123456789abcdef";

export interface FakeIssue {
	key: string;
	summary: string;
	status: { name: string; statusCategory: { key: string } };
	assignee: { name: string; displayName: string } | null;
	labels: string[];
	comments: { id: string; author: { displayName: string }; body: string; created: string }[];
	attachments: { id: string; filename: string; size: number }[];
	histories: { created: string; author: { displayName: string }; items: { field: string; from?: string | null; fromString?: string | null; to?: string | null; toString?: string | null }[] }[];
}

export const testIssue = (key = "QA-1", over: Partial<FakeIssue> = {}): FakeIssue => ({
	key,
	summary: "The total is wrong on the invoice form",
	status: { name: "Test", statusCategory: { key: "indeterminate" } },
	assignee: null,
	labels: ["Frontend"],
	comments: [],
	attachments: [],
	histories: [{ created: "2026-10-01T10:00:00.000+0200", author: { displayName: "Dana Dev" }, items: [{ field: "assignee", from: "dana", fromString: "Dana Dev", to: null, toString: null }] }],
	...over,
});

export interface Transition {
	id: string;
	name: string;
	to: { name: string; statusCategory: { key: string } };
	/** What the workflow does besides changing the status. */
	assignTo?: { name: string; displayName: string };
}

export const DEFAULT_TRANSITIONS: Transition[] = [
	{ id: "11", name: "Back to work", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
	{ id: "31", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
];

/** A stand-in for the ticket system: HTTPS that demands a client certificate and a bearer token, and keeps issues in memory. */
export class FakeJira {
	readonly issues = new Map<string, FakeIssue>();
	readonly requests: { method: string; path: string; body?: string }[] = [];
	transitions: Transition[] = DEFAULT_TRANSITIONS;
	/** Users by the key or name the changelog records. */
	readonly users = new Map<string, { name: string; key: string; displayName: string; active: boolean }>();
	/** Accept an assignment (204) without applying it. */
	ignoreAssign = false;
	/** Called before each request is handled: lets a test change the issue between two calls of the tool. */
	beforeRequest?: (method: string, path: string) => void;
	url = "";
	#server!: Server;

	static async start(tls: TestTls, issues: FakeIssue[] = [testIssue()]): Promise<FakeJira> {
		const jira = new FakeJira();
		for (const issue of issues) jira.issues.set(issue.key, issue);
		jira.#server = createServer({ key: tls.serverKey, cert: tls.serverCert, ca: tls.ca, requestCert: true, rejectUnauthorized: true }, (req, res) => jira.#handle(req, res));
		await new Promise<void>((resolve) => jira.#server.listen(0, "127.0.0.1", resolve));
		jira.url = `https://127.0.0.1:${(jira.#server.address() as AddressInfo).port}`;
		return jira;
	}

	async close(): Promise<void> {
		this.#server.closeAllConnections();
		await new Promise<void>((resolve) => this.#server.close(() => resolve()));
	}

	#view(issue: FakeIssue, changelog: boolean) {
		return {
			key: issue.key,
			fields: { summary: issue.summary, description: "Reproduce on the invoice form.", status: issue.status, assignee: issue.assignee, labels: issue.labels, components: [{ name: "frontend" }], issuetype: { name: "Bug" }, comment: { comments: issue.comments }, attachment: issue.attachments },
			...(changelog ? { changelog: { histories: issue.histories } } : {}),
		};
	}

	#handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const url = new URL(req.url!, "https://x");
			const body = Buffer.concat(chunks);
			const reply = (status: number, value?: unknown) => {
				res.statusCode = status;
				if (value !== undefined) {
					res.setHeader("content-type", "application/json");
					res.end(JSON.stringify(value));
				} else res.end();
			};
			this.requests.push({ method: req.method!, path: url.pathname + url.search, body: (req.headers["content-type"] ?? "").startsWith("multipart") ? `<${body.length} bytes>` : body.toString("utf8") });
			if (req.headers.authorization !== `Bearer ${PAT}`) return reply(401, { errorMessages: ["bad token"] });
			this.beforeRequest?.(req.method!, url.pathname);
			const parts = url.pathname.split("/").filter(Boolean); // rest api 2 issue KEY ...
			if (url.pathname === "/rest/api/2/user") {
				const ref = url.searchParams.get("key") ?? url.searchParams.get("username") ?? "";
				const user = this.users.get(ref);
				return user ? reply(200, user) : reply(404, { errorMessages: ["no such user"] });
			}
			if (url.pathname === "/rest/api/2/myself") return reply(200, { name: "qa-bot", displayName: "QA Bot" });
			if (url.pathname === "/rest/api/2/search") {
				const issues = [...this.issues.values()].map((issue) => this.#view(issue, false));
				return reply(200, { total: issues.length, issues });
			}
			if (parts[0] !== "rest" || parts[3] !== "issue") return reply(404, { errorMessages: ["no such route"] });
			const issue = this.issues.get(parts[4] ?? "");
			if (!issue) return reply(404, { errorMessages: ["Issue Does Not Exist"] });
			const sub = parts[5];
			const json = () => (body.length ? JSON.parse(body.toString("utf8")) : {});
			if (!sub && req.method === "GET") return reply(200, this.#view(issue, url.searchParams.get("expand") === "changelog"));
			if (!sub && req.method === "PUT") {
				for (const op of json().update?.labels ?? []) {
					if (op.add && !issue.labels.includes(op.add)) issue.labels.push(op.add);
					if (op.remove) issue.labels = issue.labels.filter((label) => label !== op.remove);
				}
				return reply(204);
			}
			if (sub === "comment" && req.method === "GET") return reply(200, { comments: issue.comments });
			if (sub === "comment" && req.method === "POST") {
				const comment = { id: String(issue.comments.length + 100), author: { displayName: "QA Bot" }, body: json().body as string, created: "2026-10-05T12:00:00.000+0200" };
				issue.comments.push(comment);
				return reply(201, { id: comment.id });
			}
			if (sub === "transitions" && req.method === "GET") return reply(200, { transitions: this.transitions.map(({ assignTo: _a, ...t }) => t) });
			if (sub === "transitions" && req.method === "POST") {
				const transition = this.transitions.find((t) => t.id === json().transition?.id);
				if (!transition) return reply(400, { errorMessages: ["bad transition"] });
				issue.status = transition.to;
				if (transition.assignTo) issue.assignee = transition.assignTo;
				return reply(204);
			}
			if (sub === "assignee" && req.method === "PUT") {
				const who = json();
				if (this.ignoreAssign) return reply(204);
				issue.assignee = { name: who.name ?? who.key, displayName: who.name ?? who.key };
				return reply(204);
			}
			if (sub === "attachments" && req.method === "POST") {
				const name = /filename="([^"]+)"/.exec(body.toString("latin1"))?.[1] ?? "file";
				issue.attachments.push({ id: String(issue.attachments.length + 500), filename: name, size: body.length });
				return reply(200, [{ id: String(issue.attachments.length + 499), filename: name }]);
			}
			reply(404, { errorMessages: ["no such route"] });
		});
	}
}
