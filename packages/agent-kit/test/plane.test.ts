import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { htmlOf, PlaneClient, PlaneError } from "../src/plane/client.ts";
import { resolvePlane } from "../src/plane/config.ts";
import { createPlaneTools, PLANE_TOOL_NAMES } from "../src/plane/tools.ts";

interface Seen {
	method: string;
	path: string;
	query: URLSearchParams;
	headers: IncomingMessage["headers"];
	body: any;
}

const PROJECT = "0b6a3f1e-5c4d-4e8a-9f21-7d3c1a2b4e5f";
const OTHER_PROJECT = "11111111-2222-4333-8444-555555555555";
const FIRST = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const KEY_VALUE = "plane-key-secret-value";

const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise((r) => { server.closeAllConnections(); server.close(r); });
});

/** A stand-in for Plane that records the request and answers what the test says. */
async function plane(answer: (seen: Seen) => { status: number; body: unknown }) {
	const seen: Seen[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			const url = new URL(req.url ?? "/", "http://plane.test");
			const record: Seen = { method: req.method ?? "", path: url.pathname, query: url.searchParams, headers: req.headers, body: text ? JSON.parse(text) : undefined };
			seen.push(record);
			const { status, body } = answer(record);
			res.writeHead(status, { "content-type": "application/json" });
			res.end(typeof body === "string" ? body : JSON.stringify(body));
		});
	});
	servers.push(server);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const client = new PlaneClient({ baseUrl, workspace: "acme", projectId: PROJECT, apiKey: () => KEY_VALUE, labels: ["feature", "bug", "product-feedback"] });
	return { seen, client };
}

const workItem = (extra: object = {}) => ({ id: FIRST, name: "Add a thing", sequence_id: 7, project: PROJECT, project_detail: { identifier: "CLU" }, state: "Backlog", priority: "none", labels: [], description_html: "<p>Why</p><ul><li>one</li></ul>", ...extra });
const LABELS = [{ id: "lbl-feature", name: "Feature" }, { id: "lbl-bug", name: "bug" }, { id: "lbl-fb", name: "product-feedback" }];

