import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Extension } from "@earendil-works/pi-durable";
import { InvalidInput, silent, type Log, type ResultContext, type ResultPatch, type RoleHooks } from "@somework/agent-kit";
import { redactLog } from "@somework/agent-kit/windows";
import type { SomeWorkClient } from "@somework/sdk";
import { AppRunner, type AppEnv, type AppProfile } from "./app.ts";
import type { BrowserBackend } from "./browser/backend.ts";
import { BrowserDaemon } from "./browser/daemon.ts";
import { buildBrief, evidenceDirFor, wrapperFor } from "./prompt.ts";
import { QaRuntime } from "./qa-runtime.ts";
import { pullRequestInText, saysNotMerged } from "./revision.ts";
import type { QaReport } from "./result.ts";
import type { QaSession } from "./session.ts";

export interface QaHooksOptions {
	/** Workspace root, `/`-separated (evidence goes to `<root>/.qa/<taskId>`). */
	root: string;
	ticketPattern: RegExp;
	profiles: Record<string, AppProfile>;
	session: QaSession;
	/** The environment applications are started in (the confined Windows one in production). */
	appEnv: (cwd: string) => AppEnv;
	/** A browser for one verification, limited to `allowHosts`. */
	browser: (allowHosts: readonly string[]) => Promise<BrowserBackend>;
	allowHosts: readonly string[];
	/** Absolute path of the qa-browser command line (`browser/cli.ts`), as the model's shell takes it. */
	cliPath: string;
	/** Extra tools (the ticket system's). */
	extensions?: Extension<any>[];
	hasTicketSystem: boolean;
	/** The ticket's description and comments, oldest first, to find the pull request that holds the fix. */
	ticketText?: (ticket: string) => Promise<string>;
	verifiedLabel: string;
	client: Pick<SomeWorkClient, "uploadArtifact">;
	log?: Log;
	/** Literal secrets to scrub from anything that is reported. */
	secrets?: readonly string[];
	/** For tests. */
	fetch?: typeof fetch;
}

const MAX_VIDEOS = 3;
const MAX_SCREENSHOTS = 20;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_RAW_ARTIFACT = 256 * 1024;
const GATE_KEY = "__qaGate";
const UNTESTABLE_KEY = "__qaUntestable";

interface Active {
	taskId: string;
	profile: AppProfile;
	workspace: string;
	startedAtMs: number;
	daemon?: BrowserDaemon;
	backendRevision?: string;
	stopped?: boolean;
}

type EvidenceKind = "video" | "screenshot";
interface Evidence {
	artifactId: string;
	kind: EvidenceKind;
	filename: string;
}

/**
 * The QA role's code on top of the kit's repository handler, for one verification at a time:
 *  - `prepareInput` / `instruction`: the ticket-key gate and the brief (which application profile, which commands);
 *  - `beforeRun`: starts the application from its profile and the browser, and tells the ticket tools which job is running;
 *  - `beforeFinalize`: closes the browser so the video is finished before it is collected;
 *  - `result`: turns the model's report into the card's result, uploads the video and screenshots, and says what happened in the ticket
 *    system; a `verified` report without a video is not verified;
 *  - `afterRun`: always stops the browser and the application (and sweeps what they left behind).
 */
