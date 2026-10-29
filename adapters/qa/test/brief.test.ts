import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBrief } from "../src/prompt.ts";

const context = (profile: object) => ({ root: "C:/w", profiles: { default: profile as never }, ticketPattern: /^SAD-[0-9]+$/, hasTicketSystem: true, verifiedLabel: "AgentTested" });
const job = { ticket: "SAD-1", repository: { url: "https://example.test/r.git", ref: "refs/heads/x" } };

describe("the brief", () => {
	it("gives the commands that restart the application, so that the agent can merge a pull request and carry on", () => {
		const brief = buildBrief(job, "t1", context({ stop: "stop-app", prepare: "build-backend", start: "start-app", health: ["http://127.0.0.1:8080/health"], startupTimeoutSeconds: 5 }));
		assert.match(brief, /stop: stop-app ; prepare \(rebuilds the back end\): build-backend ; start: start-app/);
	});

	it("leaves the restart commands out when the profile has neither a stop nor a prepare step", () => {
		const brief = buildBrief(job, "t1", context({ start: "start-app", health: ["http://127.0.0.1:8080/health"], startupTimeoutSeconds: 5 }));
		assert.doesNotMatch(brief, /To restart the application/);
	});
});
