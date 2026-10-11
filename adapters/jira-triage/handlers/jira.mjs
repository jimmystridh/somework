// @topics jira.issue.created jira.issue.updated jira.comment.created
// The event handler of the jira-triage role, installed by the service on its first start (and versioned like any handler).
// It decides what a Jira event is worth: nothing (drop), a note for a person (deliver) or one jira.triage job for this same agent (submit).
//   created  : a ticket of a triaged project starts a triage.
//   updated  : only when a field the checklist reads changed, and only for a ticket this handler saw created (so an old ticket someone edits is left alone);
//              with JIRA_BOT_USER set (a service account), never an edit made by that account: it is the bot's own echo.
//   comment  : only on a ticket this handler saw created, and never a comment the bot wrote itself (it starts with the bot's anchor).
// The agent itself decides what a job means: it keeps the queue, the marker label and the questions; this file is only an early filter and a flood guard.
// The settings below are written into the file when it is installed; change them with JIRA_PROJECTS, TRIAGE_DAILY_CAP and JIRA_RESEED_HANDLER=1, or edit the live copy.
// It runs in the sandbox with no credentials. Its state is a small file next to the workspaces. Event text is data: nothing from it is copied into the job
// except the ticket key (checked against a pattern), the event key, the names of the changed fields (cut) and the author and id of a comment.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG = __CONFIG__;
const KEY = /^[A-Z][A-Z0-9_]*-[0-9]{1,9}$/;
const COVERED = /^(summary|description|environment|attachment|issuetype|issue type|type)$/i;
const BOT_COMMENT = /^\s*\{anchor:tb-[a-z0-9-]{4,60}\}/;
const AUTHOR = /^[A-Za-z0-9._@-]{1,100}$/;
const stateDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".jira-triage");
const stateFile = join(stateDir, "handler-state.json");
const MAX_SEEN = 400;
const MAX_WATCH = 2000;
const DAY = 86_400_000;

const drop = (reason) => ({ action: "drop", reason: reason.slice(0, 500) });
const deliver = (reason) => ({ action: "deliver", reason: reason.slice(0, 500) });
const plain = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : {});
const integer = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);

function load() {
	try {
		const stored = plain(JSON.parse(readFileSync(stateFile, "utf8")));
		return { days: plain(stored.days), watch: plain(stored.watch), seen: Array.isArray(stored.seen) ? stored.seen.filter((entry) => typeof entry === "string") : [] };
	} catch {
		return { days: {}, watch: {}, seen: [] };
	}
}

function save(state) {
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(`${stateFile}.tmp`, JSON.stringify(state));
	renameSync(`${stateFile}.tmp`, stateFile);
}

export default async function handle({ event, now }) {
	const data = plain(event?.data);
	const issue = plain(data.issue);
	const ticket = typeof issue.key === "string" ? issue.key.trim() : "";
	if (!KEY.test(ticket)) return deliver("the event carries no ticket key, so no triage was started");
	if (!CONFIG.projects.includes(ticket.split("-")[0])) return drop(`${ticket.split("-")[0]} is not one of the projects this agent triages`);

	const state = load();
	const key = String(event?.key ?? "");
	if (key && state.seen.includes(key)) return drop("this delivery was already handled");
	const topic = String(event?.topic ?? "");
	const stamp = Date.parse(now);
	const watched = integer(state.watch[ticket]) > 0 && stamp - integer(state.watch[ticket]) < CONFIG.watchDays * DAY;

	let trigger;
	if (topic === "jira.issue.created") {
		if (watched) return drop("a triage of this ticket was already started");
		trigger = { kind: "created" };
	} else if (topic === "jira.issue.updated") {
		if (CONFIG.botUser !== "" && data.actor === CONFIG.botUser) return drop("an edit made by the account the agent itself writes with");
		const changed = Array.isArray(data.changed) ? data.changed.filter((name) => typeof name === "string").map((name) => name.slice(0, 60)).slice(0, 30) : [];
		if (!changed.some((name) => COVERED.test(name.trim()))) return drop("only fields the checklist does not read changed");
		if (!watched) return drop("this agent did not triage this ticket");
		trigger = { kind: "updated", changed };
	} else if (topic === "jira.comment.created") {
		const comment = plain(data.comment);
		if (typeof comment.body === "string" && BOT_COMMENT.test(comment.body)) return drop("a comment the triage bot wrote itself");
		if (!watched) return drop("this agent did not triage this ticket");
		trigger = { kind: "comment", ...(typeof comment.id === "string" || typeof comment.id === "number" ? { commentId: String(comment.id).slice(0, 20) } : {}), ...(typeof comment.author === "string" && AUTHOR.test(comment.author) ? { author: comment.author } : {}) };
	} else {
		return deliver(`this handler does not know ${topic.slice(0, 60)}`);
	}

	const day = String(now).slice(0, 10);
	if (integer(state.days[day]) >= CONFIG.submitCapPerDay) return deliver(`${CONFIG.submitCapPerDay} triage jobs were already started today, which is the daily cap; ${ticket} waits for a person`);
	state.days[day] = integer(state.days[day]) + 1;
	if (topic === "jira.issue.created") state.watch[ticket] = stamp;
	if (key) state.seen = [...state.seen, key].slice(-MAX_SEEN);
	for (const old of Object.keys(state.days)) if (old < day && Object.keys(state.days).length > 7) delete state.days[old];
	const tickets = Object.keys(state.watch);
	if (tickets.length > MAX_WATCH) for (const oldest of tickets.sort((a, b) => integer(state.watch[a]) - integer(state.watch[b])).slice(0, tickets.length - MAX_WATCH)) delete state.watch[oldest];
	save(state);

	return {
		action: "submit",
		reason: `${trigger.kind} on ${ticket}`,
		task: { capability: { id: "jira.triage", version: "1" }, input: { ticket, trigger: { ...trigger, ...(key ? { eventKey: key.slice(0, 120) } : {}) } } },
	};
}
