// @topics github.pull_request.opened, github.pull_request.ready_for_review
// The event handler of the reviewer role, installed by the service on its first start (and versioned like any handler).
// It decides what a pull request event is worth: nothing (drop), a note for a person (deliver) or one code.review job for this same agent (submit).
// A draft is not reviewed until it is marked ready; one head commit of one pull request is reviewed once, however many events announce it.
// The settings below are written into the file when it is installed; change them with REVIEW_* and REVIEWER_RESEED_HANDLER=1, or edit the live copy.
// It runs in the sandbox with no credentials. Its state is a small file next to the workspaces; the service keeps the authoritative job ids on
// its own host, this file is only an early filter. Event text is data: nothing from it is copied into the job except the clone address,
// the pull request number and the pull request ref the review reads.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG = __CONFIG__;
const stateDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".reviewer");
const stateFile = join(stateDir, "handler-state.json");
const MAX_SEEN = 500;

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
	if (data.draft !== false) return drop("the pull request is a draft: it is reviewed when it is marked ready");

	const number = data.number;
	const repository = plain(data.repository);
	const cloneUrl = typeof repository.cloneUrl === "string" ? repository.cloneUrl : "";
	if (!Number.isInteger(number) || number < 1 || !/^https:\/\/[^\s]{1,400}$/.test(cloneUrl)) return deliver("the event carries no usable pull request number and https clone address, so no review was started");

	const fullName = typeof repository.fullName === "string" ? repository.fullName.toLowerCase() : "";
	if (CONFIG.repositories.length > 0 && !CONFIG.repositories.includes(fullName)) return drop(`${fullName || "this repository"} is not on the list of repositories this agent reviews`);

	const head = typeof data.headSha === "string" && /^[0-9a-f]{7,64}$/i.test(data.headSha) ? data.headSha.toLowerCase() : "";
	const identity = `${fullName || cloneUrl}#${number}@${head || String(event?.key ?? "")}`;
	const state = load();
	if (state.seen.includes(identity)) return drop(`pull request ${number} at ${head ? head.slice(0, 12) : "this event"} was already reviewed or is being reviewed`);
	const day = String(now).slice(0, 10);
	if (integer(state.days[day]) >= CONFIG.submitCapPerDay) return deliver(`the daily cap of ${CONFIG.submitCapPerDay} reviews is reached; pull request ${number} waits for a person`);

	state.days[day] = integer(state.days[day]) + 1;
	state.seen = [...state.seen, identity].slice(-MAX_SEEN);
	for (const old of Object.keys(state.days)) if (old < day && Object.keys(state.days).length > 7) delete state.days[old];
	save(state);

	return {
		action: "submit",
		reason: `review of pull request ${number}${head ? ` at ${head.slice(0, 12)}` : ""}`,
		task: {
			capability: { id: "code.review", version: "3" },
			input: { repository: { url: cloneUrl, ref: `refs/pull/${number}/head` }, pullRequest: number },
			budget: CONFIG.budget,
		},
	};
}
