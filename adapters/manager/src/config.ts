import { homedir } from "node:os";
import { join } from "node:path";
import { defaultPolicy, type PolicyConfig } from "./policy.ts";

export interface Config {
	somework: { url: string; keyFile: string; caFile?: string };
	configDir: string;
	/** Compose files of the Pi project, in order: the original one first, then this package's override. */
	composeFiles: string[];
	gateway: { bind: string; port: number; urlForPi: string };
	policy: PolicyConfig;
	/** `wake`: the SDK's NATS wake with an HTTP safety net. `polling`: short HTTP lookups on a timer only. */
	/** `wake`: the SDK's NATS wake with an HTTP safety net. `polling`: short HTTP lookups on a timer only. */
	feed: { mode: "wake" | "polling"; taskIntervalMs: number; inboxIntervalMs: number; sweepEveryMs: number };
	telemetryPath: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const configDir = env.MANAGER_CONFIG_DIR ?? join(homedir(), ".config", "agent-cluster-telegram");
	const port = number(env, "MANAGER_GATEWAY_PORT", 7079);
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
			budgetCeiling: {
				maxTokens: number(env, "MANAGER_MAX_TOKENS_CEILING", defaultPolicy.budgetCeiling.maxTokens),
				maxMinutes: number(env, "MANAGER_MAX_MINUTES_CEILING", defaultPolicy.budgetCeiling.maxMinutes),
			},
			submissionsPerHour: number(env, "MANAGER_SUBMISSIONS_PER_HOUR", defaultPolicy.submissionsPerHour),
			messagesPerHour: number(env, "MANAGER_MESSAGES_PER_HOUR", defaultPolicy.messagesPerHour),
			approvalTtlMs: number(env, "MANAGER_APPROVAL_TTL_MINUTES", 10) * 60_000,
		},
		feed: {
			mode: env.MANAGER_FEED === "polling" ? "polling" : "wake",
			taskIntervalMs: number(env, "MANAGER_POLL_TASK_MS", 4000),
			inboxIntervalMs: number(env, "MANAGER_POLL_INBOX_MS", 8000),
			sweepEveryMs: number(env, "MANAGER_SWEEP_MS", 60_000),
		},
		telemetryPath: env.MANAGER_TELEMETRY_PATH ?? join(homedir(), ".local", "state", "agent-cluster", "pi-live.json"),
	};
}
