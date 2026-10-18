import { createProvider, type ApiKeyAuth, type Provider } from "@earendil-works/pi-ai";

/** The wire format the proxy is asked to speak: its Responses endpoint (the default) or its chat completions one. */
export const CODEX_PROXY_APIS = ["openai-responses", "openai-completions"] as const;
export type CodexProxyApi = (typeof CODEX_PROXY_APIS)[number];

export interface CodexProxyOptions {
	/** The proxy's address, `http://host:port` (the `/v1` is added). */
	url: string;
	api?: CodexProxyApi;
}

/** `CODEX_PROXY_URL` and `CODEX_PROXY_API` from the environment; undefined when no proxy is configured. */
export function codexProxyFrom(env: NodeJS.ProcessEnv): CodexProxyOptions | undefined {
	const raw = env.CODEX_PROXY_URL?.trim();
	if (!raw) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error("CODEX_PROXY_URL must be a URL like http://10.0.0.5:8095");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("CODEX_PROXY_URL must be an http or https URL");
	const api = (env.CODEX_PROXY_API?.trim() || "openai-responses") as CodexProxyApi;
	if (!CODEX_PROXY_APIS.includes(api)) throw new Error(`CODEX_PROXY_API must be one of ${CODEX_PROXY_APIS.join(", ")}`);
	return { url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`, api };
}

/** The key this agent was given by the proxy: the stored credential of the provider (`{"type":"api_key","key":...}` in auth.json), else `CODEX_PROXY_API_KEY`. */
const proxyKeyAuth: ApiKeyAuth = {
	name: "Codex proxy key",
	login: async (interaction) => {
		interaction.signal.throwIfAborted();
		const key = await interaction.prompt({ type: "secret", message: "Enter the Codex proxy key" });
		interaction.signal.throwIfAborted();
		return { type: "api_key", key };
	},
	resolve: async ({ ctx, credential, signal }) => {
		signal.throwIfAborted();
		if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored credential" };
		const value = await ctx.env("CODEX_PROXY_API_KEY");
		signal.throwIfAborted();
		return value ? { auth: { apiKey: value }, source: "CODEX_PROXY_API_KEY" } : undefined;
	},
};

/**
 * The `openai-codex` provider served by a codex-proxy instead of by ChatGPT directly: the same provider id and the same model ids as the stock one, so every
 * fleet document, override and allowlist that names `openai-codex/<model>` keeps working, but the requests go to the proxy with the agent's own proxy key
 * and not with a ChatGPT login. Which models answer is the proxy's: it serves what the accounts behind it are allowed to use.
 */
export async function codexProxyProvider(options: CodexProxyOptions): Promise<Provider> {
	const api = options.api ?? "openai-responses";
	const baseUrl = `${options.url}/v1`;
	const [{ OPENAI_CODEX_MODELS }, streams] = await Promise.all([
		import("@earendil-works/pi-ai/providers/openai-codex.models"),
		api === "openai-responses" ? import("@earendil-works/pi-ai/api/openai-responses.lazy").then((module) => module.openAIResponsesApi()) : import("@earendil-works/pi-ai/api/openai-completions.lazy").then((module) => module.openAICompletionsApi()),
	]);
	return createProvider({
		id: "openai-codex",
		name: "OpenAI Codex (through codex-proxy)",
		baseUrl,
		auth: { apiKey: proxyKeyAuth },
		models: Object.values(OPENAI_CODEX_MODELS).map((model) => ({ ...model, api, provider: "openai-codex", baseUrl })),
		api: streams,
	} as never) as Provider;
}
