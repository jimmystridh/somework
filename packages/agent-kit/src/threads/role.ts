import type { Extension } from "@earendil-works/pi-durable";
import type { JobTool } from "./tools.ts";

/** What a role supplies for its conversations. Everything in it is the role's own, trusted code; every member is optional. */
export interface ThreadRoleHooks {
	/** The role's standing orders for conversations: what the agent is, what it can do, how to talk about it. The kit adds its own rules after them. */
	instructions?: string;
	/** Facts the agent may state, built by the service from its own records (never by the model); added to the kit's own state summary. */
	context?(): Promise<string> | string;
	/** The role's own tools for conversations (read-only ones, for example), as an extension and the names it registers. */
	extension?: Extension<any>;
	toolNames?: readonly string[];
	/** A repository whose default branch is checked out for conversations to read (refreshed from the mirror before each run). */
	checkout?(): { repoUrl: string; ref?: string } | undefined;
	/** The role's capabilities as tools: a call starts the job at once, in the background (see `JobTool`). */
	jobTools?: JobTool[];
	/** Words for a finished job's result (default: the outcome, the summary, the pull request and the branch). */
	describeResult?(result: unknown): string | undefined;
}
