import type { MonitorSummary } from "./datadog/summaries.ts";
import { normalisePriority, PRIORITIES, type TriageSettings } from "./settings.ts";

export type Eligibility = { eligible: true } | { eligible: false; code: "recovered" | "monitor" | "ignored" | "priority" | "tags"; reason: string };

const RECOVERED = /^(ok|recovered|resolved|no data)$/i;

/** Whether this agent should triage the monitor at all. Decided before any model token is spent, from the monitor as the service read it. */
export function eligibility(
	monitor: Pick<MonitorSummary, "id" | "priority" | "tags"> & { name?: string },
	settings: Pick<TriageSettings, "minPriority" | "monitorIds" | "tagFilter"> & Partial<Pick<TriageSettings, "ignoreMonitorIds" | "ignoreNames" | "requirePriority">>,
	reportedStatus?: string,
): Eligibility {
	if (reportedStatus && RECOVERED.test(reportedStatus.trim())) return { eligible: false, code: "recovered", reason: `the alert reports the state ${reportedStatus.trim().slice(0, 20)}, which needs no triage` };
	if (settings.monitorIds.length > 0 && !settings.monitorIds.includes(monitor.id)) return { eligible: false, code: "monitor", reason: `monitor ${monitor.id} is not on this agent's list of monitors` };
	if (settings.ignoreMonitorIds?.includes(monitor.id)) return { eligible: false, code: "ignored", reason: `monitor ${monitor.id} is on this agent's list of monitors to ignore` };
	const name = monitor.name?.toLowerCase() ?? "";
	const ignoredName = settings.ignoreNames?.find((part) => name.includes(part));
	if (ignoredName) return { eligible: false, code: "ignored", reason: `the monitor name holds "${ignoredName}", which this agent ignores` };
	const priority = normalisePriority(monitor.priority);
	if (!priority && settings.requirePriority) return { eligible: false, code: "priority", reason: `the monitor has no priority and this agent only triages monitors of ${settings.minPriority} or higher` };
	if (priority && PRIORITIES.indexOf(priority) > PRIORITIES.indexOf(settings.minPriority)) return { eligible: false, code: "priority", reason: `the priority ${priority} is below the threshold ${settings.minPriority}` };
	if (settings.tagFilter.length > 0 && !monitor.tags.some((tag) => settings.tagFilter.includes(tag.toLowerCase()))) return { eligible: false, code: "tags", reason: "the monitor has none of the tags this agent triages" };
	return { eligible: true };
}