export function createQaHooks(options: QaHooksOptions): RoleHooks {
	const log = options.log ?? silent;
	const secrets = options.secrets ?? [];
	const scrub = (text: string): string => redactLog(text, secrets);
	let active: Active | undefined;
	let guarded: QaRuntime | undefined;

	async function stopEverything(): Promise<void> {
		const current = active;
		if (!current) return;
		active = undefined;
		try {
			await current.daemon?.stop();
		} catch (error) {
			log("warn", "browser_stop_failed", { taskId: current.taskId, error: scrub(error instanceof Error ? error.message : String(error)) });
		}
		const runner = new AppRunner({ env: options.appEnv(options.root), secrets, fetch: options.fetch });
		const stopped = await runner.stop(current.profile, current.workspace, current.startedAtMs);
		log("info", "app_stopped", { taskId: current.taskId, ...stopped });
		options.session.end();
	}

	/** Moves the checkout to the pull request the ticket names; a ticket that says its fix is unmerged and names none cannot be judged on the default branch. */
	async function pickRevision(input: any): Promise<any> {
		if (!options.ticketText || typeof input?.ticket !== "string") return input;
		const ref = input.repository?.ref;
		if (ref && ref !== "HEAD") return input;
		let text: string;
		try {
			text = await options.ticketText(input.ticket.trim());
		} catch (error) {
			log("warn", "ticket_text_failed", { ticket: input.ticket, error: scrub(error instanceof Error ? error.message : String(error)).slice(0, 300) });
			return input;
		}
		const pullRequest = pullRequestInText(text);
		if (pullRequest) {
			log("info", "revision_from_ticket", { ticket: input.ticket, pullRequest });
			return { ...input, repository: { ...input.repository, ref: `refs/pull/${pullRequest}/head` }, testedPullRequest: pullRequest };
		}
		if (saysNotMerged(text)) return { ...input, [UNTESTABLE_KEY]: `the ticket says its fix is not merged and names no pull request, so there is no revision to verify (the default branch does not have the change)` };
		return input;
	}

	return {
		extensions: options.extensions,

		async prepareInput(input) {
			// a ticket this agent is not configured for is `skipped`: the job completes without the model and without a call to the ticket system
			if (typeof input?.ticket === "string" && !options.ticketPattern.test(input.ticket.trim())) return { ...input, [GATE_KEY]: `the ticket key ${input.ticket.trim().slice(0, 40)} does not match the keys this agent handles` };
			return await pickRevision(input);
		},

		instruction(input, { taskId }) {
			if (input?.[GATE_KEY]) return "skipped";
			if (input?.[UNTESTABLE_KEY]) return "not testable";
			return buildBrief(input, taskId, { root: options.root, profiles: options.profiles, ticketPattern: options.ticketPattern, hasTicketSystem: options.hasTicketSystem, verifiedLabel: options.verifiedLabel });
		},

		async beforeRun(context) {
			if (context.input?.[GATE_KEY]) return { blocked: { reason: String(context.input[GATE_KEY]), details: { skipped: true } } };
			if (context.input?.[UNTESTABLE_KEY]) return { blocked: { reason: String(context.input[UNTESTABLE_KEY]) } };
			const input = context.input;
			const profile = options.profiles[input.app === undefined ? "default" : String(input.app)];
			if (!profile) throw new InvalidInput(`no application profile "${input.app ?? "default"}" is configured on this agent`);
			const evidence = evidenceDirFor(options.root, context.taskId);
			mkdirSync(evidence, { recursive: true });
			options.session.start({ taskId: context.taskId, ticket: String(input.ticket).trim(), evidenceDir: evidence });
			const current: Active = { taskId: context.taskId, profile, workspace: context.workspace, startedAtMs: Date.now() };
			active = current;

			const runner = new AppRunner({ env: options.appEnv(options.root), secrets, fetch: options.fetch });
			const started = await runner.start(profile, context.workspace, context.signal);
			if (!started.ok) {
				log("warn", "app_start_failed", { taskId: context.taskId, reason: scrub(started.reason).slice(0, 500) });
				return { blocked: { reason: `the application did not start: ${scrub(started.reason).slice(0, 1500)}` } };
			}
			current.startedAtMs = started.startedAtMs;
			current.backendRevision = started.backendRevision;
			log("info", "app_started", { taskId: context.taskId, health: profile.health.length, backendRevision: started.backendRevision });

			current.daemon = await BrowserDaemon.start({ backend: await options.browser(options.allowHosts), dir: evidence, allowHosts: options.allowHosts });
			const wrapper = wrapperFor(options.root, context.taskId);
			writeFileSync(wrapper, `#!/bin/bash\nexec node "${options.cliPath.replaceAll("\\", "/")}" --state "${evidence}/browser.json" "$@"\n`, { mode: 0o755 });
			chmodSync(wrapper, 0o755);
			return undefined;
		},

		wrapRuntime(inner) {
			guarded = new QaRuntime(inner, log);
			return guarded;
		},

		async beforeFinalize() {
			// the video is only a file once the page is closed
			await active?.daemon?.stop();
			return undefined;
		},

		async result(base, context): Promise<ResultPatch> {
			const job = options.session.job;
			const jira = { commented: job?.jira.commented ?? false, labelled: job?.jira.labelled ?? false, transitioned: job?.jira.transitioned ?? false, attached: job?.jira.attachedVideo ?? false };
			const usage = (base as { usage?: unknown }).usage;
			const ticket = String(context.input?.ticket ?? "").trim();

			if (context.blocked) {
				const skipped = (context.blocked.details as { skipped?: boolean } | undefined)?.skipped === true;
				return { result: skipped
					? { verdict: "skipped", ticket, jira: { ...jira, skippedReason: context.blocked.reason }, notes: context.blocked.reason, ...(usage ? { usage } : {}) }
					: { verdict: "blocked", ticket, revision: { frontendSha: context.baseSha, ...(active?.backendRevision ? { backendRevision: active.backendRevision } : {}) }, jira, notes: context.blocked.reason, ...(usage ? { usage } : {}) } };
			}

			const reported = guarded?.take(`somework:${context.taskId}`);
			if (!reported) return { failure: { code: "job_error", message: "the run finished without a report", retryable: true } };
			if (!reported.ok) return invalidReport(context, reported.reason, reported.raw, options.client, scrub, log);

			const dir = evidenceDirFor(options.root, context.taskId);
			const evidence = await collectEvidence(dir, context.taskId, options.client, log);
			const hasVideo = evidence.some((item) => item.kind === "video");
			let { verdict, notes } = { verdict: reported.report.verdict, notes: reported.report.notes };
			if (verdict === "verified" && !hasVideo) {
				verdict = "blocked";
				notes = `${notes}${notes ? "\n" : ""}Not verified: no playable video of the verified behaviour was recorded, and a verification needs one.`.slice(0, 6000);
			}
			const report: QaReport = { ...reported.report, verdict, notes };
			return {
				result: {
					verdict: report.verdict,
					ticket,
					revision: { frontendSha: context.baseSha, ...(active?.backendRevision ?? report.backendRevision ? { backendRevision: active?.backendRevision ?? report.backendRevision } : {}) },
					acceptanceChecks: report.acceptanceChecks,
					fixtures: report.fixtures,
					evidence: evidence.map(({ artifactId, kind, filename }) => ({ artifactId, kind, filename })),
					jira,
					notes: scrub(report.notes),
					...(reported.truncated ? { truncated: true } : {}),
					...(usage ? { usage } : {}),
				},
				artifacts: evidence.map((item) => item.artifact),
			};
		},

		async afterRun() {
			await stopEverything();
		},

		onSettled(taskId) {
			guarded?.take(`somework:${taskId}`);
		},
	};
}

