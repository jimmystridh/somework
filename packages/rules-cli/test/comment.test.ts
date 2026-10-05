import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { run } from "../src/cli.ts";
import { postPlanComment } from "../src/comment.ts";
import { PLAN_MARKER } from "../src/plan.ts";

let server: Server;
let apiUrl: string;
let comments: { id: number; body: string }[] = [];
const seen: string[] = [];
let status = 200;

before(async () => {
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
			const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
			const reply = (code: number, payload?: unknown) => {
				res.writeHead(code, { "content-type": "application/json" });
				res.end(payload === undefined ? "" : JSON.stringify(payload));
			};
			if (status !== 200) return reply(status, { message: "nope" });
			if (req.method === "GET") return reply(200, comments.slice(0, 100));
			if (req.method === "POST") {
				comments.push({ id: comments.length + 1, body: body.body });
				return reply(201, comments.at(-1));
			}
			const id = Number(/comments\/(\d+)$/.exec(req.url!)![1]);
			comments.find((comment) => comment.id === id)!.body = body.body;
			return reply(200, {});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());
beforeEach(() => {
	comments = [];
	seen.length = 0;
	status = 200;
});

const target = () => ({ apiUrl, token: "t0ken", repo: "example-org/example-repo", pullRequest: 12 });

describe("plan comment", () => {
	it("creates the comment once and updates it on the next run", async () => {
		comments.push({ id: 100, body: "an unrelated comment" });
		assert.equal(await postPlanComment(target(), `${PLAN_MARKER}\nfirst`), "created");
		assert.equal(await postPlanComment(target(), `${PLAN_MARKER}\nsecond`), "updated");
		assert.equal(comments.length, 2);
		assert.equal(comments[1]!.body, `${PLAN_MARKER}\nsecond`);
		assert.equal(comments[0]!.body, "an unrelated comment");
		assert.ok(seen.every((line) => line.endsWith("Bearer t0ken")));
		assert.ok(seen.some((line) => line.startsWith("POST /repos/example-org/example-repo/issues/12/comments")));
	});

	it("refuses text without the marker and a repository that is not owner/name", async () => {
		await assert.rejects(postPlanComment(target(), "just text"), /plan marker/);
		await assert.rejects(postPlanComment({ ...target(), repo: "../x" }, PLAN_MARKER), /invalid repository/);
		assert.equal(seen.length, 0);
	});

	it("fails with the status when GitHub refuses", async () => {
		status = 403;
		await assert.rejects(postPlanComment(target(), PLAN_MARKER), /answered 403/);
	});

	it("is a CLI command that needs its arguments and the token", async () => {
		const file = join(mkdtempSync(join(tmpdir(), "comment-")), "plan.md");
		writeFileSync(file, `${PLAN_MARKER}\nhello`);
		const out: string[] = [];
		const err: string[] = [];
		const io = (env: Record<string, string>) => ({ stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text), env });
		assert.equal(await run(["comment", "--file", file, "--repo", "example-org/example-repo", "--pr", "12"], io({})), 2);
		assert.match(err.join(""), /comment needs --file, --repo, --pr and GITHUB_TOKEN/);
		assert.equal(await run(["comment", "--file", file, "--repo", "example-org/example-repo", "--pr", "12"], io({ GITHUB_TOKEN: "t0ken", GITHUB_API_URL: apiUrl })), 0);
		assert.match(out.join(""), /plan comment created/);
		assert.equal(comments[0]!.body, `${PLAN_MARKER}\nhello`);
	});
});
