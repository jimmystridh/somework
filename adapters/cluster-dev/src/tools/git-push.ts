import { posix } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { CREDENTIAL_HELPER_SCRIPT, silent, type Log } from "@somework/agent-kit";
import { scrub, toolFailure, toolText } from "../scrub.ts";
import type { ClusterSettings } from "../settings.ts";

export const GIT_PUSH_TOOL = "git_push";

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

export interface GitPushOptions {
	settings: Pick<ClusterSettings, "repositoryUrl" | "gitRemote"> & Partial<Pick<ClusterSettings, "extraRepositories">>;
	/** The credential for the organisation repository; it goes to the one git command that pushes, and nowhere else. */
	token?: () => Promise<string>;
	/** The credential of each other repository, by its name. */
	extraTokens?: Readonly<Record<string, () => Promise<string>>>;
	secrets?: () => string[];
	log?: Log;
}

const failed = (reason: string) => toolFailure(`refused: ${reason}`);

/**
 * `git_push`: pushes a branch of a checkout in the workspace to the organisation repository, or to one of the other repositories the deployment
 * names (`repository`, each with a credential of its own). The sandbox where the model's commands run
 * holds no credential, so this tool does the push from the service: the repository address comes from the settings (never from the model, so
 * never `origin` or a public remote), the refspec is always `<branch>:refs/heads/<to>` with no `+`, no deletion and no tags, hooks are
 * switched off, and the token is handed to the git credential helper for this one command only. Pushing is the agent's own call; what a push
 * to a branch the CI deploys from starts is for the CI and `deploy_status` to show.
 */
export function createGitPush(options: GitPushOptions) {
	const log = options.log ?? silent;
	const secrets = () => options.secrets?.() ?? [];
	const extras = options.settings.extraRepositories ?? [];
	return defineTool({
		name: GIT_PUSH_TOOL,
		description: `Push a branch of a git checkout in your workspace to the organisation repository (${options.settings.gitRemote})${extras.length > 0 ? ` or, with \`repository\`, to ${extras.map((repository) => `${repository.name} (${repository.url})`).join(", ")}` : ""}: never force, never a deletion, never another repository. \`branch\` is the local branch (default HEAD), \`to\` the branch to update on the remote (default the same name), \`directory\` the checkout inside your workspace (default the working directory). Pushing to the branch the CI deploys from starts a deployment; follow it with ci_pipelines and deploy_status.`,
		parameters: Type.Object({
			repository: Type.Optional(Type.String({ maxLength: 60 })),
			branch: Type.Optional(Type.String({ maxLength: 200 })),
			to: Type.Optional(Type.String({ maxLength: 200 })),
			directory: Type.Optional(Type.String({ maxLength: 300 })),
		}),
		replay: "unsafe",
		async execute(args: { repository?: string; branch?: string; to?: string; directory?: string }, api: any, context: any) {
			const name = args.repository?.trim();
			const extra = name === undefined || name === "" || name === options.settings.gitRemote ? undefined : extras.find((repository) => repository.name === name);
			if (name && name !== options.settings.gitRemote && !extra) return failed(`unknown repository "${name.slice(0, 60)}": ${[options.settings.gitRemote, ...extras.map((repository) => repository.name)].join(", ")}`);
			const url = extra ? extra.url : options.settings.repositoryUrl;
			if (!url) return failed("no repository is configured for this agent (CLUSTER_DEV_REPOSITORY)");
			const credential = extra ? options.extraTokens?.[extra.name] : options.token;
			if (!credential) return failed(extra ? `this agent has no credential for ${extra.name}` : "this agent has no credential to push with (GIT_TOKEN_FILE or a GitHub App)");
			const source = (args.branch ?? "HEAD").trim();
			if (source !== "HEAD" && !BRANCH.test(source)) return failed("branch must be HEAD or a plain branch name");
			const target = (args.to ?? (source === "HEAD" ? "" : source)).trim();
			if (!BRANCH.test(target) || target.includes("..") || target.endsWith("/") || target.endsWith(".lock") || target.startsWith("refs/")) return failed(source === "HEAD" && !args.to ? "name the branch to update on the remote (to)" : "to must be a plain branch name");
			const env = api.env as { cwd: string; exec: (command: string, options: Record<string, unknown>, context: unknown) => Promise<{ ok: boolean; value?: { exitCode: number }; error?: { message: string } }> } | undefined;
			if (!env) return failed("this call has no workspace");
			const directory = (args.directory ?? ".").trim();
			if (directory.startsWith("/") || directory.startsWith("~") || posix.normalize(directory).startsWith("..") || directory.includes("\0")) return failed("directory must be inside your workspace");
			const cwd = posix.join(env.cwd, directory);
			const token = await credential();
			let host: string;
			try {
				host = new URL(url).hostname;
			} catch {
				return failed("the configured repository address is not a URL");
			}
			let output = "";
			const command = ["git", "-c", "core.hooksPath=/dev/null", "-c", `credential.helper=!${CREDENTIAL_HELPER_SCRIPT}`, "push", "--no-verify", "--porcelain", url, `${source}:refs/heads/${target}`].map(quote).join(" ");
			const result = await env.exec(command, { cwd, env: { GIT_TERMINAL_PROMPT: "0", GIT_TOKEN: token, GIT_TOKEN_HOSTS: host }, timeout: 300, onOutput: (text: string) => (output += text) }, context);
			const shown = scrub(output.trim(), [token, ...secrets()]).slice(-1500);
			if (!result.ok) return failed(`git could not run: ${scrub(result.error?.message ?? "error", [token, ...secrets()]).slice(0, 200)}`);
			if (result.value!.exitCode !== 0) {
				log("warn", "git_push_failed", { to: target, exit: result.value!.exitCode });
				return toolFailure(`the push failed (exit ${result.value!.exitCode}):\n${shown}`);
			}
			log("info", "git_push", { to: target, repository: extra?.name ?? options.settings.gitRemote });
			return toolText(`pushed ${source} to ${extra?.name ?? options.settings.gitRemote}/${target}\n${shown}`);
		},
	});
}
