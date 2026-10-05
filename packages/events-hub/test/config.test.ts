import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseConfig } from "../src/config.ts";
import { checkSecret, hookToken, pullToken, adminToken } from "../src/derive.ts";

const base = { domain: { url: "https://d" }, receiver: { url: "https://r" } };
const source = { name: "github", mapping: "github", producer: { keyFile: "/k" } };

describe("hub configuration", () => {
	it("applies defaults and resolves the mappings directory", () => {
		const config = parseConfig({ ...base, sources: [source] }, "/etc/hub");
		assert.equal(config.mappingsDir, "/etc/hub/mappings");
		assert.equal(config.domain.requireTls, true);
		assert.equal(config.maxAttempts, 20);
		assert.equal(config.sources[0]!.version, 1);
	});

	it("rejects configurations that could publish something unintended", () => {
		const bad: [unknown, RegExp][] = [
			[{ ...base, sources: [{ name: "Bad Name", mapping: "x", producer: { keyFile: "/k" } }] }, /invalid source name/],
			[{ ...base, sources: [source, source] }, /duplicate source/],
			[{ ...base, sources: [{ name: "x", mapping: "x" }] }, /needs a mapping and a producer key file/],
			[{ ...base, sources: [{ name: "x", forward: { baseUrl: "https://h:1" }, mapping: "x" }] }, /forward-only/],
			[{ ...base, sources: [{ ...source, version: 0 }] }, /version/],
			[{ ...base, sources: [source], clock: { schedules: [{ name: "a", cron: "* * * * *" }] } }, /clock.producer/],
			[{ ...base, sources: [source], clock: { producer: { keyFile: "/k" }, schedules: [{ name: "has-dash", cron: "* * * * *" }] } }, /invalid schedule name/],
			[{ ...base, sources: [source], clock: { producer: { keyFile: "/k" }, schedules: [{ name: "a", cron: "* * * * *", missed: "sometimes" }] } }, /missed/],
			[{ receiver: { url: "https://r" }, sources: [source] }, /domain.url/],
		];
		for (const [config, message] of bad) assert.throws(() => parseConfig(config), message);
	});

	it("accepts a forward-only source without a producer, with a base URL and an optional CA", () => {
		const forward = parseConfig({ ...base, sources: [{ name: "woodpecker", forward: { baseUrl: "https://10.10.10.14:9445/", caFile: "/etc/ca.crt" } }] }).sources[0]!.forward!;
		assert.deepEqual(forward, { baseUrl: "https://10.10.10.14:9445", caFile: "/etc/ca.crt" });
		assert.throws(() => parseConfig({ ...base, sources: [{ name: "w", forward: {} }] }), /forward.baseUrl/);
		assert.throws(() => parseConfig({ ...base, sources: [{ name: "w", forward: { baseUrl: "not a url" } }] }));
	});

	it("passes a static defaults block to the mapping and refuses anything but an object", () => {
		assert.deepEqual(parseConfig({ ...base, sources: [{ ...source, defaults: { repository: { cloneUrl: "u" } } }] }).sources[0]!.defaults, { repository: { cloneUrl: "u" } });
		assert.throws(() => parseConfig({ ...base, sources: [{ ...source, defaults: [1] }] }), /defaults must be an object/);
		assert.throws(() => parseConfig({ ...base, sources: [{ ...source, defaults: { x: "y".repeat(20_000) } }] }), /larger than 16 KiB/);
	});
});

describe("derived credentials", () => {
	const secret = "0123456789abcdef0123456789abcdef-secret";
	it("derives distinct, stable tokens per source, version and purpose", () => {
		assert.equal(hookToken(secret, "jira", 1), hookToken(secret, "jira", 1));
		assert.equal(hookToken(secret, "jira", 1).length, 43);
		const all = new Set([hookToken(secret, "jira", 1), hookToken(secret, "jira", 2), hookToken(secret, "github", 1), pullToken(secret), adminToken(secret)]);
		assert.equal(all.size, 5);
		assert.notEqual(hookToken(secret, "jira", 1), hookToken(secret + "x", "jira", 1));
	});

	it("insists on a long secret", () => {
		assert.throws(() => checkSecret("short"), /at least 32 bytes/);
		assert.equal(checkSecret(`  ${secret}\n`), secret);
	});
});
