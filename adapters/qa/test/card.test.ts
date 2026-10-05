import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startDomain, type Domain } from "../../../sdk/typescript/test/harness.ts";
import card from "../card.json" with { type: "json" };
import { qaProfile } from "../src/profile.ts";

const cardFile = fileURLToPath(new URL("../card.json", import.meta.url));
let domain: Domain | undefined;
afterEach(async () => {
	await domain?.close();
	domain = undefined;
});

describe("the QA card", () => {
	it("is accepted and approved by a real domain, and served with its contract", async () => {
		domain = await startDomain({ cardFile, mayInvoke: "qa.*" });
		const found = await domain.author.get("/v1/capabilities/qa.verify/1");
		assert.equal(found.id, "qa.verify");
		assert.equal(found.version, "1");
		assert.equal(found.sideEffects, "write");
		assert.deepEqual(found.inputSchema.required, ["ticket", "repository", "budget"]);
	});

	it("is a card that agrees with the profile that serves it", () => {
		assert.deepEqual(qaProfile().capabilities, card.capabilities.map(({ id, version }) => ({ id, version })));
		assert.equal(card.capabilities[0]!.timeoutSeconds, 3600);
		assert.deepEqual((card.capabilities[0]!.inputSchema as any).required, ["ticket", "repository", "budget"]);
	});

	it("refuses input that is not shaped like a verification (no extra keys, a budget is required, keys are bounded)", async () => {
		domain = await startDomain({ cardFile, mayInvoke: "qa.*" });
		const valid = { ticket: "QA-1", repository: { url: "https://example.test/r.git", ref: "main" }, budget: { maxTokens: 10_000, maxMinutes: 5 } };
		const submit = (input: unknown) => domain!.author.submitTask({ capability: { id: "qa.verify", version: "1" }, input });
		for (const bad of [{ ...valid, command: "rm -rf /" }, { ...valid, budget: undefined }, { ...valid, ticket: "" }, { ...valid, ticket: "x".repeat(41) }, { ...valid, app: "Not Valid" }, { ...valid, budget: { maxTokens: 10, maxMinutes: 5 } }]) {
			await assert.rejects(() => submit(bad), /schema_violation/, JSON.stringify(bad).slice(0, 80));
		}
		const task = await submit(valid);
		assert.ok(task.taskId, "a valid verification is accepted");
	});
});