describe("the Plane client", () => {
	it("files a ticket in the one project with the key, no priority, a label and an external id", async () => {
		const { seen, client } = await plane((req) => (req.method === "GET" ? { status: 200, body: { results: LABELS } } : { status: 201, body: workItem() }));
		const made = await client.create({ title: "Add a thing", description: "Why\n\n- one\n- two <b>", label: "feature", externalId: "conv-1" });
		assert.equal(made.created, true);
		assert.equal(made.key, "CLU-7");
		assert.equal(seen[1]!.method, "POST");
		assert.equal(seen[1]!.path, `/api/v1/workspaces/acme/projects/${PROJECT}/work-items/`);
		assert.equal(seen[1]!.headers["x-api-key"], KEY_VALUE);
		assert.deepEqual(seen[1]!.body, { name: "Add a thing", description_html: "<p>Why</p><ul><li>one</li><li>two &lt;b&gt;</li></ul>", priority: "none", labels: ["lbl-feature"], external_id: "conv-1", external_source: "somework-product-manager" });
		assert.ok(!("state" in seen[1]!.body) && !("assignees" in seen[1]!.body));
	});

	it("returns the first ticket when the external id is filed again, and creates nothing", async () => {
		const { seen, client } = await plane((req) => (req.method === "POST" ? { status: 409, body: { error: "Issue with the same external id and external source already exists", id: FIRST } } : req.path.endsWith("/labels/") ? { status: 200, body: LABELS } : { status: 200, body: workItem() }));
		const again = await client.create({ title: "Add a thing", description: "Why", label: "bug", externalId: "conv-1" });
		assert.equal(again.created, false);
		assert.equal(again.id, FIRST);
		assert.equal(seen.filter((request) => request.method === "POST").length, 1);
	});

	it("refuses a label outside the list and a label the project lacks, before filing anything", async () => {
		const { seen, client } = await plane((req) => (req.path.endsWith("/labels/") ? { status: 200, body: [LABELS[0]] } : { status: 201, body: workItem() }));
		await assert.rejects(client.create({ title: "x y z", description: "d", label: "urgent", externalId: "c" }), /must be one of: feature, bug, product-feedback/);
		await assert.rejects(client.create({ title: "x y z", description: "d", label: "bug", externalId: "c" }), /no label "bug"/);
		assert.equal(seen.filter((request) => request.method === "POST").length, 0);
	});

	it("reads a ticket by key or id and refuses one of another project", async () => {
		const { seen, client } = await plane((req) => (req.path.includes("CLU-9") ? { status: 200, body: workItem({ project: OTHER_PROJECT }) } : req.path.includes("CLU-404") ? { status: 404, body: { error: "not found" } } : { status: 200, body: workItem() }));
		const ticket = await client.get("CLU-7");
		assert.equal(seen[0]!.path, "/api/v1/workspaces/acme/work-items/CLU-7/");
		assert.equal(ticket.description, "Why\none");
		assert.equal((await client.get(FIRST.toUpperCase())).id, FIRST);
		assert.equal(seen[1]!.path, `/api/v1/workspaces/acme/projects/${PROJECT}/work-items/${FIRST}/`);
		await assert.rejects(client.get("CLU-9"), /not in this project|no ticket CLU-9 in this project/);
		await assert.rejects(client.get("CLU-404"), /there is no ticket CLU-404/);
		await assert.rejects(client.get("../../projects"), /named by its key/);
	});

	it("searches inside the project only", async () => {
		const { seen, client } = await plane(() => ({ status: 200, body: { issues: [{ id: FIRST, name: "Mine", sequence_id: 1, project__identifier: "CLU", project_id: PROJECT }, { id: "b", name: "Other", sequence_id: 2, project__identifier: "ZZZ", project_id: OTHER_PROJECT }] } }));
		const found = await client.search("thing", 99);
		assert.deepEqual(found.map((ticket) => ticket.key), ["CLU-1"]);
		assert.equal(seen[0]!.path, "/api/v1/workspaces/acme/work-items/search/");
		assert.equal(seen[0]!.query.get("project_id"), PROJECT);
		assert.equal(seen[0]!.query.get("limit"), "25");
	});

	it("comments on a ticket of the project", async () => {
		const { seen, client } = await plane((req) => (req.method === "GET" ? { status: 200, body: workItem() } : { status: 201, body: {} }));
		await client.comment("CLU-7", "QA says it fails <script>");
		assert.equal(seen[1]!.path, `/api/v1/workspaces/acme/projects/${PROJECT}/work-items/${FIRST}/comments/`);
		assert.equal(seen[1]!.body.comment_html, "<p>QA says it fails &lt;script&gt;</p>");
	});

	it("passes on Plane's reason in one sentence and never the key", async () => {
		const { client } = await plane(() => ({ status: 401, body: { detail: "Given API token is not valid" } }));
		await assert.rejects(client.search("thing"), (error: unknown) => error instanceof PlaneError && error.status === 401 && /not valid/.test(error.message) && !error.message.includes(KEY_VALUE));
		const down = new PlaneClient({ baseUrl: "http://127.0.0.1:9", workspace: "acme", projectId: PROJECT, apiKey: () => KEY_VALUE, labels: ["bug"], timeoutMs: 500 });
		await assert.rejects(down.search("thing"), /could not be reached/);
		const { client: confused } = await plane(() => ({ status: 200, body: "<html>" }));
		await assert.rejects(confused.search("thing"), /not JSON/);
	});

	it("has no way to change, move, assign or delete a ticket", () => {
		const methods = Object.getOwnPropertyNames(PlaneClient.prototype).filter((name) => name !== "constructor");
		assert.deepEqual(methods.sort(), ["comment", "create", "get", "labels", "search"]);
	});
});

describe("plain text as Plane's HTML", () => {
	it("escapes everything and keeps paragraphs, breaks and lists", () => {
		assert.equal(htmlOf("a & b\nsecond line\n\n<img src=x onerror=1>"), "<p>a &amp; b<br>second line</p><p>&lt;img src=x onerror=1&gt;</p>");
		assert.equal(htmlOf("- one\n- two"), "<ul><li>one</li><li>two</li></ul>");
	});
});

