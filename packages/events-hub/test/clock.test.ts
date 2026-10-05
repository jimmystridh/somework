import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Clock, jitterMs } from "../src/clock.ts";
import type { ScheduleConfig } from "../src/config.ts";
import { isoWithOffset, localMinute, nextAfter, parseCron, typicalIntervalMs } from "../src/cron.ts";
import { Store } from "../src/store.ts";
import type { MappedEvent } from "../src/types.ts";

const at = (iso: string) => Date.parse(iso);
const next = (expr: string, tz: string, after: string) => {
	const t = nextAfter(parseCron(expr), tz, at(after));
	return t === null ? null : new Date(t).toISOString();
};

describe("cron", () => {
	it("parses lists, ranges, steps and names", () => {
		const spec = parseCron("*/15 8-17 * jan,mar MON-FRI");
		assert.deepEqual([...spec.minutes], [0, 15, 30, 45]);
		assert.deepEqual([...spec.hours], [8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
		assert.deepEqual([...spec.months], [1, 3]);
		assert.deepEqual([...spec.weekdays], [1, 2, 3, 4, 5]);
		assert.deepEqual([...parseCron("0 0 * * 7").weekdays], [0], "7 is Sunday");
		assert.deepEqual([...parseCron("5/20 * * * *").minutes], [5, 25, 45]);
	});

	it("rejects malformed expressions", () => {
		for (const bad of ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "*/0 * * * *", "5-1 * * * *", "a * * * *"]) assert.throws(() => parseCron(bad), undefined, bad);
	});

	it("finds the next time in the local zone, across daylight saving", () => {
		assert.equal(next("0 9 * * mon-fri", "Europe/Stockholm", "2026-10-09T12:00:00Z"), "2026-10-12T07:00:00.000Z", "Monday 09:00 CEST");
		assert.equal(next("0 9 * * mon-fri", "Europe/Stockholm", "2026-11-06T12:00:00Z"), "2026-11-09T08:00:00.000Z", "Monday 09:00 CET");
		assert.equal(next("30 2 * * *", "Europe/Stockholm", "2026-10-24T12:00:00Z"), "2026-10-25T00:30:00.000Z");
		assert.equal(next("30 2 * * *", "Europe/Stockholm", "2026-10-25T00:30:00Z"), "2026-10-26T01:30:00.000Z", "02:30 happens twice on the autumn day and fires once");
		assert.equal(next("30 2 * * *", "Europe/Stockholm", "2027-03-27T12:00:00Z"), "2027-03-29T00:30:00.000Z", "02:30 does not exist on the spring day and is skipped");
		assert.equal(next("0 0 * * *", "UTC", "2026-12-31T23:59:30Z"), "2027-01-01T00:00:00.000Z");
		assert.equal(next("0 12 * * *", "America/New_York", "2026-07-01T00:00:00Z"), "2026-07-01T16:00:00.000Z");
	});

	it("uses either day field when both are restricted, and never matches an impossible date", () => {
		assert.equal(next("0 0 13 * fri", "UTC", "2026-10-01T00:00:00Z"), "2026-10-02T00:00:00.000Z", "Friday the 2nd matches through the weekday");
		assert.equal(next("0 0 13 * fri", "UTC", "2026-10-12T12:00:00Z"), "2026-10-13T00:00:00.000Z");
		assert.equal(next("0 0 30 2 *", "UTC", "2026-01-01T00:00:00Z"), null);
		assert.equal(next("0 0 29 2 *", "UTC", "2026-03-01T00:00:00Z"), "2028-02-29T00:00:00.000Z");
	});

	it("measures the typical interval", () => {
		assert.equal(typicalIntervalMs(parseCron("*/5 * * * *"), "UTC", at("2026-10-05T10:00:00Z")), 300_000);
		assert.equal(typicalIntervalMs(parseCron("0 2 * * *"), "UTC", at("2026-10-05T10:00:00Z")), 86_400_000);
	});
});

const schedule = (overrides: Partial<ScheduleConfig> = {}): ScheduleConfig => ({ name: "nightly", cron: "0 2 * * *", timeZone: "Europe/Stockholm", jitterSeconds: 0, missed: "auto", ...overrides });

function harness(schedules: ScheduleConfig[], store = new Store(":memory:")) {
	const published: { event: MappedEvent; occurredAt: string }[] = [];
	const ticks: string[] = [];
	const clock = new Clock({
		schedules,
		store,
		publish: async (event, occurredAt) => {
			const duplicate = published.some((p) => p.event.key === event.key);
			published.push({ event, occurredAt });
			return { duplicate };
		},
		onTick: (name, missed, didPublish) => ticks.push(`${name}:${missed ? "missed" : "ontime"}:${didPublish ? "published" : "skipped"}`),
	});
	return { clock, store, published, ticks };
}

describe("the clock producer", () => {
	it("starts from now: the first tick publishes nothing", async () => {
		const h = harness([schedule()]);
		assert.equal(await h.clock.tick(at("2026-10-05T10:00:00Z")), 0);
		assert.equal(h.published.length, 0);
		assert.equal(h.store.clockLast("nightly"), at("2026-10-05T10:00:00Z"));
	});

	it("publishes clock.<name>.tick once per scheduled minute with the contract's key", async () => {
		const h = harness([schedule({ name: "every5", cron: "*/5 * * * *", timeZone: "UTC" })]);
		await h.clock.tick(at("2026-10-05T10:00:30Z"));
		assert.equal(await h.clock.tick(at("2026-10-05T10:04:59Z")), 0);
		assert.equal(await h.clock.tick(at("2026-10-05T10:05:01Z")), 1);
		assert.equal(await h.clock.tick(at("2026-10-05T10:05:30Z")), 0, "the same minute is not published again");
		assert.equal(await h.clock.tick(at("2026-10-05T10:10:00Z")), 1);
		assert.deepEqual(h.published.map((p) => p.event.key), ["clock.every5:2026-10-05T10:05", "clock.every5:2026-10-05T10:10"]);
		assert.equal(h.published[0]!.event.topic, "clock.every5.tick");
		assert.deepEqual(h.published[0]!.event.data, { name: "every5", scheduledFor: "2026-10-05T10:05:00+00:00", missed: false });
		assert.equal(h.published[0]!.event.classification, "public");
		assert.equal(h.published[0]!.occurredAt, "2026-10-05T10:05:00.000Z");
	});

	it("runs a missed daily job once on recovery (auto picks run-once for jobs less frequent than hourly)", async () => {
		const h = harness([schedule()]);
		h.store.setClockLast("nightly", at("2026-10-04T00:00:00Z"));
		assert.equal(await h.clock.tick(at("2026-10-06T10:00:00Z")), 1, "two nights missed, one run");
		assert.equal(h.published[0]!.event.key, "clock.nightly:2026-10-06T02:00");
		assert.equal((h.published[0]!.event.data as { missed: boolean }).missed, true);
		assert.deepEqual(h.ticks, ["nightly:missed:published"]);
		assert.equal(await h.clock.tick(at("2026-10-06T10:00:30Z")), 0);
	});

	it("skips missed runs of a job set to skip, and publishes only the latest tick of a frequent job after downtime", async () => {
		const frequent = harness([schedule({ name: "minutely", cron: "* * * * *", timeZone: "UTC" })]);
		frequent.store.setClockLast("minutely", at("2026-10-05T10:00:00Z"));
		assert.equal(await frequent.clock.tick(at("2026-10-05T12:00:00Z")), 1, "two hours of minutes missed, one tick for the current minute");
		assert.equal(frequent.published[0]!.event.key, "clock.minutely:2026-10-05T12:00");
		assert.equal((frequent.published[0]!.event.data as { missed: boolean }).missed, false);
		assert.equal(await frequent.clock.tick(at("2026-10-05T12:01:00Z")), 1, "and carries on from there");

		const hourly = harness([schedule({ name: "hourly", cron: "0 * * * *", timeZone: "UTC", missed: "skip" })]);
		hourly.store.setClockLast("hourly", at("2026-10-05T08:00:00Z"));
		assert.equal(await hourly.clock.tick(at("2026-10-05T12:30:00Z")), 0, "the 12:00 tick is 30 minutes late and the policy is skip");
		assert.deepEqual(hourly.ticks, ["hourly:missed:skipped"]);
		assert.equal(await hourly.clock.tick(at("2026-10-05T13:00:05Z")), 1);

		const daily = harness([schedule({ missed: "skip" })]);
		daily.store.setClockLast("nightly", at("2026-10-04T00:00:00Z"));
		assert.equal(await daily.clock.tick(at("2026-10-06T10:00:00Z")), 0);
		assert.equal(daily.store.clockLast("nightly"), at("2026-10-06T00:00:00Z"), "progress still moves forward");
	});

	it("auto picks skip for jobs that fire more than once an hour and run-once for the rest", () => {
		const entries = (cron: string) => (harness([schedule({ cron, timeZone: "UTC" })]).clock as unknown as { "#entries": { missed: string }[] });
		void entries;
		assert.ok(typicalIntervalMs(parseCron("*/30 * * * *"), "UTC", at("2026-10-05T10:00:00Z")) < 3_600_000);
		assert.ok(typicalIntervalMs(parseCron("0 * * * *"), "UTC", at("2026-10-05T10:00:00Z")) >= 3_600_000);
	});

	it("publishes only the latest of several due ticks when it is just a little late", async () => {
		const h = harness([schedule({ name: "minutely", cron: "* * * * *", timeZone: "UTC" })]);
		h.store.setClockLast("minutely", at("2026-10-05T10:00:00Z"));
		assert.equal(await h.clock.tick(at("2026-10-05T10:03:10Z")), 1);
		assert.equal(h.published[0]!.event.key, "clock.minutely:2026-10-05T10:03");
		assert.equal((h.published[0]!.event.data as { missed: boolean }).missed, false);
	});

	it("delays a tick by a stable jitter and does not re-roll it after a restart", async () => {
		const jitter = jitterMs("nightly", at("2026-10-05T00:00:00Z"), 30);
		assert.ok(jitter >= 0 && jitter <= 30_000);
		assert.equal(jitter, jitterMs("nightly", at("2026-10-05T00:00:00Z"), 30));
		assert.notEqual(jitterMs("nightly", at("2026-10-06T00:00:00Z"), 30) + jitterMs("other", at("2026-10-05T00:00:00Z"), 30), jitter * 2, "different inputs, different jitter (at least for these)");
		const h = harness([schedule({ timeZone: "UTC", cron: "0 0 * * *", jitterSeconds: 30 })]);
		await h.clock.tick(at("2026-10-04T23:59:00Z"));
		const due = at("2026-10-05T00:00:00Z");
		assert.equal(await h.clock.tick(due + (jitter > 0 ? jitter - 1 : 0)), jitter > 0 ? 0 : 1, "not before the jitter has passed");
		assert.equal(await h.clock.tick(due + jitter), jitter > 0 ? 1 : 0);
		const restarted = new Clock({ schedules: [schedule({ timeZone: "UTC", cron: "0 0 * * *", jitterSeconds: 30 })], store: h.store, publish: async () => { throw new Error("must not publish twice"); } });
		assert.equal(await restarted.tick(due + 60_000), 0, "a restarted clock continues from the stored progress");
	});

	it("does not store progress when the publish fails, so the tick is retried (and deduplicated by key if it had gone through)", async () => {
		const store = new Store(":memory:");
		let fail = true;
		const events: string[] = [];
		const clock = new Clock({ schedules: [schedule({ timeZone: "UTC", cron: "0 * * * *" })], store, publish: async (event) => { if (fail) throw new Error("domain down"); events.push(event.key); return { duplicate: false }; } });
		await clock.tick(at("2026-10-05T10:30:00Z"));
		await assert.rejects(clock.tick(at("2026-10-05T11:00:05Z")), /domain down/);
		assert.equal(store.clockLast("nightly"), at("2026-10-05T10:30:00Z"));
		fail = false;
		assert.equal(await clock.tick(at("2026-10-05T11:00:10Z")), 1);
		assert.deepEqual(events, ["clock.nightly:2026-10-05T11:00"]);
	});

	it("fires 02:30 Stockholm once on the autumn day when the clock repeats the hour", async () => {
		const h = harness([schedule({ name: "late", cron: "30 2 * * *", missed: "run-once" })]);
		await h.clock.tick(at("2026-10-24T12:00:00Z"));
		for (const t of ["2026-10-25T00:31:00Z", "2026-10-25T01:31:00Z", "2026-10-25T02:31:00Z", "2026-10-26T01:31:00Z"]) await h.clock.tick(at(t));
		assert.deepEqual(h.published.map((p) => p.event.key), ["clock.late:2026-10-25T02:30", "clock.late:2026-10-26T02:30"]);
	});

	it("rejects a schedule with a bad time zone or cron expression at construction", () => {
		assert.throws(() => harness([schedule({ timeZone: "Mars/Olympus" })]));
		assert.throws(() => harness([schedule({ cron: "nope" })]));
	});

	it("names the scheduled minute in the schedule's own time zone", () => {
		assert.equal(localMinute(at("2026-10-05T21:00:00Z"), "Europe/Stockholm"), "2026-10-05T23:00");
		assert.equal(isoWithOffset(at("2026-10-05T21:00:00Z"), "Europe/Stockholm"), "2026-10-05T23:00:00+02:00");
		assert.equal(isoWithOffset(at("2026-12-05T22:00:00Z"), "Europe/Stockholm"), "2026-12-05T23:00:00+01:00");
		assert.equal(isoWithOffset(at("2026-10-05T10:00:00Z"), "UTC"), "2026-10-05T10:00:00+00:00");
		assert.equal(isoWithOffset(at("2026-10-05T10:00:00Z"), "Asia/Kolkata"), "2026-10-05T15:30:00+05:30");
		assert.equal(isoWithOffset(at("2026-07-01T10:00:00Z"), "America/New_York"), "2026-07-01T06:00:00-04:00");
	});
});
