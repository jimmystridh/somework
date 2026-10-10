// @topics datadog.monitor.*
// The event handler of the datadog-triage role, installed by the service on its first start (and versioned like any handler).
// It decides what a Datadog monitor event is worth: nothing (drop), a note for a person (deliver) or one triage task for this same agent (submit).
// The settings below are written into the file when it is installed; change them with DD_* and DD_RESEED_HANDLER=1, or edit the live copy.
// It runs in the sandbox with no credentials. Its state is a small file next to the workspaces; the service keeps the authoritative counters
// on its own host, this file is only an early filter. Event text is data: nothing from it is copied into the task except the monitor id,
// a clipped name and the alert's state.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG = __CONFIG__;
const RECOVERED = /^(recovered|resolved|ok|no_data|no data)$/;
const stateDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".datadog-triage");
const stateFile = join(stateDir, "handler-state.json");
const MAX_SEEN = 200;

const drop = (reason) => ({ action: "drop", reason: reason.slice(0, 500) });
const deliver = (reason) => ({ action: "deliver", reason: reason.slice(0, 500) });

const plain = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : {});
const integer = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);

function load() {
	try {
		const stored = plain(JSON.parse(readFileSync(stateFile, "utf8")));
		return { monitors: plain(stored.monitors), days: plain(stored.days), seen: Array.isArray(stored.seen) ? stored.seen.filter((entry) => typeof entry === "string") : [] };
	} catch {
		return { monitors: {}, days: {}, seen: [] };
	}
}

function save(state) {
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(`${stateFile}.tmp`, JSON.stringify(state));
	renameSync(`${stateFile}.tmp`, stateFile);
}

/** `P2`, `p2`, `2` or `priority:2` to a number 1 to 5; anything else is unknown. */
const priorityNumber = (value) => {
	const match = /^(?:priority:)?p?([1-5])$/i.exec(String(value ?? "").trim());
	return match ? Number(match[1]) : undefined;
};

export default async function handle({ event, now }) {
	const data = event && typeof event.data === "object" && event.data !== null && !Array.isArray(event.data) ? event.data : {};
	const change = String(event?.topic ?? "").split(".").slice(2).join("_");
	const transition = typeof data.transition === "string" ? data.transition.toLowerCase() : "";
	if (RECOVERED.test(change) || RECOVERED.test(transition)) return drop("the monitor recovered: nothing to triage");
	if (CONFIG.ignoreWarn && (change === "warn" || transition === "warn")) return drop("warnings are not triaged (DD_IGNORE_WARN)");

	const id = typeof data.monitorId === "string" || typeof data.monitorId === "number" ? String(data.monitorId).trim() : "";
	if (!/^[0-9]{1,15}$/.test(id)) return deliver("the event carries no numeric Datadog monitor id, so no triage was started");

	if (CONFIG.monitorIds.length > 0 && !CONFIG.monitorIds.includes(id)) return drop(`monitor ${id} is not on the list of monitors this agent triages`);
	if ((CONFIG.ignoreMonitorIds ?? []).includes(id)) return drop(`monitor ${id} is on the list of monitors this agent ignores`);
	const monitorName = typeof data.monitor === "string" ? data.monitor.toLowerCase() : "";
	const ignoredName = (CONFIG.ignoreNames ?? []).find((part) => monitorName.includes(part));
	if (ignoredName) return drop(`the monitor name holds "${ignoredName}", which this agent ignores`);
	const priority = priorityNumber(data.priority);
	if (priority === undefined && CONFIG.requirePriority) return drop(`the monitor has no priority and only ${CONFIG.minPriority} or higher is triaged`);
	if (priority !== undefined && priority > priorityNumber(CONFIG.minPriority)) return drop(`priority P${priority} is below ${CONFIG.minPriority}`);
	if (CONFIG.tagFilter.length > 0) {
		const tags = Array.isArray(data.tags) ? data.tags.filter((tag) => typeof tag === "string").map((tag) => tag.toLowerCase()) : [];
		if (!tags.some((tag) => CONFIG.tagFilter.includes(tag))) return drop("the monitor has none of the tags this agent triages");
	}

	const state = load();
	const key = String(event?.key ?? "");
	if (key && state.seen.includes(key)) return drop("this delivery was already handled");
	const known = plain(state.monitors[id]);
	const lastAt = typeof known.lastAt === "string" ? known.lastAt : undefined;
	if (lastAt && Date.parse(now) - Date.parse(lastAt) < CONFIG.cooldownMinutes * 60_000) return drop(`monitor ${id} was triaged less than ${CONFIG.cooldownMinutes} minutes ago`);
	const day = String(now).slice(0, 10);
	if (integer(state.days[day]) >= CONFIG.dailyCap) return deliver(`the daily cap of ${CONFIG.dailyCap} triages is reached; monitor ${id} waits for a person`);

	state.monitors[id] = { lastAt: now, count: integer(known.count) + 1 };
	state.days[day] = integer(state.days[day]) + 1;
	if (key) state.seen = [...state.seen, key].slice(-MAX_SEEN);
	for (const old of Object.keys(state.days)) if (old < day && Object.keys(state.days).length > 7) delete state.days[old];
	save(state);

	const name = typeof data.monitor === "string" ? data.monitor.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) : "";
	const status = transition === "warn" || change === "warn" ? "warn" : "alert";
	return {
		action: "submit",
		reason: `triage of Datadog monitor ${id} (${status})`,
		task: {
			capability: { id: "ops.triage", version: "1" },
			input: { monitor: { id: Number(id), ...(name ? { name } : {}), status }, alert: { ...(typeof event?.id === "string" ? { eventId: event.id.slice(0, 200) } : {}), at: now }, windowMinutes: CONFIG.windowMinutes },
			budget: CONFIG.budget,
		},
	};
}