describe("the Plane tools", () => {
	it("name the four tools and key a filing by the conversation, not by anything the model says", async () => {
		const { seen, client } = await plane((req) => (req.method === "GET" ? { status: 200, body: LABELS } : { status: 201, body: workItem() }));
		const { extension, toolNames } = createPlaneTools(client, (api) => api.conversationId);
		assert.deepEqual(toolNames, [...PLANE_TOOL_NAMES]);
		const tools = new Map<string, any>((extension as any).tools.map((tool: any) => [tool.name, tool]));
		const filed = await tools.get("plane_create").execute({ title: "Add a thing", description: "Why", kind: "feature" }, { conversationId: "conv-9" });
		assert.match(filed.content[0].text, /^filed CLU-7: Add a thing/);
		await tools.get("plane_create").execute({ title: "Second", description: "Why", kind: "bug", part: "2" }, { conversationId: "conv-9" });
		const posts = seen.filter((request) => request.method === "POST");
		assert.deepEqual(posts.map((request) => request.body.external_id), ["conv-9", "conv-9:2"]);
		const none = await tools.get("plane_create").execute({ title: "Add a thing", description: "Why", kind: "feature" }, {});
		assert.equal(none.isError, true);
		assert.match(none.content[0].text, /not part of a conversation/);
	});

	it("tell a duplicate from a new ticket, and say what Plane refused", async () => {
		const { client } = await plane((req) => (req.method === "POST" ? { status: 409, body: { error: "dup", id: FIRST } } : req.path.endsWith("/labels/") ? { status: 200, body: LABELS } : { status: 200, body: workItem() }));
		const tools = new Map<string, any>((createPlaneTools(client, () => "c").extension as any).tools.map((tool: any) => [tool.name, tool]));
		const again = await tools.get("plane_create").execute({ title: "Add a thing", description: "Why", kind: "feature" }, {});
		assert.match(again.content[0].text, /nothing was filed: this conversation already has CLU-7[\s\S]*plane_comment/);
		const refused = await tools.get("plane_create").execute({ title: "Add a thing", description: "Why", kind: "nope" }, {});
		assert.equal(refused.isError, true);
		assert.match(refused.content[0].text, /must be one of/);
		assert.equal((await tools.get("plane_get").execute({ ticket: "CLU-7" })).content[0].text.startsWith("CLU-7: Add a thing (Backlog)"), true);
	});
});

describe("Plane settings", () => {
	const complete = { PLANE_BASE_URL: "https://plane.example.internal/", PLANE_API_KEY_FILE: "/k", PLANE_WORKSPACE_SLUG: "acme", PLANE_PROJECT_ID: PROJECT.toUpperCase() };

	it("are off without PLANE_BASE_URL, and need the key file, workspace and project when on", () => {
		assert.equal(resolvePlane({}).enabled, false);
		assert.throws(() => resolvePlane({ PLANE_BASE_URL: "https://p" }), /PLANE_API_KEY_FILE/);
		assert.throws(() => resolvePlane({ ...complete, PLANE_WORKSPACE_SLUG: "" }), /PLANE_WORKSPACE_SLUG/);
		assert.throws(() => resolvePlane({ ...complete, PLANE_PROJECT_ID: "x" }), /PLANE_PROJECT_ID/);
		assert.throws(() => resolvePlane({ ...complete, PLANE_BASE_URL: "ftp://p" }), /http or https/);
		assert.throws(() => resolvePlane({ ...complete, PLANE_LABELS: "Bad Label" }), /PLANE_LABELS/);
	});

	it("resolve the address without a trailing slash and the project id in lower case", () => {
		assert.deepEqual(resolvePlane({ ...complete, PLANE_CA_FILE: "/ca", PLANE_LABELS: "bug, feature" }), { enabled: true, baseUrl: "https://plane.example.internal", apiKeyFile: "/k", workspace: "acme", projectId: PROJECT, caFile: "/ca", labels: ["bug", "feature"] });
	});
});
