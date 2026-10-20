// @topics github.watch.aikido_fixer.event
// The watch handler of the aikido-fixer role, installed next to the Aikido and follow-up handlers. After the agent opened a pull request it asked the event hub to
// watch it ("tell me about this pull request"); every review, review comment, comment and failed check of that pull request arrives here as one event. It decides
// which of them are worth a look and turns those into one code.fix.followup task for this same agent, which reads everything said since the branch's newest commit.
// The task names only the pull request: the service finds the issue and the branch in its own record of the pull requests it opened, and refuses any other.
// The settings below are written into the file when it is installed (AIKIDO_WATCH_* and AIKIDO_RESEED_HANDLER=1 change them). It runs in the sandbox with no
// credentials; its state is a small file next to the workspaces (its own: the timer handler keeps another, and each has its own daily flood guard) and the service keeps the authoritative limits.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG = __CONFIG__;
const stateDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".aikido-fixer");
const stateFile = join(stateDir, "watch-state.json");
const MAX_SEEN = 200;
const MAX_PULL_REQUESTS = 100;

const drop = (reason) => ({ action: "drop", reason: reason.slice(0, 500) });
const deliver = (reason) => ({ action: "deliver", reason: reason.slice(0, 500) });
const plain = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : {});
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);

function load() {
	try {
		const stored = plain(JSON.parse(readFileSync(stateFile, "utf8")));
		return { days: plain(stored.days), seen: Array.isArray(stored.seen) ? stored.seen.filter((entry) => typeof entry === "string") : [], prs: plain(stored.prs) };
	} catch {
		return { days: {}, seen: [], prs: {} };
	}
}

function save(state) {
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(`${stateFile}.tmp`, JSON.stringify(state));
	renameSync(`${stateFile}.tmp`, stateFile);
}

/** Why this event is worth a look, or undefined: the agent's own pushes, merges, closes, approvals and passing checks are not. */
function reasonToLook(topic, event) {
	if (topic === "github.pull_request_review.submitted") {
		const state = String(plain(event.review).state ?? "");
		return state === "changes_requested" || state === "commented" ? `a review (${state})` : undefined;
	}
	if (topic === "github.pull_request_review_comment.created") return "a review comment";
	if (topic === "github.issue_comment.created") return event.isPullRequest === true ? "a comment" : undefined;
	if (topic === "github.check_run.completed") {
		const conclusion = String(event.conclusion ?? "");
		return conclusion === "failure" || conclusion === "timed_out" || conclusion === "action_required" ? `a check that ${conclusion === "failure" ? "failed" : conclusion.replace("_", " ")}` : undefined;
	}
	return undefined;
}

export default async function handle({ event, now }) {
	const data = plain(event?.data);
	const topic = typeof data.topic === "string" ? data.topic : "";
	const inner = plain(data.event);
	const repository = typeof data.repository === "string" ? data.repository.toLowerCase() : "";
	if (repository !== CONFIG.repositoryName) return drop("the pull request belongs to another repository");
	const number = Number(data.number);
	if (!Number.isInteger(number) || number < 1 || number > 999999999) return drop("the watch event names no pull request number");
	const sender = typeof inner.sender === "string" ? inner.sender.toLowerCase() : "";
	if (sender !== "" && CONFIG.ignoreSenders.includes(sender)) return drop(`${sender} is one of the logins whose events are ignored`);
	const why = reasonToLook(topic, inner);
	if (!why) return drop(`${topic || "this event"} needs no follow-up`);

	const state = load();
	const key = String(event?.key ?? "");
	if (key && state.seen.includes(key)) return drop("this event was already handled");
	const pull = plain(state.prs[number]);
	const startedAgo = (Date.parse(String(now)) - Date.parse(String(pull.last ?? ""))) / 1000;
	if (Number.isFinite(startedAgo) && startedAgo >= 0 && startedAgo < CONFIG.cooldownSeconds) return drop(`a follow-up of pull request #${number} started ${Math.round(startedAgo)} s ago: its task reads everything said since the newest commit`);
	if (count(pull.count) >= CONFIG.maxPerPullRequest) return deliver(`${CONFIG.maxPerPullRequest} follow-ups of pull request #${number} were already started: a person has to look at it`);
	const day = String(now).slice(0, 10);
	if (count(state.days[day]) >= CONFIG.submitCapPerDay) return deliver(`${CONFIG.submitCapPerDay} follow-ups were already started today, which is the daily cap`);
	state.days[day] = count(state.days[day]) + 1;
	state.prs[number] = { count: count(pull.count) + 1, last: String(now) };
	if (key) state.seen = [...state.seen, key].slice(-MAX_SEEN);
	const numbers = Object.keys(state.prs);
	if (numbers.length > MAX_PULL_REQUESTS) for (const old of numbers.sort((a, b) => String(state.prs[a].last).localeCompare(String(state.prs[b].last))).slice(0, numbers.length - MAX_PULL_REQUESTS)) delete state.prs[old];
	for (const old of Object.keys(state.days)) if (old < day && Object.keys(state.days).length > 7) delete state.days[old];
	save(state);

	return {
		action: "submit",
		reason: `${why} on pull request #${number}`,
		task: {
			capability: { id: "code.fix.followup", version: "1" },
			input: { repository: { url: CONFIG.repositoryUrl }, followUp: { pullRequest: `${CONFIG.repositoryUrl.replace(/\.git$/, "")}/pull/${number}`, round: 1, source: "watch" } },
			budget: CONFIG.budget,
		},
	};
}
