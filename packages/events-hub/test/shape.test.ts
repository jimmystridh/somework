import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shapeOf } from "../src/hub.ts";

describe("what the log says about a delivery that produced no event", () => {
	it("names the keys and the few values that tell the kind of notification, and nothing else", () => {
		const shape = shapeOf({ title: "secret monitor name", body: "x".repeat(500), event_type: "triggered_monitor", status: "Alert\nwith <markup>", org: { name: "Visma" } });
		assert.deepEqual(shape, { keys: ["title", "body", "event_type", "status", "org"], values: { event_type: "triggered_monitor", status: "Alert?with ?markup?" } });
		assert.ok(!JSON.stringify(shape).includes("secret monitor name"));
	});
	it("says what a body is that is not an object", () => {
		assert.equal(shapeOf("text"), "string");
		assert.equal(shapeOf([1]), "array");
		assert.equal(shapeOf(undefined), "undefined");
		assert.equal(shapeOf(null), "object");
	});
});
