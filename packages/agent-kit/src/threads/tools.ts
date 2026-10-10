import { createHash } from "node:crypto";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { JobEntry, JobManager, JobSpec, Party } from "./jobs.ts";
import type { Sender } from "./message.ts";
import type { ResourceRegistry } from "./resources.ts";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const failure = (value: string) => ({ isError: true as const, content: [{ type: "text" as const, text: value }] });

/** What a job needs to start, as a role works it out from the arguments of a tool call. */
export interface JobPlan {
	capability: { id: string; version: string };
	input: Record<string, unknown>;
	/** A few words for status lines and events: "verify SAD-123". */
	label: string;
	/** Singleton resources the job must hold while it runs. */
	resources?: string[];
}

/** A capability of the role as a tool: the call starts the job at once and returns; the result is posted to the conversation when it ends. */
export interface JobTool {
	name: string;
	description: string;
	parameters: TSchema;
	/** The job the arguments ask for, or why not (the model is told, and may correct itself). */
	plan(args: any): JobPlan | { refuse: string } | Promise<JobPlan | { refuse: string }>;
}

/** What a tool knows about the run it was called in. */
export interface RunContext {
	conversationId?: string;
	messageId: string;
	sender: Party;
	/** Everyone a reply goes to. */
	audience: Party[];
}

export interface ThreadToolHost {
	context(conversationId: number): RunContext | undefined;
	/** Writes an attachment of the domain into the scratch directory of the conversation; returns where it is. */
	saveAttachment(context: RunContext, request: { artifactId: string; version?: number; name?: string }): Promise<{ path: string; bytes: number }>;
	jobs(): JobManager;
	resources(): ResourceRegistry;
	sender(): Sender;
}

export const THREAD_TOOLS = { jobStatus: "job_status", jobStop: "job_stop", resources: "resources", send: "message_send", attachment: "attachment_get" } as const;

/** The scratch directory of a conversation: its id, or the message when there is none, made safe for a path. */
export const threadKey = (context: { conversationId?: string; messageId: string }): string => (context.conversationId ?? context.messageId).replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60);

