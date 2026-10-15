import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { BOT, MemoryJira, type MemoryIssue } from "./memory-jira.ts";
import type { TestTls } from "./tls.ts";

export const PAT = "pat_test_token_0123456789abcdef";

/** A stand-in for the ticket system: HTTPS that demands a client certificate and a bearer token, over the same in-memory tickets as `MemoryJira`. */
export class FakeJira {
	readonly memory: MemoryJira;
	readonly requests: { method: string; path: string; body?: string }[] = [];
	/** The next requests are not answered at all (`hang`) or answered with a 503 (`fail`), the way an overloaded ticket system behaves. */
	hang = 0;
	fail = 0;
	url = "";
	#server!: Server;

	constructor(issues: MemoryIssue[]) {
		this.memory = new MemoryJira(issues);
	}

	static async start(tls: TestTls, issues: MemoryIssue[] = []): Promise<FakeJira> {
		const jira = new FakeJira(issues);
		jira.#server = createServer({ key: tls.serverKey, cert: tls.serverCert, ca: tls.ca, requestCert: true, rejectUnauthorized: true }, (req, res) => jira.#handle(req, res));
		await new Promise<void>((resolve) => jira.#server.listen(0, "127.0.0.1", resolve));
		jira.url = `https://127.0.0.1:${(jira.#server.address() as AddressInfo).port}`;
		return jira;
	}

	async close(): Promise<void> {
		this.#server.closeAllConnections();
		await new Promise<void>((resolve) => this.#server.close(() => resolve()));
	}

	#handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			void this.#route(req, res, Buffer.concat(chunks).toString("utf8")).catch((error) => {
				res.statusCode = error?.status ?? 500;
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ errorMessages: [String(error?.message ?? error)] }));
			});
		});
	}

	async #route(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, body: string): Promise<void> {
		const url = new URL(req.url!, "https://x");
		const reply = (status: number, value?: unknown) => {
			res.statusCode = status;
			if (value !== undefined) {
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(value));
			} else res.end();
		};
		this.requests.push({ method: req.method!, path: url.pathname + url.search, body });
		if (req.headers.authorization !== `Bearer ${PAT}`) return reply(401, { errorMessages: ["bad token"] });
		if (this.hang > 0) {
			this.hang -= 1;
			return;
		}
		if (this.fail > 0) {
			this.fail -= 1;
			return reply(503, { errorMessages: ["service unavailable"] });
		}
		const json = () => (body ? JSON.parse(body) : {});
		const parts = url.pathname.split("/").filter(Boolean); // rest api 2 ...
		if (url.pathname === "/rest/api/2/myself") return reply(200, BOT);
		if (url.pathname === "/rest/api/2/user") {
			const user = await this.memory.user(url.searchParams.get("username") ?? "");
			return user ? reply(200, user) : reply(404, { errorMessages: ["no such user"] });
		}
		if (/^\/rest\/api\/2\/project\/[A-Z]+\/components$/.test(url.pathname)) return reply(200, [...this.memory.projectComponentList.map((component, index) => ({ id: String(index), ...component })), { id: "x" }]);
		if (url.pathname === "/rest/api/2/search") return reply(200, await this.memory.search(url.searchParams.get("jql") ?? "", Number(url.searchParams.get("maxResults") ?? 10)));
		if (url.pathname === "/rest/api/2/issue" && req.method === "POST") {
			const fields = json().fields;
			const created = await this.memory.createIssue({ project: fields.project.key, type: fields.issuetype.name, summary: fields.summary, description: fields.description, environment: fields.environment, labels: fields.labels, components: fields.components?.map((component: { name: string }) => component.name) });
			return reply(201, created);
		}
		if (parts[3] !== "issue" || !parts[4]) return reply(404, { errorMessages: ["no such route"] });
		const key = parts[4];
		const sub = parts[5];
		if (!sub && req.method === "GET") return reply(200, await this.memory.getIssue(key));
		if (!sub && req.method === "PUT") {
			const payload = json();
			if (payload.fields) await this.memory.updateFields(key, payload.fields);
			const operations: { add?: string; remove?: string }[] = payload.update?.labels ?? [];
			if (operations.length > 0) await this.memory.updateLabels(key, { add: operations.flatMap((op) => (op.add ? [op.add] : [])), remove: operations.flatMap((op) => (op.remove ? [op.remove] : [])) });
			return reply(204);
		}
		if (sub === "comment" && req.method === "GET") return reply(200, { comments: await this.memory.comments(key) });
		if (sub === "comment" && req.method === "POST") return reply(201, await this.memory.addComment(key, json().body));
		return reply(404, { errorMessages: ["no such route"] });
	}
}
