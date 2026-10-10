import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Handler } from "@somework/sdk";
import { JobGate } from "./gate.ts";
import type { GitHost } from "./githost.ts";
import { JobArtifacts } from "./threads/artifacts.ts";
import { JobManager, type JobEntry, type JobSpec } from "./threads/jobs.ts";
import { MessageSender } from "./threads/message.ts";
import { createJobReporter } from "./threads/reporter.ts";
import { ResourceRegistry } from "./threads/resources.ts";
import { DurableTable } from "./threads/store.ts";

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
 * A domain that, like the real one, has no task for a job: every call bound to a `job-...` task is a 404 `not_found`, and every other call is
 * answered. `calls` lists what it was asked, `uploaded` what it stored. For role tests of the job path.
 */
export class DomainWithoutJobTasks {
	calls: string[] = [];
	uploaded: string[] = [];
	async uploadArtifact(options: { filename: string; sourceTaskId?: string }): Promise<any> {
		this.calls.push(`upload ${options.filename} for ${options.sourceTaskId}`);
		if (options.sourceTaskId?.startsWith("job-")) throw Object.assign(new Error("404 not_found: task not found"), { status: 404, code: "not_found" });
		this.uploaded.push(options.filename);
		return { artifactId: `art_${this.uploaded.length}`, uri: `s3://test/${options.filename}`, filename: options.filename };
	}
	async post(path: string, _body?: unknown): Promise<any> {
		this.calls.push(`POST ${path}`);
		if (/\/tasks\/job-/.test(path)) throw Object.assign(new Error("404 not_found: task not found"), { status: 404, code: "not_found" });
		return {};
	}
	async get(path: string): Promise<any> {
		this.calls.push(`GET ${path}`);
		if (/\/tasks\/job-/.test(path)) throw Object.assign(new Error("404 not_found: task not found"), { status: 404, code: "not_found" });
		return {};
	}
}

/**
 * Gives a role's handler a job the way the service does: the job manager, a slot gate, the artifacts uploaded without a source task, and a message client
 * that records what is said. `client` is what to give the role's hooks (it is wrapped for jobs); `run(handler, spec)` starts the job, waits for its end and
 * returns the entry, the text of the result message and the artifacts it carried.
 */
export function jobRig(options: { stateDir: string; domain?: DomainWithoutJobTasks; budget?: { maxTokens: number; maxMinutes: number } }) {
	const domain = options.domain ?? new DomainWithoutJobTasks();
	const artifacts = new JobArtifacts();
	const posts: any[] = [];
	const messages = { async get() { return {}; }, async post(_path: string, body: any) { posts.push(body); return {}; } };
	return {
		domain,
		artifacts,
		posts,
		/** The client for the role's handler and hooks. */
		client: artifacts.wrap(domain) as any,
		async run(handler: Handler, spec: Partial<JobSpec> & Pick<JobSpec, "capability" | "input">, describeResult?: (result: unknown) => string | undefined): Promise<{ entry: JobEntry; text: string; artifacts: unknown[] }> {
			const manager = new JobManager({
				handler,
				resources: new ResourceRegistry(),
				gate: new JobGate(1),
				store: new DurableTable<JobEntry>(join(options.stateDir, `jobs-${posts.length}-${Math.random().toString(36).slice(2, 8)}.json`)),
				reporter: createJobReporter({ sender: new MessageSender(messages as any), agentId: "agent/me", describeResult }),
				takeArtifacts: (jobId) => artifacts.take(jobId),
				steer: async () => false,
				approve: async () => ({ approved: false, reason: "no approver in this rig" }),
				budget: options.budget ?? { maxTokens: 150_000, maxMinutes: 15 },
			});
			const before = posts.length;
			const entry = manager.start({ label: String(spec.capability.id), requestedBy: { kind: "agent", id: "agent/manager" }, conversationId: "c1", replyTo: "m1", source: "message", ...spec });
			await manager.idle();
			const sent = posts.slice(before).filter((post) => post.labels?.jobId === entry.id).at(-1);
			return { entry: manager.get(entry.id)!, text: String(sent?.content?.data ?? ""), artifacts: sent?.artifacts ?? [] };
		},
	};
}
