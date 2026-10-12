import assert from "node:assert/strict";
import { classifyCommand, type Category, type ClassifyContext } from "../src/classifier/index.ts";

/** The agent's own sandbox: its workspace and /tmp are its own, git pushes go to `org`. */
export const LOCAL: ClassifyContext = { workspaces: ["/workspace", "/tmp"], remote: "org" };
/** A machine of the cluster reached with host_exec: nothing there is the agent's workspace. */
export const REMOTE: ClassifyContext = { host: "agents", remote: "org" };

export type Case = [command: string, category?: Category];

/** Every case must be destructive, with a reason and (when given) the category; all mismatches are reported together. */
export function expectDestructive(cases: Case[], context: ClassifyContext): void {
	const wrong: string[] = [];
	for (const [command, category] of cases) {
		const verdict = classifyCommand(command, context);
		if (!verdict.destructive) wrong.push(`should be destructive: ${command}`);
		else if (!verdict.reason) wrong.push(`no reason: ${command}`);
		else if (category && verdict.category !== category) wrong.push(`${command}: category ${verdict.category} (${verdict.reason}), wanted ${category}`);
	}
	assert.deepEqual(wrong, []);
}

/** Every command must be allowed, with no reason. */
export function expectAllowed(commands: string[], context: ClassifyContext): void {
	const wrong: string[] = [];
	for (const command of commands) {
		const verdict = classifyCommand(command, context);
		if (verdict.destructive || verdict.reason !== undefined) wrong.push(`should be allowed: ${command} (${verdict.reason})`);
	}
	assert.deepEqual(wrong, []);
}
