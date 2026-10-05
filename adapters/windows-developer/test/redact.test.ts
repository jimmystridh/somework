import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactLog } from "../src/redact.ts";

describe("redactLog", () => {
	it("removes token-like text and the service's own secrets", () => {
		const text = ["push ghp_abcdefghijklmnopqrstuvwxyz0123456789", "Authorization: Bearer abcdef0123456789abcdef", "password=hunter2hunter2", "clone https://user:s3cr3tpw@git.example/x.git", "literal-secret-value-12345 stays out", "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----", "build ok 12:00"].join("\n");
		const out = redactLog(text, ["literal-secret-value-12345"]);
		for (const leaked of ["ghp_abc", "abcdef0123456789abcdef", "hunter2", "s3cr3tpw", "literal-secret", "AAAA"]) assert.ok(!out.includes(leaked), leaked);
		assert.match(out, /build ok 12:00/);
	});

	it("ignores secrets too short to be secrets, so ordinary words survive", () => {
		assert.equal(redactLog("a build of ok", ["ok"]), "a build of ok");
	});
});
