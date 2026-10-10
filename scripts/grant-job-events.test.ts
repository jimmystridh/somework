import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { grantJobEvents, jobEventGrant, withGrant } from "./grant-job-events.ts";

describe("the job event grant", () => {
	it("names the agent's own topic prefix with the slug of the reporter", () => {
		assert.equal(jobEventGrant("agent/qa"), "events.publish:agent.qa.*");
		assert.equal(jobEventGrant("agent/Datadog-Triage"), "events.publish:agent.datadog_triage.*");
		assert.equal(jobEventGrant("agent/aikido.fixer"), "events.publish:agent.aikido_fixer.*");
	});

	it("adds the grant to the actions and keeps every other field", () => {
		const merged = withGrant({ roles: ["agent"], actions: ["message.send"], classificationLimit: "internal" }, "events.publish:agent.qa.*");
		assert.deepEqual(merged, { roles: ["agent"], actions: ["message.send", "events.publish:agent.qa.*"], classificationLimit: "internal" });
		assert.deepEqual(withGrant(undefined, "g"), { actions: ["g"] });
	});

	it("leaves permissions that already hold it alone", () => {
		assert.equal(withGrant({ actions: ["events.publish:agent.qa.*"] }, "events.publish:agent.qa.*"), undefined);
	});
});

describe("granting to the agents of a domain", () => {
	const principals = [
		{ kind: "agent", id: "agent/qa", status: "active", permissions: { roles: [], actions: ["message.send"] } },
		{ kind: "agent", id: "agent/pi", status: "active", permissions: { roles: [], actions: ["events.publish:agent.pi.*"] } },
		{ kind: "agent", id: "agent/old", status: "suspended", permissions: { actions: [] } },
		{ kind: "human", id: "alice", status: "active", permissions: { actions: [] } },
	];
	const rig = () => {
		const calls: { method: string; path: string; body: unknown }[] = [];
		const lines: string[] = [];
		const client = {
			get: async () => ({ principals }),
			raw: async (method: string, path: string, options: { body?: unknown }) => void calls.push({ method, path, body: options.body }),
		} as never;
		return { client, calls, lines, log: (line: string) => void lines.push(line) };
	};

	it("changes nothing without --apply and says what it would do", async () => {
		const { client, calls, lines, log } = rig();
		const result = await grantJobEvents(client, { apply: false, log });
		assert.deepEqual(result, { granted: ["agent/qa"], already: ["agent/pi"] });
		assert.deepEqual(calls, []);
		assert.deepEqual(lines, ["agent/qa: would grant events.publish:agent.qa.*", "agent/pi: already has events.publish:agent.pi.*"]);
	});

	it("writes the merged permissions of active agents only, with the id in the path encoded", async () => {
		const { client, calls, log } = rig();
		await grantJobEvents(client, { apply: true, log });
		assert.deepEqual(calls, [{ method: "PATCH", path: "/v1/admin/principals/agent/agent%2Fqa", body: { permissions: { roles: [], actions: ["message.send", "events.publish:agent.qa.*"] } } }]);
	});

	it("can be limited to some agents", async () => {
		const { client, calls, log } = rig();
		const result = await grantJobEvents(client, { apply: true, only: ["agent/pi"], log });
		assert.deepEqual(result, { granted: [], already: ["agent/pi"] });
		assert.deepEqual(calls, []);
	});
});
