import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Handler } from "@somework/sdk";
import { ChatArtifacts } from "./chat-artifacts.ts";
import { ChatApprovals, DEFAULT_CHAT_MODEL, ModelChatResponder, type ChatRoleHooks } from "./chat-model.ts";
import { JobGate } from "./gate.ts";
import type { GitHost } from "./githost.ts";
import { DailyLedger } from "./ledger.ts";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
export const sh = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env });

/** A bare repository with one commit on `main`: the "remote" the agent clones and pushes to. */
export function makeRemote(): { dir: string; remote: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-remote-"));
	const remote = join(dir, "remote.git");
	sh(dir, "init", "--bare", "-b", "main", remote);
	const seed = join(dir, "seed");
	sh(dir, "clone", remote, seed);
	writeFileSync(join(seed, "README.md"), "hello\n");
	sh(seed, "add", "-A");
	sh(seed, "commit", "-m", "seed");
	sh(seed, "push", "origin", "HEAD:main");
	return { dir, remote };
}

export class FakeHost implements GitHost {
	created: { head: string; base: string; title: string }[] = [];
	async findPullRequest(query: { head: string }) {
		return this.created.some((pr) => pr.head === query.head) ? { url: `https://example.test/pr/${query.head}` } : undefined;
	}
	async createPullRequest(request: { head: string; base: string; title: string }) {
		this.created.push({ head: request.head, base: request.base, title: request.title });
		return { url: `https://example.test/pr/${request.head}` };
	}
}

/**
 * A domain that, like the real one, has no task for a chat instruction: every call bound to a `chat-...` task is a 404 `not_found`, and every
 * other call is answered. `calls` lists what it was asked, `uploaded` what it stored. For role tests of the chat instruction path.
 */
export class DomainWithoutChatTasks {
	calls: string[] = [];
	uploaded: string[] = [];
	async uploadArtifact(options: { filename: string; sourceTaskId?: string }): Promise<any> {
		this.calls.push(`upload ${options.filename} for ${options.sourceTaskId}`);
		if (options.sourceTaskId?.startsWith("chat-")) throw Object.assign(new Error("404 not_found: task not found"), { status: 404, code: "not_found" });
		this.uploaded.push(options.filename);
		return { artifactId: `art_${this.uploaded.length}`, uri: `s3://test/${options.filename}` };
	}
	async post(path: string, _body?: unknown): Promise<any> {
		this.calls.push(`POST ${path}`);
		if (/\/tasks\/chat-/.test(path)) throw Object.assign(new Error("404 not_found: task not found"), { status: 404, code: "not_found" });
		return {};
	}
	async get(path: string): Promise<any> {
		this.calls.push(`GET ${path}`);
		if (/\/tasks\/chat-/.test(path)) throw Object.assign(new Error("404 not_found: task not found"), { status: 404, code: "not_found" });
		return {};
	}
}

/**
 * Gives a role's handler a chat instruction the way the service does: the responder, the shared gate, the artifacts kept on the host, and a
 * message client that records the replies. `client` is what to give the role (it is wrapped for chat jobs); `instruct(text)` sends
 * `instruct: <text>` from the manager and returns the reply text.
 */
export function chatInstructionRig(options: { stateDir: string; domain?: DomainWithoutChatTasks; budget?: { maxTokens: number; maxMinutes: number } }) {
	const domain = options.domain ?? new DomainWithoutChatTasks();
	const artifacts = new ChatArtifacts({ dir: join(options.stateDir, "chat-artifacts") });
	const posts: any[] = [];
	const messages = { async get() { return {}; }, async post(_path: string, body: any) { posts.push(body); return {}; } };
	const ledger = new DailyLedger(join(options.stateDir, "chat-ledger.json"), 10_000_000, undefined, undefined, { share: 0.5 });
	let n = 0;
	return {
		domain,
		artifacts,
		posts,
		/** The client for the role's handler and hooks. */
		client: artifacts.wrap(domain) as any,
		ledger,
		responderFor(handler: Handler, input: NonNullable<ChatRoleHooks["instructInput"]>, describe?: ChatRoleHooks["describeResult"]): { instruct(text: string): Promise<string> } {
			const responder = new ModelChatResponder({
				client: messages as any,
				agentId: "agent/me",
				role: "test",
				settings: { ...DEFAULT_CHAT_MODEL, busyAfterSeconds: 600, senderWindowMs: 1, ...(options.budget ? { instructBudget: options.budget } : {}) },
				ledger,
				ask: { runtime: { execute: async () => ({ status: "done", answer: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 } }) } as any, tools: ["read"], instructions: "", state: async () => "", fallbackWorkspace: options.stateDir },
				instruct: { handler, input, ...(describe ? { describe } : {}), gate: new JobGate(1), approvals: new ChatApprovals({ client: messages as any, log: () => undefined, timeoutMinutes: 1 }), artifacts },
				log: () => undefined,
			});
			return {
				async instruct(text: string): Promise<string> {
					n += 1;
					await responder.handle({ messageId: `m${n}`, type: "chat.message", sender: { kind: "agent", id: "agent/manager" }, conversationId: "c1", createdAt: new Date().toISOString(), text: `instruct: ${text}` });
					return String(posts.at(-1)?.content?.data ?? "");
				},
			};
		},
	};
}
