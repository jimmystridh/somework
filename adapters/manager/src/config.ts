import { homedir } from "node:os";
import { join } from "node:path";
import type { ControlsConfig } from "./controls.ts";
import { defaultEventIntake, type EventIntakeConfig } from "./event-intake.ts";
import { defaultPolicy, type PolicyConfig } from "./policy.ts";

export interface Config {
	somework: { url: string; keyFile: string; caFile?: string };
	configDir: string;
	/** Compose files of the Pi project, in order: the original one first, then this package's override. */
	composeFiles: string[];
	gateway: { bind: string; port: number; urlForPi: string };
	policy: PolicyConfig;
	/** `wake`: the SDK's NATS wake with an HTTP safety net. `polling`: short HTTP lookups on a timer only. */
	feed: { mode: "wake" | "polling"; inboxIntervalMs: number; sweepEveryMs: number };
	telemetryPath: string;
	events: EventIntakeConfig & { pollMs: number };
	controls: ControlsConfig;
	/** What Operations may change (ADR 0004): where the Manager keeps its setup and where Pi finds the result. */
	setup: { dir: string; piAgentDir: string; piAgentDirInContainer: string; os: string };
	/** The Manager's own HTTP endpoint for Operations (`/profile`); port 0 switches it off. */
	health: { bind: string; port: number };
	/** Path of the JSON file that names the stacks and the Windows machines /suspend and /unsuspend stop and start (MANAGER_HOST_CONTROL). */
	hostControl?: string;
}

const need = (env: NodeJS.ProcessEnv, name: string): string => {
	const value = env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
};

const number = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
	return value;
};

const list = (env: NodeJS.ProcessEnv, name: string, fallback: string[]): string[] => {
	const raw = env[name];
	return raw === undefined ? fallback : raw.split(",").map((item) => item.trim()).filter(Boolean);
};

/** `agent/reviewer=http://10.0.0.1:8081,agent/windows-developer=http://10.0.0.2:8081` */
export function parseAgentHealth(raw: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const pair of (raw ?? "").split(",")) {
		const [agent, ...url] = pair.trim().split("=");
		if (agent && url.length > 0) out[agent] = url.join("=");
	}
	return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const configDir = env.MANAGER_CONFIG_DIR ?? join(homedir(), ".config", "agent-cluster-telegram");
	const port = number(env, "MANAGER_GATEWAY_PORT", 7079);
	const healthPort = env.MANAGER_HEALTH_PORT === undefined || env.MANAGER_HEALTH_PORT === "" ? 7080 : Number(env.MANAGER_HEALTH_PORT);
	if (!Number.isInteger(healthPort) || healthPort < 0 || healthPort > 65_535) throw new Error("MANAGER_HEALTH_PORT must be a port number, or 0 to switch the endpoint off");
	return {
		somework: { url: need(env, "MANAGER_SOMEWORK_URL"), keyFile: need(env, "MANAGER_KEY_FILE"), caFile: env.MANAGER_CA_FILE },
		configDir,
		composeFiles: (env.MANAGER_COMPOSE_FILES ?? join(homedir(), "agent-cluster-pi", "compose.pi.yaml")).split(",").filter(Boolean),
		gateway: {
			bind: env.MANAGER_GATEWAY_BIND ?? "172.17.0.1",
			port,
			urlForPi: env.MANAGER_GATEWAY_URL ?? `http://host.docker.internal:${port}`,
		},
		policy: {
			...defaultPolicy,
			messagesPerHour: number(env, "MANAGER_MESSAGES_PER_HOUR", defaultPolicy.messagesPerHour),
			approvalTtlMs: number(env, "MANAGER_APPROVAL_TTL_MINUTES", 10) * 60_000,
		},
		feed: {
			mode: env.MANAGER_FEED === "polling" ? "polling" : "wake",
			inboxIntervalMs: number(env, "MANAGER_POLL_INBOX_MS", 8000),
			sweepEveryMs: number(env, "MANAGER_SWEEP_MS", 60_000),
		},
		telemetryPath: env.MANAGER_TELEMETRY_PATH ?? join(homedir(), ".local", "state", "agent-cluster", "pi-live.json"),
		events: {
			pollMs: number(env, "MANAGER_EVENT_POLL_MS", 5000),
			topics: list(env, "MANAGER_EVENT_TOPICS", defaultEventIntake.topics),
			digestTopics: list(env, "MANAGER_DIGEST_TOPICS", defaultEventIntake.digestTopics),
			urgentTopics: list(env, "MANAGER_URGENT_TOPICS", defaultEventIntake.urgentTopics),
			perTopicPerHour: number(env, "MANAGER_EVENT_RATE_PER_HOUR", defaultEventIntake.perTopicPerHour),
			timeZone: env.MANAGER_QUIET_TZ ?? defaultEventIntake.timeZone,
			...(env.MANAGER_QUIET_HOURS ? { quietHours: env.MANAGER_QUIET_HOURS } : {}),
		},
		setup: {
			dir: env.MANAGER_SETUP_DIR ?? join(configDir, "setup"),
			piAgentDir: env.MANAGER_PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
			piAgentDirInContainer: env.MANAGER_PI_AGENT_DIR_IN_CONTAINER ?? "/home/node/.pi/agent",
			os: env.MANAGER_PI_OS ?? "linux",
		},
		health: { bind: env.MANAGER_HEALTH_BIND ?? "0.0.0.0", port: healthPort },
		...(env.MANAGER_HOST_CONTROL ? { hostControl: env.MANAGER_HOST_CONTROL } : {}),
		controls: {
			hubUrl: env.MANAGER_HUB_URL,
			hubTokenFile: env.MANAGER_HUB_TOKEN_FILE,
			hubCaFile: env.MANAGER_HUB_CA_FILE ?? env.MANAGER_CA_FILE,
			agentHealth: parseAgentHealth(env.MANAGER_AGENT_HEALTH),
			agentCaFile: env.MANAGER_AGENT_CA_FILE,
			...(env.MANAGER_OPERATIONS_URL && env.MANAGER_OPERATIONS_TOKEN_FILE ? { operations: { url: env.MANAGER_OPERATIONS_URL, tokenFile: env.MANAGER_OPERATIONS_TOKEN_FILE, caFile: env.MANAGER_OPERATIONS_CA_FILE ?? env.MANAGER_CA_FILE } } : {}),
		},
	};
}
