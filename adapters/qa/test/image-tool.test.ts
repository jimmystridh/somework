import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { PiDurableRuntime, type AgentRequest } from "@somework/agent-kit";
import { scriptedModels } from "@somework/agent-kit/providers/faux";
import { createImageTools, imageTypeOf, MAX_IMAGE_BYTES } from "../src/image-tool.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);

describe("imageTypeOf", () => {
	it("knows the pictures the model accepts and nothing else", () => {
		assert.equal(imageTypeOf(PNG), "image/png");
		assert.equal(imageTypeOf(JPEG), "image/jpeg");
		assert.equal(imageTypeOf(Buffer.from("GIF89a....")), "image/gif");
		assert.equal(imageTypeOf(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])), "image/webp");
		assert.equal(imageTypeOf(Buffer.from("just text")), undefined);
		assert.equal(imageTypeOf(Buffer.alloc(0)), undefined);
	});
});

describe("view_image", () => {
	const open: PiDurableRuntime[] = [];
	afterEach(async () => {
		for (const runtime of open.splice(0)) await runtime.close();
	});
	const root = realpathSync(mkdtempSync(join(tmpdir(), "qa-image-")));
	mkdirSync(join(root, ".qa", "job-1", "screenshots"), { recursive: true });
	writeFileSync(join(root, ".qa", "job-1", "screenshots", "shot.png"), PNG);
	writeFileSync(join(root, ".qa", "job-1", "notes.txt"), "not a picture");
	writeFileSync(join(root, ".qa", "job-1", "big.jpg"), Buffer.concat([JPEG, Buffer.alloc(MAX_IMAGE_BYTES)]));
	const run = async (path: string) => {
		const tool = createImageTools({ root }).extension.tools[0] as any;
		const result = await tool.execute({ path }, {}, {});
		return { isError: result.isError, content: result.content as any[] };
	};

	it("returns the picture itself, with its type", async () => {
		const result = await run(join(root, ".qa", "job-1", "screenshots", "shot.png"));
		assert.equal(result.isError, undefined);
		const image = result.content.find((part) => part.type === "image");
		assert.equal(image.mimeType, "image/png");
		assert.equal(Buffer.from(image.data, "base64").equals(PNG), true);
	});

	it("opens the file when the model ended the path with a stray word or character", async () => {
		const path = join(root, ".qa", "job-1", "screenshots", "shot.png");
		for (const junk of ["市", " У", "? ", " suivi"]) assert.equal((await run(`${path}${junk}`)).content.some((part) => part.type === "image"), true, junk);
	});

	it("refuses what is not a picture, what is too big, what is missing and what is outside the workspace", async () => {
		assert.match((await run(join(root, ".qa", "job-1", "notes.txt"))).content[0].text, /not a png, jpeg, gif or webp/);
		assert.match((await run(join(root, ".qa", "job-1", "big.jpg"))).content[0].text, /scale it down first.*ffmpeg/);
		assert.match((await run(join(root, ".qa", "job-1", "missing.png"))).content[0].text, /could not open/);
		const outside = await run("C:/Windows/win.ini");
		assert.equal(outside.isError, true);
		assert.match(outside.content[0].text, /refused|could not open/);
	});

	it("reaches the model on its next request as an image, through the durable runtime", async () => {
		const contexts: any[] = [];
		const fake = scriptedModels([`call:view_image:${JSON.stringify({ path: join(root, ".qa", "job-1", "screenshots", "shot.png") })}`, "final:I see a picture"], (context) => contexts.push(context));
		const dir = mkdtempSync(join(tmpdir(), "qa-image-rt-"));
		const workspace = join(dir, "ws");
		mkdirSync(workspace);
		const runtime = new PiDurableRuntime({ storagePath: join(dir, "state.sqlite"), models: fake.models, model: fake.model, env: (cwd) => new NodeExecutionEnv({ cwd: cwd ?? dir }), allowedTools: ["read", "bash", "view_image"], extensions: [createImageTools({ root }).extension] });
		open.push(runtime);
		await runtime.start();
		const request: AgentRequest = { requestId: "j1", agentKey: "k", instruction: "look", workspace, budget: { maxTokens: 1_000_000, maxMinutes: 5 } };
		const outcome = await runtime.execute(request, { signal: new AbortController().signal, onProgress: () => {}, requestApproval: async () => ({ approved: true }) });
		assert.equal(outcome.status, "done");
		const last = JSON.stringify(contexts.at(-1));
		assert.match(last, /"type":"image"/, "the second request carries the picture");
		assert.match(last, new RegExp(Buffer.from(PNG).toString("base64").slice(0, 24)));
	});
});
