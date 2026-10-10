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
	it("is accepted and approved by a real domain, and served in its catalog with its contract", async () => {
		domain = await startDomain({ cardFile });
		const found = await domain.worker().get("/v1/capabilities/qa.verify/1");
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

	it("declares the shape of a verification: no extra keys, a budget is required, keys are bounded", () => {
		const schema = card.capabilities[0]!.inputSchema as any;
		assert.equal(schema.additionalProperties, false);
		assert.deepEqual(schema.required, ["ticket", "repository", "budget"]);
		assert.deepEqual([schema.properties.ticket.minLength, schema.properties.ticket.maxLength], [1, 40]);
		assert.match("nope", new RegExp(schema.properties.app.pattern));
		assert.doesNotMatch("Not Valid", new RegExp(schema.properties.app.pattern));
		assert.equal(schema.properties.budget.additionalProperties, false);
		assert.equal(schema.properties.budget.properties.maxTokens.minimum, 1000);
		assert.equal(schema.properties.repository.additionalProperties, false);
	});
});
