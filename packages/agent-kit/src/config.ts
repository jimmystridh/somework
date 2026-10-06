import { readFileSync } from "node:fs";
import { allowlist, parseModelList, type ModelRef } from "./providers/allowlist.ts";
import { parseSkillList } from "./skills.ts";
import { validateTable, type ShardTable } from "./shards.ts";

export interface Config {
	somework: { url: string; keyFile: string; caFile?: string; requireTls: boolean };
	state: { dir: string; authFile: string };
	model: ModelRef;
	/** Models a job may ask for with `input.model`; the default model is always first. */
	allowedModels: ModelRef[];
	sandbox: { url: string; tokenFile: string; workspaceRoot: string; caFile?: string };
	git: {
		tokenFile?: string;
		/** A GitHub App instead of a token file (`GITHUB_APP_ID`, `GITHUB_APP_KEY_FILE`): short-lived installation tokens, actions as `<slug>[bot]`. */
		app?: { appId: string; keyFile: string; installationId?: string; repositories: string[] };
		/** True when `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` were not set: with an app the commit author is then the app's bot account. */
		authorFromApp: boolean;
		tokenHosts: string[];
		authorName: string;
		authorEmail: string;
		githubApi?: string;
		draftPullRequests?: boolean;
		/** Persistent bare mirrors inside the sandbox (`GIT_MIRROR_DIR`); `repositories` are refreshed on a timer, any other repository only when a task uses it. */
		mirror?: { dir: string; repositories: string[]; refreshMinutes: number };
	};
	limits: { maxTokensCap: number; maxMinutesCap: number; dailyTokenLimit: number };
	shards?: ShardTable;
	healthPort: number;
	concurrency: number;
	leaseSeconds: number;
	approvalPatterns: string[];
	/** Deployment override of the role's skills: `SKILLS_ALLOW` replaces `profile.skills.allow` when it is set and not empty. */
	skills: { allow?: string[]; overlayDir?: string };
}

const required = (env: NodeJS.ProcessEnv, name: string): string => {
	const value = env[name];
	if (!value) throw new Error(`missing required setting ${name}`);
	return value;
};
const integer = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => {
	const value = env[name] === undefined ? fallback : Number(env[name]);
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
	return value;
};

const mirrorFrom = (env: NodeJS.ProcessEnv): Config["git"]["mirror"] =>
	env.GIT_MIRROR_DIR ? { dir: env.GIT_MIRROR_DIR, repositories: (env.GIT_MIRROR_REPOS ?? "").split(/[\s,]+/).filter(Boolean), refreshMinutes: integer(env, "GIT_MIRROR_REFRESH_MINUTES", 30) } : undefined;

const appFrom = (env: NodeJS.ProcessEnv): Config["git"]["app"] => {
	if (!env.GITHUB_APP_ID && !env.GITHUB_APP_KEY_FILE) return undefined;
	if (!env.GITHUB_APP_ID || !env.GITHUB_APP_KEY_FILE) throw new Error("GITHUB_APP_ID and GITHUB_APP_KEY_FILE go together");
	if (env.GIT_TOKEN_FILE) throw new Error("use either GIT_TOKEN_FILE or a GitHub App (GITHUB_APP_ID), not both");
	return { appId: env.GITHUB_APP_ID, keyFile: env.GITHUB_APP_KEY_FILE, installationId: env.GITHUB_APP_INSTALLATION_ID || undefined, repositories: (env.GITHUB_APP_REPOSITORIES ?? "").split(/[\s,]+/).filter(Boolean) };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const shardFile = env.SHARD_TABLE_FILE;
	const shards = shardFile ? (JSON.parse(readFileSync(shardFile, "utf8")) as ShardTable) : undefined;
	if (shards) validateTable(shards);
	const model = { provider: env.PI_PROVIDER ?? "openai-codex", modelId: env.PI_MODEL ?? "gpt-5.5" };
	return {
		somework: { url: required(env, "SOMEWORK_URL"), keyFile: required(env, "SOMEWORK_KEY_FILE"), caFile: env.SOMEWORK_CA_FILE, requireTls: env.SOMEWORK_REQUIRE_TLS === "1" },
		state: { dir: env.PI_STATE_DIR ?? "/state", authFile: env.PI_AUTH_FILE ?? "/run/secrets/pi/auth.json" },
		model,
		allowedModels: allowlist(model, parseModelList(env.PI_ALLOWED_MODELS)),
		sandbox: { url: required(env, "SANDBOX_URL"), tokenFile: env.SANDBOX_TOKEN_FILE ?? "/run/secrets/sandbox-token", workspaceRoot: env.SANDBOX_WORKSPACES ?? "/workspace", caFile: env.SANDBOX_CA_FILE },
		git: { tokenFile: env.GIT_TOKEN_FILE, app: appFrom(env), authorFromApp: !env.GIT_AUTHOR_NAME && !env.GIT_AUTHOR_EMAIL, tokenHosts: (env.GIT_TOKEN_HOSTS ?? "github.com").split(/[\s,]+/).filter(Boolean), authorName: env.GIT_AUTHOR_NAME ?? "SomeWork Pi", authorEmail: env.GIT_AUTHOR_EMAIL ?? "pi@somework.invalid", githubApi: env.GITHUB_API || undefined, draftPullRequests: env.GIT_PR_DRAFT === "1", mirror: mirrorFrom(env) },
		limits: { maxTokensCap: integer(env, "BUDGET_MAX_TOKENS_CAP", 2_000_000), maxMinutesCap: integer(env, "BUDGET_MAX_MINUTES_CAP", 60), dailyTokenLimit: integer(env, "DAILY_TOKEN_LIMIT", 10_000_000) },
		shards,
		healthPort: integer(env, "HEALTH_PORT", 8081),
		concurrency: integer(env, "PI_CONCURRENCY", 2),
		leaseSeconds: integer(env, "SOMEWORK_LEASE_SECONDS", 60),
		approvalPatterns: (env.APPROVAL_PATTERNS ?? "").split("\n").filter(Boolean),
		skills: { allow: env.SKILLS_ALLOW ? parseSkillList(env.SKILLS_ALLOW) : undefined, overlayDir: env.SKILLS_OVERLAY_DIR || undefined },
	};
}
