import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { CHAT_TASK_PREFIX, EVENT_NOTICE_LABEL, InvalidInput, silent, type Log, type ResultContext, type ResultPatch, type RoleHooks, type ServiceContext } from "@somework/agent-kit";
import type { Outcome as TaskOutcome, SomeWorkClient } from "@somework/sdk";
import { TriageLedger } from "./attempts.ts";
import { triageChat } from "./chat.ts";
import { DatadogClient, DatadogError, readCredentials } from "./datadog/client.ts";
import { summariseMonitor, type MonitorSummary } from "./datadog/summaries.ts";
import { createDatadogTools, type IssuedRefs } from "./datadog/tools.ts";
import { eligibility } from "./eligibility.ts";
import { buildNotice, monitorUrl } from "./notice.ts";
import { buildInstruction, type TriageInput } from "./prompt.ts";
import type { Triage } from "./result.ts";
import { seedHandler } from "./seed.ts";
import { loadSettings, type TriageSettings } from "./settings.ts";
import { TriageRuntime } from "./triage-runtime.ts";

export const SKIPPED = "skipped: ";
const MAX_RAW_ARTIFACT = 256 * 1024;

interface TaskState {
	input: TriageInput;
	monitor: MonitorSummary;
	skip?: string;
	workspace?: string;
	env?: ExecutionEnv;
}

