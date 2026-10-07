import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { TimersError, type TimersClient } from "./client.ts";

export const TIMER_TOOL_NAMES = ["schedule_followup", "list_followups", "cancel_followup"] as const;

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const failure = (value: string) => ({ isError: true as const, content: [{ type: "text" as const, text: value }] });

const guarded = async (work: () => Promise<string>) => {
	try {
		return text(await work());
	} catch (error) {
		return failure(error instanceof TimersError ? error.message : "the timer service failed");
	}
};

/** The same note asked for twice is one timer, so a tool call that is run again after a restart does not wake the agent twice. */
export const defaultTimerKey = (note: string, seconds: number): string => `ask:${createHash("sha256").update(`${seconds}\n${note}`).digest("hex").slice(0, 16)}`;

/** The model's way to say "wake me with this later". The wake arrives as an event through the agent's own rule and handler; nothing runs in between. */
export function createTimerTools(client: TimersClient): { extension: Extension<any>; toolNames: string[] } {
	const tools = [
		defineTool({
			name: "schedule_followup",
			description:
				"Ask the event hub to wake you again after some minutes with a note you write now, for example to look at a pull request again once reviewers had time to comment. The note is all you will have when the time comes, so make it self-contained (what to look at, where, what to do). Asking again with the same key moves the timer instead of adding one. At least 1 minute and at most 7 days away.",
			parameters: Type.Object({
				minutes: Type.Number({ minimum: 1, maximum: 10080, description: "how many minutes from now" }),
				note: Type.String({ maxLength: 500, description: "what to do when woken, self-contained" }),
				key: Type.Optional(Type.String({ maxLength: 100, description: "a name for this timer, for example pr-followup:42; lets you move or cancel it" })),
			}),
			async execute(args: { minutes: number; note: string; key?: string }) {
				return guarded(async () => {
					const seconds = Math.round(args.minutes * 60);
					const timer = await client.request({ delaySeconds: seconds, note: args.note, key: args.key ?? defaultTimerKey(args.note, seconds) });
					return `scheduled ${timer.key} for ${timer.dueAt}`;
				});
			},
		}),
		defineTool({
			name: "list_followups",
			description: "Your pending timers: key, when they are due and the note.",
			parameters: Type.Object({}),
			replay: "safe",
			async execute() {
				return guarded(async () => {
					const timers = await client.list();
					return timers.length === 0 ? "no timers are pending" : timers.map((t) => `${t.key} due ${t.dueAt}: ${t.note}`).join("\n");
				});
			},
		}),
		defineTool({
			name: "cancel_followup",
			description: "Cancel one of your pending timers by its key (or id).",
			parameters: Type.Object({ key: Type.String({ maxLength: 100 }) }),
			async execute(args: { key: string }) {
				return guarded(async () => ((await client.cancel(args.key)) ? `cancelled ${args.key}` : `no pending timer ${args.key}`));
			},
		}),
	];
	return { extension: defineExtension({ name: "timers", tools }), toolNames: tools.map((tool) => tool.name) };
}
