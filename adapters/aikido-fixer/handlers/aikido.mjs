// @topics aikido.*
// The event handler of the aikido-fixer role, installed by the service on its first start (and versioned like any handler).
// It decides what an Aikido event is worth: nothing (drop), a note for a person (deliver) or one fix task for this same agent (submit).
// The settings below are written into the file when it is installed; change them with AIKIDO_* and AIKIDO_RESEED_HANDLER=1, or edit the live copy.
// It runs in the sandbox with no credentials. Its state is a small file next to the workspaces; the service keeps the authoritative counters
// on its own host, this file is only an early filter. Event text is data: nothing from it is copied into the task except the issue number.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG = __CONFIG__;
const SEVERITIES = ["low", "medium", "high", "critical"];
const CLOSED = /(closed|resolved|fixed|ignored|snoozed|dismissed|deleted|removed|auto_closed|false_positive)/;
const stateDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".aikido-fixer");
const stateFile = join(stateDir, "handler-state.json");
const MAX_SEEN = 200;

const drop = (reason) => ({ action: "drop", reason: reason.slice(0, 500) });
const deliver = (reason) => ({ action: "deliver", reason: reason.slice(0, 500) });

const plain = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : {});

function load() {
	try {
		const stored = plain(JSON.parse(readFileSync(stateFile, "utf8")));
		return { issues: plain(stored.issues), days: plain(stored.days), seen: Array.isArray(stored.seen) ? stored.seen.filter((entry) => typeof entry === "string") : [] };
	} catch {
		return { issues: {}, days: {}, seen: [] };
	}
}

function save(state) {
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(`${stateFile}.tmp`, JSON.stringify(state));
	renameSync(`${stateFile}.tmp`, stateFile);
}

const text = (value) => (typeof value === "string" ? value.toLowerCase() : "");

export default async function handle({ event, now }) {
	const data = event && typeof event.data === "object" && event.data !== null && !Array.isArray(event.data) ? event.data : {};
	const change = String(event?.topic ?? "").split(".").slice(2).join("_");
	if (CLOSED.test(change) || CLOSED.test(text(data.type))) return drop("the issue was closed, resolved or dismissed");

	const id = typeof data.issueId === "string" || typeof data.issueId === "number" ? String(data.issueId).trim() : "";
	if (!/^[0-9]{1,12}$/.test(id)) return deliver("the event carries no numeric Aikido issue id, so no fix was started");

	const severity = text(data.severity);
	if (SEVERITIES.includes(severity) && SEVERITIES.indexOf(severity) < SEVERITIES.indexOf(CONFIG.minSeverity)) return drop(`severity ${severity} is below ${CONFIG.minSeverity}`);

	const repository = text(data.repository);
	if (repository && !CONFIG.repositoryNames.includes(repository) && !CONFIG.repositoryNames.includes(repository.split("/").pop())) return drop(`the issue belongs to another repository (${repository.slice(0, 80)})`);

	const state = load();
	const key = String(event?.key ?? "");
	if (key && state.seen.includes(key)) return drop("this delivery was already handled");
	const known = plain(state.issues[id]);
	const issue = { attempts: Number.isInteger(known.attempts) && known.attempts >= 0 ? known.attempts : 0, lastAt: typeof known.lastAt === "string" ? known.lastAt : undefined };
	if (issue.attempts >= CONFIG.maxAttempts) return deliver(`issue ${id} was already attempted ${issue.attempts} time(s): a person has to look at it`);
	if (issue.lastAt && Date.parse(now) - Date.parse(issue.lastAt) < CONFIG.cooldownMinutes * 60_000) return drop(`an attempt on issue ${id} started less than ${CONFIG.cooldownMinutes} minutes ago`);
	const day = String(now).slice(0, 10);
	if ((Number.isInteger(state.days[day]) ? state.days[day] : 0) >= CONFIG.dailyCap) return deliver(`the daily cap of ${CONFIG.dailyCap} fix attempts is reached; issue ${id} waits for a person`);

	state.issues[id] = { attempts: issue.attempts + 1, lastAt: now };
	state.days[day] = (Number.isInteger(state.days[day]) ? state.days[day] : 0) + 1;
	if (key) state.seen = [...state.seen, key].slice(-MAX_SEEN);
	for (const old of Object.keys(state.days)) if (old < day && Object.keys(state.days).length > 7) delete state.days[old];
	save(state);

	const url = typeof data.url === "string" && /^https:\/\/([a-z0-9-]+\.)*aikido\.dev\//i.test(data.url) ? data.url.slice(0, 500) : undefined;
	return {
		action: "submit",
		reason: `fix attempt ${issue.attempts + 1} of ${CONFIG.maxAttempts} for Aikido issue ${id}`,
		task: {
			capability: { id: "code.fix", version: "1" },
			input: { issue: { id: Number(id), ...(url ? { url } : {}), ...(repository ? { repository: repository.slice(0, 200) } : {}) }, repository: { url: CONFIG.repositoryUrl } },
			budget: CONFIG.budget,
		},
	};
}
