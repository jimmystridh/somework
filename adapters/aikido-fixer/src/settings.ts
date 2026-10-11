import { readFileSync } from "node:fs";

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** A named check the repository defines for this role. The model never chooses a command: it can only be run by name. */
export interface CheckProfile {
	command: string;
	/** Relative to the workspace. Default: the workspace root. */
	cwd?: string;
	timeoutSeconds?: number;
}

export interface FixerSettings {
	region: string;
	credentialsFile: string;
	/** The repositories this agent may touch, as clone URLs. The first is the one events are about. */
	repositories: string[];
	/** Repository names Aikido may report an issue under (`owner/name` and `name`), lower case. */
	repositoryNames: string[];
	minSeverity: Severity;
	fixTypes: string[];
	maxFiles: number;
	protectedPaths: string[];
	checkProfile?: { name: string; profile: CheckProfile };
	maxAttemptsPerIssue: number;
	cooldownMinutes: number;
	dailyCap: number;
	budget: { maxTokens: number; maxMinutes: number };
	/** Minutes after a pull request is opened (and after each check) at which the agent looks at it again for review comments and failing checks; empty turns follow-ups off. */
	followUpMinutes: number[];
	/** After the agent pushed a follow-up, the next look at the pull request comes this soon (its CI starts), whatever the table says. */
	ciWatchMinutes: number;
	/** Follow-up tasks the handler starts per day. */
	followUpCapPerDay: number;
	/** The least time between two requests to Aikido, in milliseconds (`AIKIDO_API_MIN_INTERVAL_MS`). */
	apiMinIntervalMs: number;
	apiBase?: string;
	oauthUrl?: string;
	/** The sandbox has the `aikido` command (`AIKIDO_SANDBOX_CLI=1`): the model is told so, and how to use it. Mounting it is the deployment's job (deploy/README.md). */
	sandboxCli: boolean;
	/** A JSON file of earlier attempts to seed the account the chat gives of what the agent did (`AIKIDO_LEDGER_IMPORT`). Imported once, harmlessly again. */
	ledgerImport?: string;
}

const list = (text: string | undefined, fallback: string[]): string[] => (text === undefined || text.trim() === "" ? fallback : text.split(/[\s,]+/).filter(Boolean));

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
	return value;
}

