import { DEFAULT_HYPERVISOR_HOSTS, DEFAULT_SCRIPTS, type ClassifyContext } from "./classifier/index.ts";

/** A machine the agent may run commands on, by the name the model uses. Its key is `<sshKeyDir>/<name>`. */
export interface HostEntry {
	name: string;
	user: string;
	address: string;
	port: number;
}

/** Another repository the agent may push to: its own remote name and its own credential (a fine-grained token belongs to one owner). */
export interface ExtraRepository {
	/** The name the model uses and the remote the classifier allows. */
	name: string;
	url: string;
	tokenFile: string;
}

export interface ClusterSettings {
	/** The one repository the agent changes (https URL); empty until the deployment sets it. */
	repositoryUrl?: string;
	/** The git remote that may be pushed to: the organisation's, never `origin`. */
	gitRemote: string;
	/** Ask the owner before a destructive command (off: nothing is asked, only what is never allowed is refused). The questions come back with `CLUSTER_DEV_CONFIRM=1`. */
	confirm: boolean;
	/** With `confirm`: ask about the sandbox's own commands and files as well (off: the sandbox holds no secrets and has no way into the cluster, so nothing there is asked). */
	askInSandbox: boolean;
	/** Other repositories git_push may push to, each with its own credential file. */
	extraRepositories: ExtraRepository[];
	hosts: HostEntry[];
	hypervisorHosts: string[];
	sshKeyDir: string;
	sshKnownHosts: string;
	execTimeoutSeconds: number;
	execMaxBytes: number;
	ownServices: string[];
	scripts: string[];
	workspaces: string[];
	ci?: { url: string; repository: string; tokenFile: string; caFile?: string };
	/** Health addresses of the agents, by name (`http://agents.example:8082`). */
	agentUrls: Record<string, string>;
	agentsCaFile?: string;
}

export const HARD_LIMITS = { execTimeoutSeconds: 900, execMaxBytes: 262_144 };

const list = (text: string | undefined, fallback: string[] = []): string[] => (text === undefined || text.trim() === "" ? fallback : text.split(/[\s,]+/).filter(Boolean));

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
	if (value > max) throw new Error(`${name} must be at most ${max}`);
	return value;
}

const HOST_NAME = /^[a-z0-9][a-z0-9._-]{0,40}$/;
const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const ADDRESS = /^(?:[A-Za-z0-9][A-Za-z0-9.-]{0,252}|\[[0-9A-Fa-f:]+\])$/;

/** `agents=js@agents.example,services=js@services.example:2222`: names are what the model says, the rest is where and as whom. */
export function parseHosts(text: string | undefined): HostEntry[] {
	const hosts: HostEntry[] = [];
	for (const item of list(text)) {
		const match = /^([^=]+)=(?:([^@]+)@)?([^:]+|\[[^\]]+\])(?::(\d{1,5}))?$/.exec(item);
		if (!match) throw new Error(`CLUSTER_DEV_HOSTS: "${item.slice(0, 40)}" is not name=user@address[:port]`);
		const [, name, user = "root", address, port = "22"] = match;
		if (!HOST_NAME.test(name!)) throw new Error(`CLUSTER_DEV_HOSTS: "${name!.slice(0, 40)}" is not a usable host name (lower case letters, digits, dot, dash)`);
		if (!USER_NAME.test(user)) throw new Error(`CLUSTER_DEV_HOSTS: "${user.slice(0, 40)}" is not a usable user name`);
		if (!ADDRESS.test(address!) || address!.startsWith("-")) throw new Error(`CLUSTER_DEV_HOSTS: "${address!.slice(0, 40)}" is not a usable address`);
		if (Number(port) < 1 || Number(port) > 65_535) throw new Error(`CLUSTER_DEV_HOSTS: port ${port} is out of range`);
		if (hosts.some((host) => host.name === name)) throw new Error(`CLUSTER_DEV_HOSTS: the host ${name} is listed twice`);
		hosts.push({ name: name!, user, address: address!, port: Number(port) });
	}
	return hosts;
}

