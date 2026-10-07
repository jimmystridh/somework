import { redactText } from "@somework/agent-kit";
import type { Triage } from "./result.ts";

export const NOTICE_MAX = 1500;

/** The link to a monitor, built from the site and the whole-number id only; text from an alert or from the model never becomes part of it. */
export const monitorUrl = (site: string, id: string | number): string => `https://app.${site}/monitors/${String(id).replace(/\D/g, "")}`;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Model text as one line for a person: no secrets, no links of its own, no control characters, a length. */
export function oneLine(text: string, max: number): string {
	const line = redactText(text.replace(CONTROL, " "))
		.replace(/\bhttps?:\/\/\S+/gi, "[link]")
		.replace(/\s+/g, " ")
		.trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The name to show: the monitor's own, unless it is a template (`{{host.name}}`), then the name the alert event carried with its status prefix (`[Triggered]`) taken off. */
export function displayName(monitorName: string | undefined, alertName: string | undefined): string | undefined {
	if (monitorName && !monitorName.includes("{{")) return monitorName;
	const resolved = alertName?.replace(/^\s*\[[^\]]*\]\s*/, "").trim();
	return resolved ? resolved : monitorName;
}

const LABEL: Record<Triage["outcome"], string> = { diagnosed: "diagnosed", inconclusive: "inconclusive", noise: "looks like noise" };

/**
 * The one message the service sends to the owner when a triage ends: severity, monitor, one line of what is going on, the suspected cause
 * with its confidence, the first three actions and the service's own link. Built by the service from the checked result, not written by
 * the model, and cut to a size a chat message can carry.
 */
export function buildNotice(triage: Triage, facts: { monitorId: string; monitorName?: string; site: string }): string {
	const name = oneLine(facts.monitorName ?? `monitor ${facts.monitorId}`, 100);
	const lines = [
		`Datadog triage: ${triage.severity.toUpperCase()}, ${LABEL[triage.outcome]}`,
		`Monitor: ${name} (${facts.monitorId})`,
		oneLine(triage.summary, 400),
		...(triage.suspectedCause ? [`Suspected cause (${triage.confidence} confidence): ${oneLine(triage.suspectedCause, 300)}`] : [`Confidence: ${triage.confidence}`]),
		...(triage.recommendedActions.length ? ["Next:", ...triage.recommendedActions.slice(0, 3).map((action, index) => `${index + 1}. ${oneLine(action, 160)}`)] : []),
		...(triage.warnings?.length ? [`Note: ${oneLine(triage.warnings[0]!, 160)}`] : []),
		monitorUrl(facts.site, facts.monitorId),
	];
	const text = lines.join("\n");
	if (text.length <= NOTICE_MAX) return text;
	// keep the link whatever happens to the rest
	const link = lines.at(-1)!;
	return `${text.slice(0, NOTICE_MAX - link.length - 2).trimEnd()}…\n${link}`;
}
