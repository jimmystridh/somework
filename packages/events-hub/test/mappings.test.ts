import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { MappingEngine, normalize, type MappingInput } from "../src/mapping.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "mappings");
const engine = new MappingEngine(root);
const sources = engine.names();

interface Fixture {
	description: string;
	input: MappingInput;
	expected: unknown[];
	expectedRejected?: string[];
	canaries?: string[];
}

const fixturesOf = (source: string): { name: string; fixture: Fixture }[] =>
	readdirSync(join(root, source, "fixtures"))
		.filter((name) => name.endsWith(".json"))
		.map((name) => ({ name, fixture: JSON.parse(readFileSync(join(root, source, "fixtures", name), "utf8")) as Fixture }));

const strings = (value: unknown, out: string[] = []): string[] => {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
	else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
	return out;
};

describe("the mappings", () => {
	it("covers the four sources", () => {
		assert.deepEqual(sources, ["datadog", "github", "grafana", "jira"]);
	});

	for (const source of sources) {
		describe(source, () => {
			const fixtures = fixturesOf(source);

			it("has recorded-style fixtures including dropped ones", () => {
				assert.ok(fixtures.length >= 8, `${source} has ${fixtures.length} fixtures`);
				assert.ok(fixtures.some(({ fixture }) => fixture.expected.length === 0), "at least one fixture must be dropped");
				assert.ok(fixtures.some(({ fixture }) => fixture.expected.length > 0));
			});

			for (const { name, fixture } of fixtures) {
				it(`${name.replace(/\.json$/, "")}: ${fixture.description}`, async () => {
					assert.notEqual(fixture.expected as unknown, "FREEZE", "fixture was never frozen");
					const result = await engine.run(source, source, fixture.input, "internal");
					assert.deepEqual(result.events, fixture.expected);
					assert.deepEqual(result.rejected, fixture.expectedRejected ?? []);

					const published = JSON.stringify(result.events);
					for (const canary of fixture.canaries ?? []) assert.ok(!published.includes(canary), `output carries ${canary}`);
				});
			}

			it("only carries what the safety rules allow, in every fixture", async () => {
				for (const { name, fixture } of fixtures) {
					const { events } = await engine.run(source, source, fixture.input, "internal");
					const keys = new Set<string>();
					for (const event of events) {
						assert.ok(event.topic.startsWith(`${source}.`), `${name}: topic ${event.topic} outside the source prefix`);
						assert.ok(!keys.has(event.key), `${name}: duplicate key ${event.key} within one webhook`);
						keys.add(event.key);
						assert.ok(Buffer.byteLength(JSON.stringify(event.data)) <= 64 * 1024, `${name}: data over 64 KiB`);
					}
					for (const text of strings(events)) {
						assert.ok(text.length <= 600, `${name}: a ${text.length} character string was carried (long text must be an excerpt)`);
						assert.ok(!/[\w.+-]+@[\w-]+\.[\w.-]+/.test(text), `${name}: looks like an e-mail address: ${text.slice(0, 40)}`);
						assert.ok(!/\b(ghp_|github_pat_|sk-[A-Za-z0-9]{16})/.test(text), `${name}: a credential survived`);
					}
					assert.deepEqual(JSON.parse(JSON.stringify(events)), events, `${name}: output must be plain JSON`);
				}
			});

			it("is deterministic: the same webhook gives the same keys", async () => {
				for (const { fixture } of fixtures) {
					const a = await engine.run(source, source, fixture.input, "internal");
					const b = await engine.run(source, source, structuredClone(fixture.input), "internal");
					assert.deepEqual(a.events.map((e) => e.key), b.events.map((e) => e.key));
				}
			});

			it("drops unknown shapes instead of failing", async () => {
				const bodies: unknown[] = [null, 0, 1, true, "", "text", [], [1, 2, 3], {}, { a: { b: { c: [] } } }, "x".repeat(200_000), { alerts: "nope" }, { alerts: [null, 1, "x"] }, { issue: "x", webhookEvent: 5 }, { pull_request: [], action: {} }];
				const headerSets = [{}, { "x-github-event": "pull_request", "x-github-delivery": "d" }, { "x-github-event": ["push"] as unknown as string }];
				for (const body of bodies) {
					for (const headers of headerSets) {
						const result = await engine.run(source, source, { headers, body, receivedAt: "2026-10-05T10:00:00Z", source }, "internal");
						assert.deepEqual(result.events, [], `junk produced an event: ${JSON.stringify(body).slice(0, 60)}`);
					}
				}
			});
		});
	}
});

describe("the normalisation of a mapping's output", () => {
	const ok = { topic: "github.pull_request.opened", key: "k1", data: { a: 1 } };

	it("accepts a well-formed event and fills in the classification", () => {
		assert.deepEqual(normalize(ok, "github", "internal").events, [{ ...ok, classification: "internal" }]);
		assert.deepEqual(normalize([ok, { ...ok, key: "k2", classification: "public" }], "github", "internal").events.map((e) => e.classification), ["internal", "public"]);
	});

	it("drops every field the contract does not name", () => {
		const [event] = normalize({ ...ok, secret: "x", headers: { a: "b" }, extra: 1 }, "github", "internal").events;
		assert.deepEqual(Object.keys(event!).sort(), ["classification", "data", "key", "topic"]);
	});

	it("rejects events with a reason, one by one", () => {
		const cases: [unknown, string][] = [
			[{ ...ok, topic: "Bad Topic" }, "invalid_topic"],
			[{ ...ok, topic: "github.only" }, "invalid_topic"],
			[{ ...ok, topic: "jira.issue.created" }, "topic_outside_source_prefix"],
			[{ ...ok, key: "" }, "invalid_key"],
			[{ ...ok, key: "k".repeat(201) }, "invalid_key"],
			[{ ...ok, key: "a\nb" }, "invalid_key"],
			[{ ...ok, data: "text" }, "invalid_data"],
			[{ ...ok, data: null }, "invalid_data"],
			[{ ...ok, data: { big: "x".repeat(70_000) } }, "data_too_large"],
			[{ ...ok, classification: 5 }, "invalid_classification"],
			[{ ...ok, causedByTask: "bad id with spaces" }, "invalid_caused_by_task"],
			["text", "not_an_object"],
		];
		for (const [candidate, reason] of cases) assert.deepEqual(normalize(candidate, "github", "internal"), { events: [], rejected: [reason] }, reason);
	});

	it("keeps the valid events of a mixed result", () => {
		const result = normalize([ok, { ...ok, key: "" }], "github", "internal");
		assert.equal(result.events.length, 1);
		assert.deepEqual(result.rejected, ["invalid_key"]);
	});

	it("scrubs credentials in data", () => {
		const [event] = normalize({ ...ok, data: { note: "use ghp_" + "A".repeat(30) + " now", nested: ["Bearer abcdefghijklmnop"] } }, "github", "internal").events;
		assert.ok(!JSON.stringify(event).includes("ghp_"));
		assert.ok(!JSON.stringify(event).includes("abcdefghijklmnop"));
	});
});