/** `https://github.com/Owner/Name.git` to `owner/name`, or undefined when the URL has no owner and name. */
export function repositoryFullName(url: string): string | undefined {
	const match = /^(?:https?:\/\/[^/]+\/|git@[^:]+:|ssh:\/\/git@[^/]+\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
	return match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined;
}

export const normaliseRepositoryUrl = (url: string): string => url.trim().replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();

export const DEFAULT_PROTECTED_PATHS = [".github/**", ".woodpecker/**", ".gitlab-ci.yml", "**/CODEOWNERS", "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa*"];
export const DEFAULT_FIX_TYPES = ["open_source", "sast", "iac"];

function checkProfileFrom(env: NodeJS.ProcessEnv): FixerSettings["checkProfile"] {
	const name = env.AIKIDO_CHECK_PROFILE;
	if (!name) return undefined;
	const file = env.AIKIDO_CHECK_FILE;
	if (!file) throw new Error("AIKIDO_CHECK_PROFILE needs AIKIDO_CHECK_FILE (a JSON file of named check profiles)");
	let profiles: Record<string, CheckProfile>;
	try {
		profiles = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`AIKIDO_CHECK_FILE ${file} cannot be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const profile = profiles[name];
	if (!profile || typeof profile.command !== "string" || profile.command.trim() === "") throw new Error(`the check profile "${name}" is not defined in ${file} (it needs a command)`);
	if (profile.cwd !== undefined && (typeof profile.cwd !== "string" || profile.cwd.startsWith("/") || profile.cwd.split("/").includes(".."))) throw new Error(`the check profile "${name}": cwd must be a relative path inside the workspace`);
	return { name, profile: { command: profile.command, ...(profile.cwd ? { cwd: profile.cwd } : {}), ...(profile.timeoutSeconds ? { timeoutSeconds: Number(profile.timeoutSeconds) } : {}) } };
}

/** `15,60,240` to minutes; `0`, `off` or an empty value to none. */
function minutesList(env: NodeJS.ProcessEnv, name: string, fallback: number[]): number[] {
	const raw = env[name];
	if (raw === undefined) return fallback;
	if (raw.trim() === "" || raw.trim() === "0" || raw.trim().toLowerCase() === "off") return [];
	const minutes = raw.split(/[\s,]+/).filter(Boolean).map(Number);
	if (minutes.length > 10 || minutes.some((value) => !Number.isInteger(value) || value < 1 || value > 10_080)) throw new Error(`${name} must be up to 10 whole numbers of minutes from 1 to 10080, or off`);
	return minutes;
}

/** The role's settings from the environment (everything is `AIKIDO_*` except the kit's own variables). Fails at startup, not at the first event. */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): FixerSettings {
	const repositories = list(env.AIKIDO_ALLOWED_REPOSITORIES ?? env.AIKIDO_REPOSITORY_URL, []);
	if (repositories.length === 0) throw new Error("AIKIDO_REPOSITORY_URL is required: the repository this agent fixes");
	const minSeverity = (env.AIKIDO_MIN_SEVERITY ?? "high").toLowerCase();
	if (!(SEVERITIES as readonly string[]).includes(minSeverity)) throw new Error(`AIKIDO_MIN_SEVERITY must be one of ${SEVERITIES.join(", ")}`);
	const names = new Set<string>();
	for (const url of repositories) {
		const full = repositoryFullName(url);
		if (!full) throw new Error(`not a repository URL: ${url}`);
		names.add(full);
		names.add(full.split("/")[1]!);
	}
	for (const extra of list(env.AIKIDO_REPOSITORY_NAMES, [])) names.add(extra.toLowerCase());
	const region = (env.AIKIDO_REGION ?? "eu").toLowerCase();
	if (!["eu", "us", "me"].includes(region)) throw new Error("AIKIDO_REGION must be eu, us or me");
	const override = env.AIKIDO_ALLOW_BASE_OVERRIDE === "1";
	return {
		region,
		credentialsFile: env.AIKIDO_CLIENT_FILE ?? "/run/secrets/aikido-client.json",
		repositories,
		repositoryNames: [...names],
		minSeverity: minSeverity as Severity,
		fixTypes: list(env.AIKIDO_FIX_TYPES, DEFAULT_FIX_TYPES).map((type) => type.toLowerCase()),
		maxFiles: integer(env, "AIKIDO_MAX_FILES", 40),
		protectedPaths: list(env.AIKIDO_PROTECTED_PATHS, DEFAULT_PROTECTED_PATHS),
		checkProfile: checkProfileFrom(env),
		maxAttemptsPerIssue: integer(env, "AIKIDO_MAX_ATTEMPTS_PER_ISSUE", 2),
		cooldownMinutes: integer(env, "AIKIDO_ATTEMPT_COOLDOWN_MINUTES", 180),
		dailyCap: integer(env, "AIKIDO_DAILY_CAP", 5),
		budget: { maxTokens: integer(env, "AIKIDO_FIX_BUDGET_TOKENS", 300_000), maxMinutes: integer(env, "AIKIDO_FIX_BUDGET_MINUTES", 30) },
		followUpMinutes: minutesList(env, "AIKIDO_FOLLOWUP_MINUTES", [10, 20, 40, 90, 180, 360]),
		ciWatchMinutes: integer(env, "AIKIDO_CI_WATCH_MINUTES", 10),
		followUpCapPerDay: integer(env, "AIKIDO_FOLLOWUP_CAP_PER_DAY", 10),
		apiMinIntervalMs: integer(env, "AIKIDO_API_MIN_INTERVAL_MS", 1500),
		sandboxCli: env.AIKIDO_SANDBOX_CLI === "1",
		...(env.AIKIDO_LEDGER_IMPORT ? { ledgerImport: env.AIKIDO_LEDGER_IMPORT } : {}),
		...(override && env.AIKIDO_API_BASE ? { apiBase: env.AIKIDO_API_BASE } : {}),
		...(override && env.AIKIDO_OAUTH_URL ? { oauthUrl: env.AIKIDO_OAUTH_URL } : {}),
	};
}

/** Environment for `runAgentService`: the kit's own settings filled in from the role's, without overriding what the deployment set. */
export function roleEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const workspaces = env.SANDBOX_WORKSPACES ?? "/workspace";
	return {
		...env,
		PI_CONCURRENCY: env.PI_CONCURRENCY ?? "1",
		GIT_PR_DRAFT: env.GIT_PR_DRAFT ?? "0",
		GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME ?? "SomeWork Aikido fixer",
		GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL ?? "aikido-fixer@somework.invalid",
		GIT_MIRROR_DIR: env.GIT_MIRROR_DIR ?? `${workspaces.replace(/\/$/, "")}/.mirrors`,
		GIT_MIRROR_REPOS: env.GIT_MIRROR_REPOS ?? list(env.AIKIDO_ALLOWED_REPOSITORIES ?? env.AIKIDO_REPOSITORY_URL, []).join(","),
		GIT_MIRROR_REFRESH_MINUTES: env.GIT_MIRROR_REFRESH_MINUTES ?? env.AIKIDO_MIRROR_REFRESH_MINUTES ?? "30",
		EVENTS_ENABLED: env.EVENTS_ENABLED ?? "1",
	};
}
