import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadSettings, type ClusterSettings } from "../src/settings.ts";
import type { Spawn, SpawnOptions, SpawnResult } from "../src/tools/host-exec.ts";

export const BOUNDARY = "0123456789abcdef";
export const boundary = () => BOUNDARY;

export const settingsFor = (values: Record<string, string> = {}): ClusterSettings =>
	loadSettings({
		CLUSTER_DEV_REPOSITORY: "https://github.com/acme/somework",
		CLUSTER_DEV_CONFIRM: "1",
		CLUSTER_DEV_HOSTS: "agents=js@10.10.10.20,services=ops@10.10.10.11:2222,pve-host=root@10.10.10.1",
		CLUSTER_DEV_SSH_KEY_DIR: "/keys",
		CLUSTER_DEV_AGENT_URLS: "reviewer=http://10.10.10.20:8082,developer=http://10.10.10.20:8081",
		CI_URL: "https://ci.internal:8443",
		CI_REPO: "acme/somework",
		CI_TOKEN_FILE: "/run/secrets/ci-token",
		...values,
	} as NodeJS.ProcessEnv);

export interface SpawnCall {
	file: string;
	args: string[];
	options: SpawnOptions;
}

/** A spawn that records what it was asked to run and answers from a script (one answer per call; the last repeats). */
export function fakeSpawn(...answers: Partial<SpawnResult>[]): { spawn: Spawn; calls: SpawnCall[] } {
	const calls: SpawnCall[] = [];
	const spawn: Spawn = async (file, args, options) => {
		calls.push({ file, args, options });
		const answer = answers[Math.min(calls.length - 1, answers.length - 1)] ?? {};
		return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false, ...answer };
	};
	return { spawn, calls };
}

/** Calls a tool the way the runtime does: with an api that carries the call id and what the approval gate remembered. */
export async function callTool(tool: any, args: Record<string, unknown>, api: Record<string, unknown> = {}) {
	const result = await tool.execute(args, { callId: "call-1", ...api }, BACKGROUND_CONTEXT);
	return { text: result.content.map((part: any) => part.text).join("\n") as string, isError: result.isError === true };
}

export const approvedApi = { memo: async () => ({ approved: true }) };
export const deniedApi = { memo: async () => ({ approved: false }) };
export const ungatedApi = {};

export function toolNamed(extension: { tools?: readonly any[] }, name: string): any {
	const tool = extension.tools?.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`no tool ${name}`);
	return tool;
}
