import { readFileSync } from "node:fs";
import { allowlist, parseModelList, type ModelRef } from "./providers/allowlist.ts";
import { EFFORTS, isEffort } from "./setup/contract.ts";
import { parseSkillList } from "./skills.ts";
import { validateTable, type ShardTable } from "./shards.ts";
import { slackSettingsFrom, type SlackSettings } from "./slack/config.ts";
import { telegramSettingsFrom, type TelegramSettings } from "./telegram/config.ts";

export interface Config {
	somework: { url: string; keyFile: string; caFile?: string; requireTls: boolean };
	state: { dir: string; authFile: string };
	/** The full record of every model run, kept on the agent's disk (`RUN_TRACE=0` turns it off; days and size bound how long it stays). */
	trace?: { enabled: boolean; dir: string; keepDays: number; maxMegabytes: number };
	/** `PI_PROVIDER`, `PI_MODEL` and, optional, `PI_EFFORT`: what every agent runs on until the fleet's document or its own override says otherwise. */
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
		/** A token file per repository owner (`GIT_TOKEN_OWNERS=owner=file;owner2=file2`): a fine-grained token belongs to one owner, so repositories of another owner need their own. */
		ownerTokenFiles: Record<string, string>;
		authorName: string;
		authorEmail: string;
		githubApi?: string;
		draftPullRequests?: boolean;
		/** Persistent bare mirrors inside the sandbox (`GIT_MIRROR_DIR`); `repositories` are refreshed on a timer, any other repository only when a task uses it. */
		mirror?: { dir: string; repositories: string[]; refreshMinutes: number };
	};
	limits: { maxTokensCap: number; maxMinutesCap: number; dailyTokenLimit: number; budgetRaiseCeiling: number; budgetControllers?: string[] };
	shards?: ShardTable;
	healthPort: number;
	/** Minutes between the role's preflight checks (`PREFLIGHT_MINUTES`); 0 runs them at start only. */
	preflight: { minutes: number };
	concurrency: number;
	leaseSeconds: number;
	approvalPatterns: string[];
	/** Deployment override of the role's skills: `SKILLS_ALLOW` replaces `profile.skills.allow` when it is set and not empty. */
	skills: { allow?: string[]; overlayDir?: string };
	/** The agent's own Telegram bot (`TELEGRAM_BOT_TOKEN_FILE` or `TELEGRAM_BOT_TOKEN`, with `TELEGRAM_ALLOWED_USER_IDS`); off without a token. */
	telegram: TelegramSettings;
	/** The agent's own Slack app in Socket Mode (`SLACK_BOT_TOKEN_FILE` and `SLACK_APP_TOKEN_FILE`, or the tokens themselves, with `SLACK_ALLOWED_USER_IDS`); off unless both tokens are set. */
	slack: SlackSettings;
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

const minutes = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => {
	const value = env[name] === undefined || env[name] === "" ? fallback : Number(env[name]);
	if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number of minutes, 0 or more`);
	return value;
};

const mirrorFrom = (env: NodeJS.ProcessEnv): Config["git"]["mirror"] =>
	env.GIT_MIRROR_DIR ? { dir: env.GIT_MIRROR_DIR, repositories: (env.GIT_MIRROR_REPOS ?? "").split(/[\s,]+/).filter(Boolean), refreshMinutes: integer(env, "GIT_MIRROR_REFRESH_MINUTES", 30) } : undefined;

export const ownerTokenFilesFrom = (env: NodeJS.ProcessEnv): Record<string, string> => {
	const files: Record<string, string> = {};
	for (const entry of (env.GIT_TOKEN_OWNERS ?? "").split(";").map((item) => item.trim()).filter(Boolean)) {
		const at = entry.indexOf("=");
		if (at <= 0 || at === entry.length - 1) throw new Error("GIT_TOKEN_OWNERS entries look like owner=path, separated by semicolons");
		files[entry.slice(0, at).trim().toLowerCase()] = entry.slice(at + 1).trim();
	}
	return files;
};

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
	const effort = env.PI_EFFORT || undefined;
	if (effort !== undefined && !isEffort(effort)) throw new Error(`PI_EFFORT must be one of ${EFFORTS.join(", ")}`);
	const model: ModelRef = { provider: env.PI_PROVIDER ?? "openai-codex", modelId: env.PI_MODEL ?? "gpt-5.5", ...(effort ? { effort } : {}) };
	return {
		somework: { url: required(env, "SOMEWORK_URL"), keyFile: required(env, "SOMEWORK_KEY_FILE"), caFile: env.SOMEWORK_CA_FILE, requireTls: env.SOMEWORK_REQUIRE_TLS === "1" },
		state: { dir: env.PI_STATE_DIR ?? "/state", authFile: env.PI_AUTH_FILE ?? "/run/secrets/pi/auth.json" },
		trace: { enabled: env.RUN_TRACE !== "0", dir: env.RUN_TRACE_DIR ?? `${env.PI_STATE_DIR ?? "/state"}/runs`, keepDays: integer(env, "RUN_TRACE_KEEP_DAYS", 30), maxMegabytes: integer(env, "RUN_TRACE_MAX_MB", 1024) },
		model,
		allowedModels: allowlist(model, parseModelList(env.PI_ALLOWED_MODELS)),
		sandbox: { url: required(env, "SANDBOX_URL"), tokenFile: env.SANDBOX_TOKEN_FILE ?? "/run/secrets/sandbox-token", workspaceRoot: env.SANDBOX_WORKSPACES ?? "/workspace", caFile: env.SANDBOX_CA_FILE },
		git: { tokenFile: env.GIT_TOKEN_FILE, ownerTokenFiles: ownerTokenFilesFrom(env), app: appFrom(env), authorFromApp: !env.GIT_AUTHOR_NAME && !env.GIT_AUTHOR_EMAIL, tokenHosts: (env.GIT_TOKEN_HOSTS ?? "github.com").split(/[\s,]+/).filter(Boolean), authorName: env.GIT_AUTHOR_NAME ?? "SomeWork Pi", authorEmail: env.GIT_AUTHOR_EMAIL ?? "pi@somework.invalid", githubApi: env.GITHUB_API || undefined, draftPullRequests: env.GIT_PR_DRAFT === "1", mirror: mirrorFrom(env) },
		limits: { maxTokensCap: integer(env, "BUDGET_MAX_TOKENS_CAP", 2_000_000), maxMinutesCap: integer(env, "BUDGET_MAX_MINUTES_CAP", 60), dailyTokenLimit: integer(env, "DAILY_TOKEN_LIMIT", 10_000_000),
			budgetRaiseCeiling: integer(env, "BUDGET_RAISE_CEILING", integer(env, "DAILY_TOKEN_LIMIT", 10_000_000)),
			...(env.BUDGET_CONTROLLERS ? { budgetControllers: env.BUDGET_CONTROLLERS.split(/[\s,]+/).filter(Boolean) } : {}) },
		shards,
		healthPort: integer(env, "HEALTH_PORT", 8081),
		preflight: { minutes: minutes(env, "PREFLIGHT_MINUTES", 15) },
		concurrency: integer(env, "PI_CONCURRENCY", 2),
		leaseSeconds: integer(env, "SOMEWORK_LEASE_SECONDS", 60),
		approvalPatterns: (env.APPROVAL_PATTERNS ?? "").split("\n").filter(Boolean),
		skills: { allow: env.SKILLS_ALLOW ? parseSkillList(env.SKILLS_ALLOW) : undefined, overlayDir: env.SKILLS_OVERLAY_DIR || undefined },
		telegram: telegramSettingsFrom(env),
		slack: slackSettingsFrom(env),
	};
}