export interface TriageOptions {
	settings: TriageSettings;
	datadog: Pick<DatadogClient, "getMonitor">;
	refs: Pick<IssuedRefs, "has">;
	secrets?: () => string[];
	stateDir: string;
	client: Pick<SomeWorkClient, "post">;
	log?: Log;
	now?: () => Date;
	/** For tests: the boundary markers around Datadog text. */
	boundary?: () => string;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

function parseInput(input: any, settings: TriageSettings): TriageInput {
	const id = input?.monitor?.id;
	const key = typeof id === "number" ? String(id) : typeof id === "string" ? id.trim() : "";
	if (!/^[0-9]{1,15}$/.test(key)) throw new InvalidInput("monitor.id must be the whole-number id of a Datadog monitor");
	const window = input?.windowMinutes === undefined ? settings.windowMinutes : input.windowMinutes;
	if (!Number.isInteger(window) || window < 5 || window > 360) throw new InvalidInput("windowMinutes must be a whole number from 5 to 360");
	const at = typeof input?.alert?.at === "string" && !Number.isNaN(Date.parse(input.alert.at)) ? input.alert.at : undefined;
	return {
		monitor: { id: key, ...(typeof input.monitor.name === "string" ? { name: input.monitor.name.slice(0, 300) } : {}), ...(typeof input.monitor.status === "string" ? { status: input.monitor.status.slice(0, 40) } : {}) },
		...(input?.alert ? { alert: { ...(typeof input.alert.eventId === "string" ? { eventId: input.alert.eventId.slice(0, 200) } : {}), ...(at ? { at } : {}) } } : {}),
		windowMinutes: window,
		...(typeof input?.hint === "string" && input.hint.trim() !== "" ? { hint: input.hint.slice(0, 2000) } : {}),
	};
}

/**
 * The role's code on top of the kit's job handler (which works without a repository here):
 *  - `prepareInput` reads the monitor from Datadog, decides whether it is this agent's to triage and counts the triage on the service host;
 *  - `beforeRun` ends an ineligible task as `skipped` before a token is spent;
 *  - `wrapRuntime` refuses approvals and checks the model's answer (shape, and that every finding cites a tool call or is inference);
 *  - `result` reports the diagnosis and sends the owner one deterministic notice;
 *  - `onSettled` removes the task's scratch directory.
 */
export function createTriageHooks(options: TriageOptions): { hooks: RoleHooks; ledger: TriageLedger } {
	const { settings } = options;
	const log = options.log ?? silent;
	const now = options.now ?? (() => new Date());
	const boundary = options.boundary ?? (() => randomBytes(8).toString("hex"));
	const ledger = new TriageLedger(join(options.stateDir, "datadog-triage.json"), { cooldownMinutes: settings.cooldownMinutes, dailyCap: settings.dailyCap }, now);
	const tasks = new Map<string, TaskState>();
	let guarded: TriageRuntime | undefined;

	const stateOf = (taskId: string): TaskState => {
		const state = tasks.get(taskId);
		if (!state) throw new InvalidInput("the task has no prepared monitor");
		return state;
	};

	const notify = async (taskId: string, triage: Triage, state: TaskState): Promise<void> => {
		// a noisy alert needs no message, and a triage a person asked for in chat is answered in that chat
		if (triage.outcome === "noise" || taskId.startsWith(CHAT_TASK_PREFIX)) return;
		const text = buildNotice(triage, { monitorId: state.monitor.id, monitorName: state.monitor.name, site: settings.site });
		try {
			await options.client.post(
				"/v1/messages",
				{ type: "chat.notice", recipients: [{ kind: "agent", id: settings.notifyTo }], triggerMode: "never", content: { mediaType: "text/plain", data: text }, labels: { [EVENT_NOTICE_LABEL]: "true" } },
				{ idempotencyKey: `triage-notice:${taskId}` },
			);
			log("info", "triage_notice_sent", { taskId, to: settings.notifyTo, chars: text.length });
		} catch (error) {
			log("warn", "triage_notice_failed", { taskId, error: String(error).slice(0, 200) });
		}
	};

	const hooks: RoleHooks = {
		async prepareInput(input, { taskId }) {
			const parsed = parseInput(input, settings);
			let monitor: MonitorSummary;
			try {
				monitor = summariseMonitor(await options.datadog.getMonitor(parsed.monitor.id), options.secrets?.());
			} catch (error) {
				if (error instanceof DatadogError && error.permanent) throw new InvalidInput(error.message);
				throw error;
			}
			const verdict = eligibility(monitor, settings, parsed.monitor.status);
			let skip = verdict.eligible ? undefined : verdict.reason;
			if (!skip) {
				const begun = ledger.begin(monitor.id, taskId);
				if (!begun.ok) skip = begun.reason;
			}
			tasks.set(taskId, { input: parsed, monitor, ...(skip ? { skip } : {}) });
			log("info", "triage_prepared", { taskId, monitor: monitor.id, priority: monitor.priority, skipped: skip !== undefined });
			return { ...input, agentKey: `datadog:${monitor.id}:${taskId}` };
		},

		instruction(_input, { taskId }) {
			const state = stateOf(taskId);
			return buildInstruction(state.input, state.monitor, boundary(), now());
		},

		async beforeRun(context) {
			const state = stateOf(context.taskId);
			state.workspace = context.workspace;
			state.env = context.envFor(context.workspace);
			if (state.skip) return { blocked: { reason: `${SKIPPED}${state.skip}`, details: { monitor: state.monitor.id } } };
		},

		wrapRuntime(inner) {
			guarded = new TriageRuntime(inner, options.refs, log);
			return guarded;
		},

		async result(base, context): Promise<ResultPatch> {
			const state = tasks.get(context.taskId);
			if (!state) return { failure: { code: "job_error", message: "the run finished without its monitor", retryable: true } };
			const usage = (base as { usage?: unknown }).usage;
			const common = { monitorId: Number(state.monitor.id), monitorUrl: monitorUrl(settings.site, state.monitor.id) };
			if (context.blocked) {
				const reason = clip(context.blocked.reason.startsWith(SKIPPED) ? context.blocked.reason.slice(SKIPPED.length) : context.blocked.reason, 1000);
				ledger.recordOutcome(context.taskId, { monitorId: state.monitor.id, outcome: "skipped" });
				return { result: { outcome: "skipped", ...common, severity: "info", summary: reason, confidence: "low", timeline: [], evidence: [], recommendedActions: [], ...(usage ? { usage } : {}) } };
			}
			const judged = guarded?.take(`somework:${context.taskId}`);
			if (!judged) return { failure: { code: "job_error", message: "the run finished without a diagnosis to report", retryable: true } };
			if (!judged.ok) return invalidOutput(context, judged.reason, judged.raw, options.secrets?.() ?? [], ledger, state.monitor.id, log);
			const triage = judged.triage;
			ledger.recordOutcome(context.taskId, { monitorId: state.monitor.id, outcome: triage.outcome, severity: triage.severity, ...(tokensOf(usage) !== undefined ? { tokens: tokensOf(usage)! } : {}) });
			await notify(context.taskId, triage, state);
			return { result: { ...triage, ...common, ...(judged.truncated ? { warnings: [...(triage.warnings ?? []), "some text of the answer was cut to the size limits"] } : {}), ...(usage ? { usage } : {}) } };
		},

		onSettled(taskId, outcome: TaskOutcome) {
			guarded?.take(`somework:${taskId}`);
			const state = tasks.get(taskId);
			tasks.delete(taskId);
			if (!state?.env || !state.workspace || outcome.type !== "completed") return;
			// the result is reported: the scratch directory and the saved data have done their job
			void state.env.remove(state.workspace, { recursive: true, force: true }, BACKGROUND_CONTEXT).catch(() => undefined);
		},
	};
	return { hooks, ledger };
}

const tokensOf = (usage: unknown): number | undefined => {
	const total = usage as { totalTokens?: unknown } | undefined;
	return typeof total?.totalTokens === "number" && Number.isFinite(total.totalTokens) ? total.totalTokens : undefined;
};

/** A failed outcome cannot carry artifacts, so the raw answer is uploaded and referenced from the failure's details. */
async function invalidOutput(context: ResultContext, reason: string, raw: string, secrets: string[], ledger: TriageLedger, monitorId: string, log: Log): Promise<ResultPatch> {
	let text = raw;
	for (const secret of secrets) if (secret.length >= 8) text = text.split(secret).join("[redacted]");
	const artifact = (await context.client.uploadArtifact({ filename: `${context.taskId}-raw-answer.txt`, mediaType: "text/plain", bytes: text.slice(0, MAX_RAW_ARTIFACT), sourceTaskId: context.taskId })) as { artifactId?: string; uri?: string };
	log("warn", "invalid_triage_output", { taskId: context.taskId, reason: reason.slice(0, 300) });
	ledger.recordOutcome(context.taskId, { monitorId, outcome: "failed:invalid_triage_output" });
	return { failure: { code: "invalid_triage_output", message: `the diagnosis could not be turned into a result: ${clip(reason, 400)}`, retryable: false, details: { rawAnswer: { artifactId: artifact.artifactId, uri: artifact.uri } } } };
}

/** For `runAgentService`: the hooks of the service being composed. Fails at startup when the deployment cannot work. */
export async function datadogTriageHooksFor(context: ServiceContext): Promise<RoleHooks> {
	const settings = loadSettings(context.env);
	if (context.config.concurrency !== 1) throw new Error("the Datadog triage agent triages one alert at a time: PI_CONCURRENCY must be 1");
	readCredentials(settings.credentialsFile);
	const credentials = () => readCredentials(settings.credentialsFile);
	const datadog = new DatadogClient({ site: settings.site, credentials, apiBase: settings.apiBase });
	const secrets = (): string[] => {
		try {
			const { apiKey, appKey } = credentials();
			return [apiKey, appKey];
		} catch {
			return [];
		}
	};
	const tools = createDatadogTools({ datadog, secrets, limits: { saveFileBytes: settings.saveFileBytes, saveTaskBytes: settings.saveTaskBytes }, log: context.log });
	seedHandler({ stateDir: context.config.state.dir, settings, log: context.log, reseed: context.env.DD_RESEED_HANDLER === "1" });
	const { hooks, ledger } = createTriageHooks({ settings, datadog, refs: tools.refs, secrets, stateDir: context.config.state.dir, client: context.client, log: context.log });
	const credentialsUsable = async (): Promise<boolean> => {
		try {
			return !!credentials();
		} catch {
			return false;
		}
	};
	return { ...hooks, extensions: [tools.extension], chat: triageChat({ ledger }), readinessChecks: { datadog_credentials: credentialsUsable } };
}
