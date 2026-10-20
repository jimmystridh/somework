import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createQaHooks } from "../src/hooks.ts";
import { loadQaLabels, loadQaSettings } from "../src/settings.ts";
import { QaSession } from "../src/session.ts";

const make = (options: { labels?: string[] | Error; skipLabel?: string | null; cleared?: string[]; clearError?: Error; logs?: string[]; block?: string | Error | undefined } = {}) =>
	createQaHooks({
		root: "/w",
		ticketPattern: /^SAD-[0-9]+$/,
		profiles: { default: { start: "x", health: ["http://127.0.0.1:1/"], stop: "y", startupTimeoutSeconds: 5 } as never },
		session: new QaSession(),
		appEnv: (() => { throw new Error("not used"); }) as never,
		browser: (async () => { throw new Error("not used"); }) as never,
		allowHosts: [],
		cliPath: "/cli",
		hasTicketSystem: true,
		verifiedLabel: "AgentTested",
		client: {} as never,
		log: (_level, event) => void options.logs?.push(event),
		...(options.skipLabel === null ? {} : { skipLabel: options.skipLabel ?? "no-qa" }),
		ticketLabels: async () => {
			if (options.labels instanceof Error) throw options.labels;
			return options.labels ?? [];
		},
		...(options.block === undefined ? {} : { ticketBlock: async () => { if (options.block instanceof Error) throw options.block; return options.block as string; } }),
		clearRequest: async (ticket) => {
			if (options.clearError) throw options.clearError;
			options.cleared?.push(ticket);
		},
	});

const job = { ticket: "SAD-1", repository: { url: "https://example.test/r.git", ref: "refs/heads/x" } };
const context = { taskId: "t", log: () => {} };

describe("a ticket that carries the skip label", () => {
	it("is skipped before the model runs, whoever asked, with a reason that says how to change it", async () => {
		const hooks = make({ labels: ["vat", "No-QA"] });
		const prepared = await hooks.prepareInput!(job, context);
		assert.equal(hooks.instruction!(prepared, { taskId: "t" }), "skipped");
		const blocked = (await hooks.beforeRun!({ input: prepared, taskId: "t", workspace: "/w" } as never)) as any;
		assert.match(blocked.blocked.reason, /carries the label no-qa.*take the label off/);
		assert.equal(blocked.blocked.details.skipped, true);
		const result = (await hooks.result!({} as never, { input: prepared, taskId: "t", blocked: blocked.blocked } as never)) as any;
		assert.equal(result.result.verdict, "skipped");
		assert.match(result.result.jira.skippedReason, /no-qa/);
	});

	it("is verified as usual without the label", async () => {
		const hooks = make({ labels: ["vat"] });
		const prepared = await hooks.prepareInput!(job, context);
		assert.notEqual(hooks.instruction!(prepared, { taskId: "t" }), "skipped");
	});

	it("is verified when the labels cannot be read: the verification itself then reports the outage, and the warning says why", async () => {
		const logs: string[] = [];
		const hooks = make({ labels: new Error("jira down"), logs });
		const prepared = await hooks.prepareInput!(job, context);
		assert.notEqual(hooks.instruction!(prepared, { taskId: "t" }), "skipped");
		assert.ok(logs.includes("ticket_labels_failed"));
	});

	it("is not looked up at all when no skip label is configured", async () => {
		const hooks = make({ labels: new Error("must not be called"), skipLabel: null });
		assert.notEqual(hooks.instruction!(await hooks.prepareInput!(job, context), { taskId: "t" }), "skipped");
	});
});

describe("the request label", () => {
	const finished = (hooks: ReturnType<typeof make>, input: unknown) => hooks.result!({} as never, { input, taskId: "t", blocked: { reason: "x", details: { skipped: true } } } as never);

	it("is taken off the ticket when its verification is over, even a skipped one", async () => {
		const cleared: string[] = [];
		const hooks = make({ cleared, labels: ["no-qa", "qa-verify"] });
		const prepared = await hooks.prepareInput!(job, context);
		await finished(hooks, prepared);
		assert.deepEqual(cleared, ["SAD-1"]);
	});

	it("does not stop the result when the label cannot be taken off, and says so", async () => {
		const logs: string[] = [];
		const hooks = make({ clearError: new Error("jira refused"), logs });
		const result = (await finished(hooks, job)) as any;
		assert.equal(result.result.verdict, "skipped");
		assert.ok(logs.includes("request_label_not_cleared"));
	});

	it("is left alone for a key this agent does not handle", async () => {
		const cleared: string[] = [];
		await finished(make({ cleared }), { ...job, ticket: "OTHER-1" });
		assert.deepEqual(cleared, []);
	});
});

describe("the label settings", () => {
	it("default to no-qa and qa-verify, follow the deployment and refuse what cannot work", () => {
		assert.deepEqual(loadQaLabels({}), { skipLabel: "no-qa", requestLabel: "qa-verify" });
		assert.deepEqual(loadQaLabels({ JIRA_QA_SKIP_LABEL: "manual", JIRA_QA_REQUEST_LABEL: "run-qa" }), { skipLabel: "manual", requestLabel: "run-qa" });
		assert.throws(() => loadQaLabels({ JIRA_QA_SKIP_LABEL: "a b" }), /Jira label/);
		assert.throws(() => loadQaLabels({ JIRA_QA_SKIP_LABEL: "x", JIRA_QA_REQUEST_LABEL: "X" }), /must differ/);
		assert.throws(() => loadQaLabels({ JIRA_QA_REQUEST_LABEL: "AgentTested" }), /JIRA_VERIFIED_LABEL/);
	});

	it("reach the Jira settings of the service", () => {
		const settings = loadQaSettings({ WINDOWS_WORKSPACE_ROOT: "C:\\w", JIRA_URL: "https://jira.example.test", JIRA_TOKEN_FILE: "C:\\t" }, () => true);
		assert.equal(settings.jira?.skipLabel, "no-qa");
		assert.equal(settings.jira?.requestLabel, "qa-verify");
	});
});

describe("a ticket that cannot be verified now (not in Test, or assigned)", () => {
	it("is skipped before anything is cloned or started, with the reason", async () => {
		const hooks = make({ block: "SAD-1 is assigned to Martin Ohlin, and QA verifies only unassigned tickets" });
		const prepared = await hooks.prepareInput!(job, context);
		assert.equal(hooks.instruction!(prepared, { taskId: "t" }), "skipped");
		const blocked = (await hooks.beforeRun!({ input: prepared, taskId: "t", workspace: "/w" } as never)) as any;
		assert.match(blocked.blocked.reason, /assigned to Martin Ohlin/);
		assert.equal(blocked.blocked.details.skipped, true);
	});

	it("is verified as usual when the ticket system sees nothing in the way, or cannot be asked", async () => {
		const free = make({ block: undefined });
		assert.notEqual(free.instruction!(await free.prepareInput!(job, context), { taskId: "t" }), "skipped");
		const logs: string[] = [];
		const down = make({ block: new Error("jira down"), logs });
		assert.notEqual(down.instruction!(await down.prepareInput!(job, context), { taskId: "t" }), "skipped");
		assert.ok(logs.includes("ticket_status_failed"));
	});
});