export function parseAgentUrls(text: string | undefined): Record<string, string> {
	const urls: Record<string, string> = {};
	for (const item of list(text)) {
		const equals = item.indexOf("=");
		const name = item.slice(0, equals);
		const url = item.slice(equals + 1);
		if (equals <= 0 || !/^[a-z0-9][a-z0-9._-]{0,40}$/.test(name)) throw new Error(`CLUSTER_DEV_AGENT_URLS: "${item.slice(0, 40)}" is not name=http://address:port`);
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error(`CLUSTER_DEV_AGENT_URLS: the address of ${name} is not a URL`);
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`CLUSTER_DEV_AGENT_URLS: the address of ${name} must be http or https`);
		if (parsed.username || parsed.password) throw new Error(`CLUSTER_DEV_AGENT_URLS: the address of ${name} must not carry a password`);
		urls[name] = parsed.origin;
	}
	return urls;
}

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

/** `somework=https://github.com/owner/repo,tools=https://github.com/owner/tools`: more repositories, each pushed to under its own name and token (`<tokenDir>/git-token-<name>`). */
export function parseExtraRepositories(text: string | undefined, tokenDir: string, taken: readonly string[]): ExtraRepository[] {
	const repositories: ExtraRepository[] = [];
	for (const item of list(text)) {
		const equals = item.indexOf("=");
		const name = item.slice(0, equals);
		const url = item.slice(equals + 1);
		if (equals <= 0 || !REMOTE_NAME.test(name)) throw new Error(`CLUSTER_DEV_EXTRA_REPOSITORIES: "${item.slice(0, 40)}" is not name=https://host/owner/repository`);
		if (name === "origin") throw new Error("CLUSTER_DEV_EXTRA_REPOSITORIES: a repository must not be called origin");
		if (taken.includes(name) || repositories.some((entry) => entry.name === name)) throw new Error(`CLUSTER_DEV_EXTRA_REPOSITORIES: the name ${name} is used twice`);
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error(`CLUSTER_DEV_EXTRA_REPOSITORIES: the address of ${name} is not a URL`);
		}
		if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error(`CLUSTER_DEV_EXTRA_REPOSITORIES: the address of ${name} must be https without a password`);
		repositories.push({ name, url: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, ""), tokenFile: `${tokenDir}/git-token-${name}` });
	}
	return repositories;
}

