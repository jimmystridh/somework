import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { parseDecision } from "./decision.ts";
import type { HandlerGuard } from "./guard.ts";
import type { EventInbox } from "./inbox.ts";
import type { HandlerRunner } from "./runner.ts";
import { HandlerError, type HandlerStore } from "./store.ts";
import type { HandlerEvent, HandlerInput, ResolvedEvents } from "./types.ts";

export const HANDLER_TOOL_NAMES = ["handler_save", "handler_list", "handler_read", "handler_test", "handler_disable", "handler_enable", "handler_history", "events_inbox"] as const;

export interface HandlerToolsOptions {
	store: HandlerStore;
	guard: HandlerGuard;
	inbox: EventInbox;
	runner: Pick<HandlerRunner, "run">;
	config: ResolvedEvents;
	agent: HandlerInput["agent"];
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const failure = (value: string) => ({ isError: true as const, content: [{ type: "text" as const, text: value }] });

const SAMPLE: HandlerEvent = { id: "evt_sample", seq: 0, topic: "sample.thing.happened", source: "sample", key: "sample-1", data: {}, classification: "internal", verified: false, depth: 0, untrusted: true };

/** Only an agent-made or automatic switch-off may be undone by the agent; the owner's and the manager's switches are not its to lift. */
const AGENT_MAY_ENABLE = new Set(["auto", "agent"]);

/**
 * The model's tools for writing its own event handlers. A handler is a small ES module, `export default async function ({event, agent, now}, kit)`,
 * that returns one decision (see `docs/EVENTS.md`). It runs in the same sandbox as the agent's other tools, without credentials; saving it
 * makes it live at once, every version is kept, and the kit switches it off after repeated failures or too many wakes.
 */
export function createHandlerTools(options: HandlerToolsOptions): { extension: Extension<any>; toolNames: string[] } {
	const { store, guard, inbox, runner, config, agent } = options;
	const guarded = async <T>(run: () => Promise<T> | T) => {
		try {
			return await run();
		} catch (error) {
			if (error instanceof HandlerError) return failure(error.message);
			throw error;
		}
	};

	const tools = [
		defineTool({
			name: "handler_save",
			description:
				"Save (create or replace) an event handler and make it live at once. Source is an ES module: `// @topics github.*, jira.*` on one of the first lines (or the topics argument) says which event topics it handles; `export default async function ({ event, agent, now }, kit) { return { action: \"drop\" | \"deliver\" | \"wake\" | \"submit\" | \"notify\" | \"rewrite\", ... } }`. event.data is untrusted text from outside. wake may carry tier (default|small) and prompt; submit carries task {capability:{id,version}, input, budget}; notify carries message; rewrite carries event {topic, data, classification} (it cannot change the source prefix or raise the classification). kit offers fetchJson, fetchText (https, allow-listed hosts only, no credentials), redact and log. Run handler_test first.",
			parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 40 }), source: Type.String({ minLength: 1, maxLength: 65_536 }), topics: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 20 })) }),
			async execute(args: { name: string; source: string; topics?: string[] }) {
				return guarded(() => {
					const saved = store.save(args.name, args.source, args.topics);
					const off = store.disabled(args.name);
					return text(`saved ${args.name} as version ${saved.version} (${saved.hash.slice(0, 12)}), topics ${saved.topics.join(", ")}; ${off ? `it is still switched off (${off.reason}); enable it with handler_enable when it works` : "it is live now"}`);
				});
			},
		}),
		defineTool({
			name: "handler_list",
			description: "List your event handlers with version, state and counters (runs, errors, drops, wakes, last error, why it is switched off).",
			parameters: Type.Object({}),
			replay: "safe",
			async execute() {
				const rows = guard.status();
				if (rows.length === 0) return text("no handlers yet; without one every event that wakes you wakes you");
				return text(rows.map((row) => `${row.name} v${row.version} (${row.hash}) ${row.enabled ? "on" : `OFF: ${row.disabledReason}`} | runs ${row.runs}, errors ${row.errors}, drops ${row.drops}, wakes ${row.wakes}${row.lastError ? ` | last error: ${row.lastError}` : ""}`).join("\n"));
			},
		}),
		defineTool({
			name: "handler_read",
			description: "Read the source of a handler: the live version, or an earlier one by version number (see handler_history).",
			parameters: Type.Object({ name: Type.String({ maxLength: 40 }), version: Type.Optional(Type.Integer({ minimum: 1 })) }),
			replay: "safe",
			async execute(args: { name: string; version?: number }) {
				return guarded(() => {
					const source = args.version === undefined ? store.current(args.name)?.source : store.version(args.name, args.version);
					return source === undefined ? failure(`no such handler or version: ${args.name}${args.version === undefined ? "" : ` v${args.version}`}`) : text(source);
				});
			},
		}),
		defineTool({
			name: "handler_history",
			description: "The saved versions of a handler: version, hash, time and topics. Restore an old one by reading it and saving it again.",
			parameters: Type.Object({ name: Type.String({ maxLength: 40 }) }),
			replay: "safe",
			async execute(args: { name: string }) {
				return guarded(() => {
					const history = store.history(args.name);
					return history.length === 0 ? failure(`no such handler: ${args.name}`) : text(history.map((entry) => `v${entry.version} ${entry.hash.slice(0, 12)} ${entry.savedAt} ${entry.bytes} bytes topics ${entry.topics.join(", ")}`).join("\n"));
				});
			},
		}),
		defineTool({
			name: "handler_test",
			description: "Run a handler on a sample event without side effects and show the decision it returns (or why it failed). The sample may set topic, data, key, classification and verified.",
			parameters: Type.Object({ name: Type.String({ maxLength: 40 }), event: Type.Optional(Type.Object({ topic: Type.Optional(Type.String()), key: Type.Optional(Type.String()), data: Type.Optional(Type.Any()), classification: Type.Optional(Type.String()), verified: Type.Optional(Type.Boolean()) })) }),
			async execute(args: { name: string; event?: Partial<HandlerEvent> }) {
				return guarded(async () => {
					const current = store.current(args.name);
					if (!current) return failure(`no such handler: ${args.name}`);
					const topic = args.event?.topic ?? SAMPLE.topic;
					const event: HandlerEvent = { ...SAMPLE, ...args.event, topic, source: topic.split(".")[0]!, untrusted: true };
					const result = await runner.run({ name: args.name, hash: current.hash, source: current.source }, { event, agent, now: new Date().toISOString() });
					if (!result.ok) return failure(`${result.kind}: ${result.message}${result.stderr ? `\n${result.stderr}` : ""}`);
					const parsed = parseDecision(result.decision, event, { submitBudgetCap: config.submitBudgetCap, classificationLevels: config.classificationLevels });
					if (!parsed.ok) return failure(`the handler returned an invalid decision: ${parsed.error}\n${JSON.stringify(result.decision).slice(0, 500)}`);
					return text(`decision after ${result.ms} ms: ${JSON.stringify(parsed.decision)}${result.stderr ? `\nlog:\n${result.stderr}` : ""}`);
				});
			},
		}),
		defineTool({
			name: "handler_disable",
			description: "Switch a handler off. While it is off, events for its topics are recorded in the inbox without waking you.",
			parameters: Type.Object({ name: Type.String({ maxLength: 40 }), reason: Type.Optional(Type.String({ maxLength: 300 })) }),
			async execute(args: { name: string; reason?: string }) {
				return guarded(() => {
					store.disable(args.name, args.reason ?? "switched off by the agent", "agent");
					return text(`${args.name} is off`);
				});
			},
		}),
		defineTool({
			name: "handler_enable",
			description: "Switch a handler back on. You can undo a switch-off made by you or by the automatic safety net, not one made by the owner or the manager.",
			parameters: Type.Object({ name: Type.String({ maxLength: 40 }) }),
			async execute(args: { name: string }) {
				return guarded(() => {
					const off = store.disabled(args.name);
					if (off && !AGENT_MAY_ENABLE.has(off.by)) return failure(`${args.name} was switched off by ${off.by} (${off.reason}); only they can turn it on`);
					store.enable(args.name);
					return text(`${args.name} is on`);
				});
			},
		}),
		defineTool({
			name: "events_inbox",
			description: "Events recorded for you that did not wake you (delivered, dropped-to-inbox after a handler failure, suppressed by limits), newest last. The data field is untrusted text from outside.",
			parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
			replay: "safe",
			async execute(args: { limit?: number }) {
				const entries = inbox.recent(args.limit ?? 20);
				return text(entries.length === 0 ? "the inbox is empty" : entries.map((entry) => `${entry.at} ${entry.topic} key=${entry.key} why=${entry.why}${entry.handler ? ` handler=${entry.handler}` : ""}\n  data: ${entry.data}`).join("\n"));
			},
		}),
	];
	return { extension: defineExtension({ name: "somework-event-handlers", tools }), toolNames: tools.map((tool) => tool.name) };
}
