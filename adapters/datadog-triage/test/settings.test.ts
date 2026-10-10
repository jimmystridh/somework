import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eligibility } from "../src/eligibility.ts";
import { loadSettings, normalisePriority, roleEnvironment } from "../src/settings.ts";

describe("settings", () => {
	it("has safe defaults", () => {
		const settings = loadSettings({});
		assert.equal(settings.site, "datadoghq.eu");
		assert.equal(settings.minPriority, "P3");
		assert.deepEqual([settings.cooldownMinutes, settings.dailyCap, settings.windowMinutes], [60, 20, 60]);
		assert.deepEqual(settings.budget, { maxTokens: 250_000, maxMinutes: 10 });
		assert.equal(settings.saveFileBytes, 5 * 1024 * 1024);
		assert.equal(settings.saveTaskBytes, 20 * 1024 * 1024);
		assert.equal(settings.notifyTo, "agent/manager");
		assert.equal(settings.apiBase, undefined);
	});

	it("reads the DD_* variables and refuses nonsense at startup", () => {
		const settings = loadSettings({ DD_SITE: "DATADOGHQ.COM", DD_MIN_PRIORITY: "p2", DD_MONITOR_IDS: "1, 22 333", DD_TAG_FILTER: "Team:Platform,env:prod", DD_IGNORE_WARN: "1", DD_DAILY_CAP: "3", EVENTS_NOTIFY_TO: "agent/other" });
		assert.deepEqual([settings.site, settings.minPriority, settings.monitorIds, settings.tagFilter, settings.ignoreWarn, settings.dailyCap, settings.notifyTo], ["datadoghq.com", "P2", ["1", "22", "333"], ["team:platform", "env:prod"], true, 3, "agent/other"]);
		assert.throws(() => loadSettings({ DD_SITE: "evil.example.com" }), /DD_SITE/);
		assert.throws(() => loadSettings({ DD_MIN_PRIORITY: "urgent" }), /DD_MIN_PRIORITY/);
		assert.throws(() => loadSettings({ DD_MONITOR_IDS: "12,abc" }), /not a monitor id/);
		assert.throws(() => loadSettings({ DD_DAILY_CAP: "0" }), /positive integer/);
	});

	it("reads what to ignore: monitor ids, names (separated by semicolons, lower case) and whether a priority is required", () => {
		const settings = loadSettings({ DD_IGNORE_MONITORS: "89853058, 89667590", DD_IGNORE_NAMES: "System load is high;\n Pods Restarting ;", DD_REQUIRE_PRIORITY: "1" });
		assert.deepEqual([settings.ignoreMonitorIds, settings.ignoreNames, settings.requirePriority], [["89853058", "89667590"], ["system load is high", "pods restarting"], true]);
		const defaults = loadSettings({});
		assert.deepEqual([defaults.ignoreMonitorIds, defaults.ignoreNames, defaults.requirePriority], [[], [], false]);
		assert.throws(() => loadSettings({ DD_IGNORE_MONITORS: "12,abc" }), /DD_IGNORE_MONITORS holds a value that is not a monitor id/);
	});

	it("keeps the budget, the window and the saved bytes under their hard caps", () => {
		assert.throws(() => loadSettings({ DD_TRIAGE_BUDGET_TOKENS: "300001" }), /at most 300000/);
		assert.throws(() => loadSettings({ DD_TRIAGE_BUDGET_MINUTES: "21" }), /at most 20/);
		assert.throws(() => loadSettings({ DD_WINDOW_MINUTES: "361" }), /at most 360/);
		assert.throws(() => loadSettings({ DD_SAVE_FILE_BYTES: String(6 * 1024 * 1024) }), /at most/);
		assert.throws(() => loadSettings({ DD_SAVE_TASK_BYTES: String(21 * 1024 * 1024) }), /at most/);
		assert.deepEqual(loadSettings({ DD_TRIAGE_BUDGET_TOKENS: "300000", DD_TRIAGE_BUDGET_MINUTES: "20" }).budget, { maxTokens: 300_000, maxMinutes: 20 });
	});

	it("only lets a test point the client at another host, and only when told to", () => {
		assert.equal(loadSettings({ DD_API_BASE: "http://127.0.0.1:1" }).apiBase, undefined);
		assert.equal(loadSettings({ DD_API_BASE: "http://127.0.0.1:1", DD_ALLOW_BASE_OVERRIDE: "1" }).apiBase, "http://127.0.0.1:1");
	});

	it("fills the kit's environment without overriding the deployment", () => {
		const env = roleEnvironment({});
		assert.deepEqual([env.PI_CONCURRENCY, env.EVENTS_ENABLED, env.BUDGET_MAX_TOKENS_CAP, env.BUDGET_MAX_MINUTES_CAP], ["1", "1", "300000", "20"]);
		assert.equal(roleEnvironment({ BUDGET_MAX_TOKENS_CAP: "100" }).BUDGET_MAX_TOKENS_CAP, "100");
	});

	it("reads priorities in the spellings Datadog uses", () => {
		assert.deepEqual(["P2", "p2", "2", "priority:2", 2].map(normalisePriority), ["P2", "P2", "P2", "P2", "P2"]);
		assert.deepEqual(["", "P9", "high", undefined, null].map((value) => normalisePriority(value as never)), [undefined, undefined, undefined, undefined, undefined]);
	});
});

