// @topics clock.timer.aikido_fixer.due
// The follow-up handler of the aikido-fixer role, installed next to the Aikido handler. After the agent opened a pull request it asked the event hub to
// wake it ("look at this pull request again in 15 minutes"); that wake arrives here. It turns it into one code.fix.followup task for this same agent,
// which reads what reviewers and checks said since the newest commit and answers with a commit on the same branch, or with nothing.
// The settings below are written into the file when it is installed (AIKIDO_FOLLOWUP_* and AIKIDO_RESEED_HANDLER=1 change them). It runs in the sandbox with no
// credentials; its state is a small file next to the workspaces and the service keeps the authoritative limits. The timer's note and payload were written
// by the agent itself, but only the validated address, branch, issue number and check number are carried into the task.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG = __CONFIG__;
const PULL_REQUEST = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/([0-9]{1,9})$/;
const BRANCH = /^agent\/[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/;
const stateDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".aikido-fixer");
const stateFile = join(stateDir, "followup-state.json");
const MAX_SEEN = 200;

const drop = (reason) => ({ action: "drop", reason: reason.slice(0, 500) });
const deliver = (reason) => ({ action: "deliver", reason: reason.slice(0, 500) });
const plain = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : {});

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
	const data = plain(event?.data);
	const payload = plain(data.payload);
	if (payload.kind !== "pr-followup") return deliver("a timer this agent asked for that is not a pull request follow-up");

	const pullRequest = typeof payload.pullRequest === "string" ? PULL_REQUEST.exec(payload.pullRequest.trim()) : null;
	if (!pullRequest) return deliver("the timer names no pull request address, so no follow-up was started");
	if (`${pullRequest[1]}/${pullRequest[2]}`.toLowerCase() !== CONFIG.repositoryName) return drop("the pull request belongs to another repository");
	const branch = typeof payload.branch === "string" ? payload.branch : "";
	if (!BRANCH.test(branch) || branch.includes("..") || branch.includes("//") || branch.endsWith("/")) return deliver("the timer names no agent/ branch, so no follow-up was started");
	const issue = typeof payload.issue === "number" || typeof payload.issue === "string" ? String(payload.issue).trim() : "";
	if (!/^[0-9]{1,12}$/.test(issue)) return deliver("the timer carries no Aikido issue number, so no follow-up was started");
	const round = Number(payload.round);
	if (!Number.isInteger(round) || round < 1 || round > CONFIG.maxRounds) return drop(`check ${payload.round} is beyond the ${CONFIG.maxRounds} checks this agent makes`);

	const state = load();
	const key = String(event?.key ?? "");
	if (key && state.seen.includes(key)) return drop("this timer was already handled");
	const day = String(now).slice(0, 10);
	if ((Number.isInteger(state.days[day]) ? state.days[day] : 0) >= CONFIG.submitCapPerDay) return deliver(`${CONFIG.submitCapPerDay} follow-ups were already started today, which is the daily cap`);
	state.days[day] = (Number.isInteger(state.days[day]) ? state.days[day] : 0) + 1;
	if (key) state.seen = [...state.seen, key].slice(-MAX_SEEN);
	for (const old of Object.keys(state.days)) if (old < day && Object.keys(state.days).length > 7) delete state.days[old];
	save(state);

	return {
		action: "submit",
		reason: `check ${round} of pull request #${pullRequest[3]}`,
		task: {
			capability: { id: "code.fix.followup", version: "1" },
			input: { issue: { id: Number(issue) }, repository: { url: CONFIG.repositoryUrl, ref: branch }, followUp: { pullRequest: pullRequest[0], branch, round } },
			budget: CONFIG.budget,
		},
	};
}
