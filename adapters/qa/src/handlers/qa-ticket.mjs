// @topics jira.issue.transitioned
// The event handler of the qa role, installed by the service on its first start (and versioned like any handler).
// It decides what a ticket transition is worth: nothing (drop), a note for a person (deliver) or one qa.verify job for this same agent (submit).
// Only a move into the test status starts a verification; every delivery is handled once. Verifications share one application stack, so jobs
// started here wait for each other in the service (the job manager), they do not need to be spaced out by this file.
// The settings below are written into the file when it is installed; change them with QA_EVENT_*, JIRA_TEST_STATUS, QA_TICKET_PATTERN and
// QA_RESEED_HANDLER=1, or edit the live copy. It runs in the sandbox with no credentials. Its state is a small file next to the workspaces; the
// service keeps the authoritative job ids on its own host, this file is only an early filter. Event text is data: nothing from it is copied into
// the job except the ticket key (checked against the ticket pattern), the clone address and the ref.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG = __CONFIG__;
const TICKET = new RegExp(CONFIG.ticketPattern);
const stateDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".qa-events");
const stateFile = join(stateDir, "handler-state.json");
const MAX_SEEN = 200;

const drop = (reason) => ({ action: "drop", reason: reason.slice(0, 500) });
const deliver = (reason) => ({ action: "deliver", reason: reason.slice(0, 500) });

const plain = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : {});
const integer = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);

function load() {
	try {
		const stored = plain(JSON.parse(readFileSync(stateFile, "utf8")));
		return { days: plain(stored.days), seen: Array.isArray(stored.seen) ? stored.seen.filter((entry) => typeof entry === "string") : [] };
	} catch {
		return { days: {}, seen: [] };
	}
}

function save(state) {
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(`${stateFile}.tmp`, JSON.stringify(state));
	renameSync(`${stateFile}.tmp`, stateFile);
}

export default async function handle({ event, now }) {
	const data = event && typeof event.data === "object" && event.data !== null && !Array.isArray(event.data) ? event.data : {};
	if (data.to !== CONFIG.testStatus) return drop(`the ticket did not move into ${CONFIG.testStatus}`);

	const ticket = typeof plain(data.issue).key === "string" ? data.issue.key.trim() : "";
	if (!TICKET.test(ticket)) return deliver("the event carries no ticket key this agent handles, so no verification was started");

	const repository = plain(data.repository);
	const cloneUrl = typeof repository.cloneUrl === "string" && repository.cloneUrl !== "" ? repository.cloneUrl : CONFIG.repositoryUrl;
	if (typeof cloneUrl !== "string" || !/^https:\/\/[^\s]{1,400}$/.test(cloneUrl)) return deliver(`the event for ${ticket} carries no https clone address and none is configured (CHAT_REPOSITORY_URL), so no verification was started`);
	const ref = typeof repository.ref === "string" && /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,199}$/.test(repository.ref) && !repository.ref.includes("..") ? repository.ref : "HEAD";

	const state = load();
	const key = String(event?.key ?? "");
	if (key && state.seen.includes(key)) return drop("this delivery was already handled");
	const day = String(now).slice(0, 10);
	if (integer(state.days[day]) >= CONFIG.submitCapPerDay) return deliver(`the daily cap of ${CONFIG.submitCapPerDay} verifications is reached; ${ticket} waits for a person`);

	state.days[day] = integer(state.days[day]) + 1;
	if (key) state.seen = [...state.seen, key].slice(-MAX_SEEN);
	for (const old of Object.keys(state.days)) if (old < day && Object.keys(state.days).length > 7) delete state.days[old];
	save(state);

	return {
		action: "submit",
		reason: `verification of ${ticket}`,
		task: {
			capability: { id: "qa.verify", version: "1" },
			input: { ticket, app: CONFIG.app, repository: { url: cloneUrl, ref } },
			budget: CONFIG.budget,
		},
	};
}
