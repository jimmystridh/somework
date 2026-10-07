/**
 * Timers (see docs/AGENT_FLEET.md, "Asking the hub for a timer"): the agent can ask the event hub to wake it later with a note. Off unless
 * `TIMERS_URL` is set; then the token file is required, and the CA file when the hub's certificate comes from a private CA.
 */
export interface ResolvedTimers {
	enabled: boolean;
	url?: string;
	tokenFile?: string;
	caFile?: string;
}

export function resolveTimers(env: NodeJS.ProcessEnv = process.env): ResolvedTimers {
	const url = env.TIMERS_URL?.trim();
	if (!url) return { enabled: false };
	if (!env.TIMERS_TOKEN_FILE) throw new Error("TIMERS_URL needs TIMERS_TOKEN_FILE (the agent's token from `somework-hub timer-token <agent>`)");
	return { enabled: true, url, tokenFile: env.TIMERS_TOKEN_FILE, ...(env.TIMERS_CA_FILE ? { caFile: env.TIMERS_CA_FILE } : {}) };
}