interface CollectedEvidence extends Evidence {
	artifact: unknown;
}

/** Uploads the finished videos and the screenshots of a verification, within size and count limits. */
async function collectEvidence(dir: string, taskId: string, client: QaHooksOptions["client"], log: Log): Promise<CollectedEvidence[]> {
	const out: CollectedEvidence[] = [];
	const take = async (sub: string, extension: string, kind: EvidenceKind, mediaType: string, max: number, limit: number): Promise<void> => {
		let names: string[] = [];
		try {
			names = readdirSync(join(dir, sub)).filter((name) => name.endsWith(extension)).sort();
		} catch {
			return;
		}
		for (const name of names.slice(0, max)) {
			const path = join(dir, sub, name);
			const size = statSync(path).size;
			if (size === 0 || size > limit) {
				log("warn", "evidence_skipped", { taskId, file: `${sub}/${name}`, size });
				continue;
			}
			const filename = `${taskId}-${name}`;
			const artifact = (await client.uploadArtifact({ filename, mediaType, bytes: readFileSync(path), sourceTaskId: taskId })) as { artifactId?: string };
			out.push({ artifactId: String(artifact.artifactId ?? ""), kind, filename, artifact });
		}
	};
	await take("videos", ".webm", "video", "video/webm", MAX_VIDEOS, MAX_VIDEO_BYTES);
	await take("screenshots", ".png", "screenshot", "image/png", MAX_SCREENSHOTS, MAX_SCREENSHOT_BYTES);
	return out;
}

/** A failed outcome cannot carry artifacts, so the raw answer is uploaded and referenced from the failure's details. */
async function invalidReport(context: ResultContext, reason: string, raw: string, client: QaHooksOptions["client"], scrub: (text: string) => string, log: Log): Promise<ResultPatch> {
	const artifact = (await client.uploadArtifact({ filename: `${context.taskId}-raw-answer.txt`, mediaType: "text/plain", bytes: scrub(raw).slice(0, MAX_RAW_ARTIFACT), sourceTaskId: context.taskId })) as { artifactId?: string; uri?: string };
	log("warn", "invalid_qa_report", { taskId: context.taskId, reason });
	return { failure: { code: "invalid_qa_report", message: `the verification could not be turned into a result: ${reason}`, retryable: false, details: { rawAnswer: { artifactId: artifact.artifactId, uri: artifact.uri } } } };
}