describe("eligibility", () => {
	const settings = { minPriority: "P3" as const, monitorIds: [] as string[], tagFilter: [] as string[] };
	const monitor = (extra: Record<string, unknown> = {}) => ({ id: "7", tags: ["team:platform"], ...extra }) as { id: string; priority?: string; tags: string[] };

	it("passes P1 to P3 and an unknown priority, refuses P4 and P5", () => {
		for (const priority of ["P1", "P2", "P3", undefined]) assert.equal(eligibility(monitor({ priority }), settings).eligible, true, String(priority));
		for (const priority of ["P4", "P5"]) {
			const verdict = eligibility(monitor({ priority }), settings);
			assert.deepEqual([verdict.eligible, !verdict.eligible && verdict.code], [false, "priority"]);
		}
	});

	it("refuses an ignored monitor by id or by name, and an unprioritised one when a priority is required", () => {
		const named = (name: string, extra: Record<string, unknown> = {}) => monitor({ name, ...extra }) as never;
		assert.deepEqual([eligibility(monitor(), { ...settings, ignoreMonitorIds: ["7"] })].map((verdict) => !verdict.eligible && verdict.code), ["ignored"]);
		assert.match(JSON.stringify(eligibility(named("System load is high for host x"), { ...settings, ignoreNames: ["system load"] })), /holds \\"system load\\"/);
		assert.equal(eligibility(named("Checkout"), { ...settings, ignoreNames: ["system load"] }).eligible, true);
		const strict = { ...settings, requirePriority: true };
		assert.deepEqual([eligibility(monitor(), strict)].map((verdict) => !verdict.eligible && verdict.code), ["priority"]);
		assert.equal(eligibility(monitor({ priority: "P2" }), strict).eligible, true);
	});

	it("applies the monitor list and the tag filter", () => {
		assert.equal(eligibility(monitor(), { ...settings, monitorIds: ["7"] }).eligible, true);
		assert.match(JSON.stringify(eligibility(monitor(), { ...settings, monitorIds: ["8"] })), /not on this agent's list/);
		assert.equal(eligibility(monitor(), { ...settings, tagFilter: ["team:platform"] }).eligible, true);
		assert.equal(eligibility(monitor({ tags: ["Team:Platform"] }), { ...settings, tagFilter: ["team:platform"] }).eligible, true);
		assert.match(JSON.stringify(eligibility(monitor(), { ...settings, tagFilter: ["team:other"] })), /none of the tags/);
	});

	it("never triages a recovered state", () => {
		for (const status of ["recovered", "OK", "Resolved"]) assert.match(JSON.stringify(eligibility(monitor(), settings, status)), /needs no triage/, status);
		assert.equal(eligibility(monitor(), settings, "alert").eligible, true);
	});
});