const ago = (from: number | undefined, now: number): string => {
	const seconds = Math.max(0, Math.round((now - (from ?? now)) / 1000));
	return seconds < 90 ? `${seconds}s` : seconds < 5400 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} h`;
};

/** A job as one line for the model and the state summary. */
export function describeJob(entry: JobEntry, now: number = Date.now()): string {
	const base = `${entry.id} (${entry.label}, asked by ${entry.requestedBy.id})`;
	if (entry.state === "waiting") return `${base}: waiting${entry.waitingFor ? ` for ${entry.waitingFor}` : " for a free slot"} since ${ago(entry.createdAt, now)}`;
	if (entry.state === "running") return `${base}: running for ${ago(entry.startedAt, now)}`;
	return `${base}: ${entry.end?.kind ?? "finished"} ${ago(entry.finishedAt, now)} ago${entry.end?.summary ? ` - ${entry.end.summary}` : ""}`;
}

export const jobId = (messageId: string, plan: JobPlan): string => `job-${createHash("sha256").update(`${messageId}\u0000${plan.capability.id}\u0000${JSON.stringify(plan.input)}`).digest("hex").slice(0, 12)}`;

/** People before agents when jobs wait for the same resource. */
export const priorityOf = (sender: Party): number => (sender.kind === "human" ? 0 : 1);

/** The tools of the thread layer: starting the role's jobs, asking about and stopping them, seeing who holds what, and writing to others. */
export function createThreadTools(host: ThreadToolHost, jobTools: readonly JobTool[]): { extension: Extension<any>; toolNames: string[] } {
	const contextOf = (api: { conversationId: unknown }): RunContext | undefined => host.context(api.conversationId as unknown as number);

	const starters = jobTools.map((tool) =>
		defineTool({
			name: tool.name,
			description: `${tool.description} This starts a job that runs in the background: the call returns at once, the work goes on while you keep talking, and its result is posted to the conversation by itself. Do not wait for it: say what you started. If it needs something only one job can have at a time, it waits for it and says so.`,
			parameters: tool.parameters,
			// the job id comes from the message and the arguments, so a replayed call finds the job it already started
			replay: "safe",
			execute: async (args: unknown, api: any) => {
				const context = contextOf(api);
				if (!context) return failure("not started: this call is not part of a conversation");
				const plan = await tool.plan(args);
				if ("refuse" in plan) return failure(`not started: ${plan.refuse}`);
				const spec: JobSpec = {
					capability: plan.capability,
					input: plan.input,
					label: plan.label,
					requestedBy: context.sender,
					...(context.conversationId ? { conversationId: context.conversationId } : {}),
					replyTo: context.messageId,
					audience: context.audience,
					...(plan.resources && plan.resources.length > 0 ? { resources: plan.resources } : {}),
					priority: priorityOf(context.sender),
					source: "message",
				};
				const entry = host.jobs().start(spec, jobId(context.messageId, plan));
				return text(`Started ${describeJob(entry)}.`);
			},
		}),
	);

	const status = defineTool({
		name: THREAD_TOOLS.jobStatus,
		description: "The jobs of this agent: the ones running or waiting now, and the ones that finished lately, each with its id, who asked, and what it waits for or how it ended. Give a job id for one job. Read only.",
		parameters: Type.Object({ job: Type.Optional(Type.String({ description: "a job id" })) }),
		replay: "safe",
		execute: async (args: { job?: string }) => {
			const jobs = host.jobs();
			if (args.job) {
				const entry = jobs.get(args.job);
				return entry ? text(describeJob(entry)) : failure(`no job ${args.job.slice(0, 40)}`);
			}
			const active = jobs.active().map((entry) => describeJob(entry));
			const recent = jobs.recent(8).map((entry) => describeJob(entry));
			return text([`Active (${active.length}):`, ...(active.length > 0 ? active : ["(none)"]), "", "Finished lately:", ...(recent.length > 0 ? recent : ["(none)"])].join("\n"));
		},
	});

	const stop = defineTool({
		name: THREAD_TOOLS.jobStop,
		description: "Tell a job that it was asked to stop. This is a signal only: a job that has not started simply does not start; a running job's own model gets the request and decides what to do (finish a step, wrap up, carry on). Use it when someone asks you to stop or cancel work.",
		parameters: Type.Object({ job: Type.String(), reason: Type.Optional(Type.String({ maxLength: 300 })) }),
		replay: "safe",
		execute: async (args: { job: string; reason?: string }, api: any) => {
			const context = contextOf(api);
			const result = await host.jobs().stop(args.job, context?.sender ?? { kind: "agent", id: "unknown" }, args.reason);
			if (result === "unknown") return failure(`no job ${args.job.slice(0, 40)}`);
			return text(
				result === "cancelled" ? "The job had not started: it will not run." : result === "told" ? "The job's model was told. It decides what to do; its result message will say how it ended." : "That job had already finished.",
			);
		},
	});

	const resources = defineTool({
		name: THREAD_TOOLS.resources,
		description: "Who holds the singleton resources of this agent (things only one job can use at a time, like the application stack) and which jobs wait for them. Read only. Use it before touching such a resource by hand: if a job holds it, do not.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async () => {
			const registry = host.resources();
			const now = Date.now();
			const held = registry.holders().map((hold) => `${hold.resource}: held by ${hold.label} (${hold.holder}) for ${ago(hold.since, now)}`);
			const waiting = registry.waiting().map((wait) => `${wait.holder} waits for ${wait.resources.join(", ")}`);
			return text([...(held.length > 0 ? held : ["No resource is held."]), ...(waiting.length > 0 ? ["", "Waiting:", ...waiting] : [])].join("\n"));
		},
	});

	const send = defineTool({
		name: THREAD_TOOLS.send,
		description: "Write a message to another principal (an agent or a person), for example to ask another agent for something. The answer comes later as a message to you, in its own turn: do not wait for it. Names and kinds are as they appear in the conversation. With several recipients give the conversationId of a conversation they all are in. Your final answer already goes to the people you are talking to: use this only for someone else.",
		parameters: Type.Object({
			to: Type.Array(Type.Object({ kind: Type.String({ description: "agent, human or service" }), id: Type.String() }), { minItems: 1, maxItems: 8 }),
			text: Type.String({ maxLength: 4000 }),
			conversationId: Type.Optional(Type.String()),
		}),
		replay: "safe",
		execute: async (args: { to: Party[]; text: string; conversationId?: string }, api: any) => {
			const context = contextOf(api);
			if (args.to.length > 1 && !args.conversationId) return failure("not sent: several recipients need a conversationId");
			const key = `send:${context?.messageId ?? "none"}:${createHash("sha256").update(JSON.stringify([args.to, args.conversationId, args.text])).digest("hex").slice(0, 16)}`;
			try {
				await host.sender().send({ recipients: args.to, ...(args.conversationId ? { conversationId: args.conversationId } : {}), ...(context ? { causationId: context.messageId } : {}), text: args.text, key });
			} catch (error) {
				return failure(`not sent: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
			}
			return text(`Sent to ${args.to.map((party) => party.id).join(", ")}. An answer, if there is one, arrives as a message of its own.`);
		},
	});

	const attachment = defineTool({
		name: THREAD_TOOLS.attachment,
		description: "Save an attachment of a message (it is named in the message, with its artifact id) into your scratch directory and say where it is, so you can read it with the other tools. Any attachment of this domain can be fetched.",
		parameters: Type.Object({ artifactId: Type.String(), version: Type.Optional(Type.Integer({ minimum: 1 })), name: Type.Optional(Type.String({ maxLength: 100, description: "the file name to save it under" })) }),
		replay: "safe",
		execute: async (args: { artifactId: string; version?: number; name?: string }, api: any) => {
			const context = contextOf(api);
			if (!context) return failure("not saved: this call is not part of a conversation");
			try {
				const saved = await host.saveAttachment(context, args);
				return text(`Saved ${saved.bytes} bytes to ${saved.path}.`);
			} catch (error) {
				return failure(`not saved: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
			}
		},
	});

	const all = [...starters, status, stop, resources, send, attachment];
	return { extension: defineExtension({ name: "threads", tools: all }), toolNames: all.map((tool) => tool.name) };
}
