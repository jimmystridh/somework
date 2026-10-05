import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Clock } from "../src/clock.ts";
import { MappingEngine, type MappingInput } from "../src/mapping.ts";
import { Store } from "../src/store.ts";
import type { MappedEvent } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const samples = join(here, "..", "..", "..", "rules", "samples");
const mappings = join(here, "..", "mappings");
const engine = new MappingEngine(mappings);

/** Key paths and leaf types of a value: `a.b: string`, `tags[]: string`. */
function shape(value: unknown, path = "", out: Record<string, string> = {}): Record<string, string> {
	if (Array.isArray(value)) {
		out[path || "$"] = "array";
		for (const item of value) shape(item, `${path}[]`, out);
	} else if (value !== null && typeof value === "object") {
		if (path) out[path] = "object";
		for (const [key, child] of Object.entries(value)) shape(child, path ? `${path}.${key}` : key, out);
	} else out[path] = value === null ? "null" : typeof value;
	return out;
}

async function recordedEvents(): Promise<Map<string, MappedEvent[]>> {
	const byTopic = new Map<string, MappedEvent[]>();
	for (const source of engine.names()) {
		for (const name of readdirSync(join(mappings, source, "fixtures")).filter((n) => n.endsWith(".json"))) {
			const fixture = JSON.parse(readFileSync(join(mappings, source, "fixtures", name), "utf8")) as { input: MappingInput };
			for (const event of (await engine.run(source, source, fixture.input, "internal")).events) byTopic.set(event.topic, [...(byTopic.get(event.topic) ?? []), event]);
		}
	}
	return byTopic;
}

describe("the mappings produce the event shapes the shipped rules rely on (rules/samples, docs/RULES.md)", { skip: !existsSync(samples) && "rules/samples is not in this checkout" }, async () => {
	const recorded = await recordedEvents();
	const files = existsSync(samples) ? readdirSync(samples).filter((n) => n.endsWith(".json")) : [];

	it("has a sample for every topic the shipped rules select", () => {
		assert.ok(files.length >= 6, `found ${files.length} samples`);
	});

	for (const file of files.filter((f) => !f.startsWith("clock."))) {
		it(`${file}: same fields, same types`, () => {
			const sample = JSON.parse(readFileSync(join(samples, file), "utf8")) as { topic: string; data: unknown; classification: string };
			const events = recorded.get(sample.topic);
			assert.ok(events?.length, `no fixture produces ${sample.topic}`);
			const wanted = shape(sample.data);
			const nullable = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).filter(([, type]) => type !== "null" && type !== "undefined"));
			const exact = events!.filter((event) => JSON.stringify(Object.entries(nullable(shape(event.data))).sort()) === JSON.stringify(Object.entries(nullable(wanted)).sort()));
			assert.ok(exact.length > 0, `${sample.topic}: no fixture produces exactly the sample's fields and types`);
			for (const event of events!) {
				const extra = Object.keys(shape(event.data)).filter((path) => !(path in wanted));
				assert.deepEqual(extra, [], `${sample.topic} (key ${event.key}) carries fields the sample does not list`);
			}
			assert.equal(events![0]!.classification, sample.classification);
		});
	}

	it("clock.nightly_digest.tick: name and scheduledFor like the sample, classification public", async () => {
		const sample = JSON.parse(readFileSync(join(samples, "clock.nightly_digest.tick.json"), "utf8")) as { data: Record<string, unknown>; classification: string; key: string };
		const published: MappedEvent[] = [];
		const store = new Store(":memory:");
		const clock = new Clock({ schedules: [{ name: "nightly_digest", cron: "0 23 * * *", timeZone: "Europe/Stockholm", jitterSeconds: 0, missed: "run-once" }], store, publish: async (event) => (published.push(event), { duplicate: false }) });
		await clock.tick(Date.parse("2026-10-05T12:00:00Z"));
		await clock.tick(Date.parse("2026-10-05T21:00:30Z"));
		assert.equal(published.length, 1);
		const [event] = published;
		assert.equal(event!.topic, "clock.nightly_digest.tick");
		assert.equal(event!.key, sample.key, "the key names the local scheduled minute like the sample");
		assert.equal(event!.classification, sample.classification);
		assert.equal((event!.data as { scheduledFor: string }).scheduledFor, sample.data.scheduledFor);
		assert.equal((event!.data as { name: string }).name, sample.data.name);
		for (const field of Object.keys(sample.data)) assert.ok(field in (event!.data as object), field);
	});

	it("carries nothing the sample for a pull request does not list", () => {
		const events = recorded.get("github.pull_request.opened")!;
		assert.deepEqual(Object.keys(events[0]!.data as object).sort(), ["action", "author", "baseRef", "draft", "headRef", "headSha", "htmlUrl", "number", "repository", "title"]);
	});
});
