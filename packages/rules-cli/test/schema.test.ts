import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateSchema, type Schema } from "../src/schema.ts";

const issues = (value: unknown, schema: Schema) => validateSchema(value, schema).map((issue) => `${issue.path} ${issue.message}`);

describe("schema subset", () => {
	it("checks types, required fields and additionalProperties", () => {
		const schema: Schema = { type: "object", required: ["a"], additionalProperties: false, properties: { a: { type: "integer", minimum: 1 }, b: { type: ["string", "null"] } } };
		assert.deepEqual(issues({ a: 1, b: null }, schema), []);
		assert.deepEqual(issues({ a: 0 }, schema), ["/a must be at least 1"]);
		assert.deepEqual(issues({ a: 1.5 }, schema), ["/a must be integer, got number"]);
		assert.deepEqual(issues({}, schema), ["/a is required"]);
		assert.deepEqual(issues({ a: 1, c: 1 }, schema), ["/c is not allowed"]);
		assert.deepEqual(issues({ a: 1, b: 3 }, schema), ["/b must be string or null, got integer"]);
		assert.deepEqual(issues([], schema), ["/ must be object, got array"]);
	});

	it("checks strings, enums and arrays with the path of the offending item", () => {
		const schema: Schema = { type: "array", maxItems: 2, items: { type: "string", pattern: "^[a-z]+$", maxLength: 3, enum: ["abc", "xy", "toolong"] } };
		assert.deepEqual(issues(["abc", "xy"], schema), []);
		assert.deepEqual(issues(["abc", "Q"], schema), ["/1 must be one of \"abc\", \"xy\", \"toolong\"", "/1 must match ^[a-z]+$"]);
		assert.deepEqual(issues(["abc", "xy", "abc"], schema), ["/ must have at most 2 items"]);
		assert.deepEqual(issues(["toolong"], schema), ["/0 must have at most 3 characters"]);
	});

	it("supports anyOf and oneOf", () => {
		const either: Schema = { oneOf: [{ type: "integer" }, { type: "string" }] };
		assert.deepEqual(issues(3, either), []);
		assert.deepEqual(issues("v", either), []);
		assert.equal(issues(true, either).length, 1);
		assert.deepEqual(issues(null, { anyOf: [{ type: "null" }, { type: "string" }] }), []);
	});

	it("refuses keywords it does not implement instead of ignoring them", () => {
		assert.throws(() => validateSchema(1, { type: "integer", multipleOf: 2 }), /unsupported JSON Schema keyword "multipleOf"/);
		assert.deepEqual(issues(1, { type: "integer", description: "fine", format: "ignored" }), []);
	});
});
