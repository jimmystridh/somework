/**
 * Pull request watches (see docs/AGENT_FLEET.md, "Watching a pull request"): the agent can ask the event hub for the events of one pull request.
 * Off unless `WATCH_URL` is set; then the token file is required, and the CA file when the hub's certificate comes from a private CA.
 */
export interface ResolvedWatches {
	enabled: boolean;
	url?: string;
	tokenFile?: string;
	caFile?: string;
}

export function resolveWatches(env: NodeJS.ProcessEnv = process.env): ResolvedWatches {
	const url = env.WATCH_URL?.trim();
	if (!url) return { enabled: false };
	if (!env.WATCH_TOKEN_FILE) throw new Error("WATCH_URL needs WATCH_TOKEN_FILE (the agent's token from `somework-hub watch-token <agent>`)");
	return { enabled: true, url, tokenFile: env.WATCH_TOKEN_FILE, ...(env.WATCH_CA_FILE ? { caFile: env.WATCH_CA_FILE } : {}) };
}