/** The role's settings from the environment (`CLUSTER_DEV_*`, `CI_*`; the kit's own variables are the kit's). Fails at startup, not at the first command. */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): ClusterSettings {
	const repositoryUrl = env.CLUSTER_DEV_REPOSITORY?.trim() || undefined;
	if (repositoryUrl && !/^https:\/\/[^\s]{1,400}$/.test(repositoryUrl)) throw new Error("CLUSTER_DEV_REPOSITORY must be an https URL");
	const gitRemote = env.CLUSTER_DEV_GIT_REMOTE?.trim() || "org";
	if (!REMOTE_NAME.test(gitRemote)) throw new Error("CLUSTER_DEV_GIT_REMOTE must be a plain remote name");
	if (gitRemote === "origin") throw new Error("CLUSTER_DEV_GIT_REMOTE must not be origin: the agent pushes to the organisation's remote only");
	const sshKeyDir = (env.CLUSTER_DEV_SSH_KEY_DIR?.trim() || "/run/secrets/ssh").replace(/\/+$/, "");
	const ciUrl = env.CI_URL?.trim();
	const ci = ciUrl
		? (() => {
				let parsed: URL;
				try {
					parsed = new URL(ciUrl);
				} catch {
					throw new Error("CI_URL must be a URL");
				}
				if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("CI_URL must be http or https");
				if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(env.CI_REPO ?? "") && !/^\d{1,12}$/.test(env.CI_REPO ?? "")) throw new Error("CI_REPO must be owner/name (or the numeric repository id)");
				if (!env.CI_TOKEN_FILE) throw new Error("CI_TOKEN_FILE (the Woodpecker token) is required when CI_URL is set");
				return { url: parsed.origin, repository: env.CI_REPO!, tokenFile: env.CI_TOKEN_FILE, ...(env.CI_CA_FILE ? { caFile: env.CI_CA_FILE } : {}) };
			})()
		: undefined;
	return {
		...(repositoryUrl ? { repositoryUrl } : {}),
		gitRemote,
		confirm: confirmFrom(env),
		askInSandbox: env.CLUSTER_DEV_ASK_IN_SANDBOX?.trim() === "1",
		extraRepositories: parseExtraRepositories(env.CLUSTER_DEV_EXTRA_REPOSITORIES, (env.CLUSTER_DEV_GIT_TOKEN_DIR?.trim() || "/run/secrets/git").replace(/\/+$/, ""), [gitRemote]),
		hosts: parseHosts(env.CLUSTER_DEV_HOSTS),
		hypervisorHosts: list(env.CLUSTER_DEV_HYPERVISOR_HOSTS, DEFAULT_HYPERVISOR_HOSTS),
		sshKeyDir,
		sshKnownHosts: env.CLUSTER_DEV_SSH_KNOWN_HOSTS?.trim() || `${sshKeyDir}/known_hosts`,
		execTimeoutSeconds: integer(env, "CLUSTER_DEV_EXEC_TIMEOUT_SECONDS", 120, HARD_LIMITS.execTimeoutSeconds),
		execMaxBytes: integer(env, "CLUSTER_DEV_EXEC_MAX_BYTES", 32_768, HARD_LIMITS.execMaxBytes),
		ownServices: list(env.CLUSTER_DEV_OWN_SERVICES),
		scripts: list(env.CLUSTER_DEV_SCRIPTS, DEFAULT_SCRIPTS),
		workspaces: list(env.CLUSTER_DEV_WORKSPACES, ["/workspace", "/tmp"]),
		...(ci ? { ci } : {}),
		agentUrls: parseAgentUrls(env.CLUSTER_DEV_AGENT_URLS),
		...(env.CLUSTER_DEV_AGENTS_CA_FILE ? { agentsCaFile: env.CLUSTER_DEV_AGENTS_CA_FILE } : {}),
	};
}

/** Whether the deployment asked for confirmations; read on its own so the profile can pick its prompt without loading every setting. */
export const confirmFrom = (env: NodeJS.ProcessEnv): boolean => env.CLUSTER_DEV_CONFIRM?.trim() === "1";

/** What the classifier needs to know about a command: in the agent's sandbox, or on one of the hosts. */
export function classifyContext(settings: ClusterSettings, host?: string): ClassifyContext {
	return {
		remote: settings.gitRemote,
		...(settings.askInSandbox ? {} : { sandbox: "free" as const }),
		extraRemotes: settings.extraRepositories.map((repository) => repository.name),
		hypervisorHosts: settings.hypervisorHosts,
		ownServices: settings.ownServices,
		scripts: settings.scripts,
		...(host === undefined ? { workspaces: settings.workspaces } : { host }),
	};
}

/** Environment for `runAgentService`: the kit's own settings filled in from the role's, without overriding what the deployment set. */
export function roleEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const repository = env.CLUSTER_DEV_REPOSITORY?.trim();
	return {
		...env,
		PI_CONCURRENCY: env.PI_CONCURRENCY ?? "1",
		GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME ?? "SomeWork cluster development",
		GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL ?? "cluster-dev@somework.invalid",
		...(repository && !env.CHAT_REPOSITORY_URL ? { CHAT_REPOSITORY_URL: repository } : {}),
		OBSERVE_SCOPE: env.OBSERVE_SCOPE ?? "fleet",
	};
}
