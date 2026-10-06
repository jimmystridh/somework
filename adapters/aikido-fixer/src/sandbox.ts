import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { redactText } from "@somework/agent-kit";

export interface SandboxResult {
	code: number;
	output: string;
	timedOut: boolean;
}

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const TAIL = 4000;

/**
 * Runs one command of the role's own in the sandbox (never one the model chose), with the output cut to its last `limit` characters
 * (default 4000, enough for a log tail; ask for more when the whole output must be read, as for a diff that is scanned).
 */
export async function run(env: ExecutionEnv, command: string, cwd: string, timeoutSeconds: number, limit: number = TAIL): Promise<SandboxResult> {
	let output = "";
	const result = await env.exec(command, { cwd, timeout: timeoutSeconds, onOutput: (text) => (output = (output + text).slice(-limit)) }, BACKGROUND_CONTEXT);
	if (!result.ok) return { code: -1, output: redactText(`${output}\n${result.error.message}`).slice(-limit), timedOut: result.error.code === "timeout" };
	return { code: result.value.exitCode, output: limit > TAIL ? output : redactText(output).slice(-limit), timedOut: false };
}

export const git = (env: ExecutionEnv, cwd: string, ...args: string[]): Promise<SandboxResult> => run(env, `git ${args.map(quote).join(" ")}`, cwd, 120);
