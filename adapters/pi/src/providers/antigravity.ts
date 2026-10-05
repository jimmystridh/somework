import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createProvider, type Credential, type OAuthAuth, type OAuthCredential, type Provider, type ProviderStreams } from "@earendil-works/pi-ai";
import { createJiti } from "jiti";

export const ANTIGRAVITY_PROVIDER = "antigravity";

interface CatalogModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Record<string, string | null>;
}

/** The parts of the `pi-antigravity` package the service uses. Tests substitute their own. */
export interface AntigravityImplementation {
	api: string;
	endpoint: string;
	models: CatalogModel[];
	stream: ProviderStreams["streamSimple"];
	refresh(credential: OAuthCredential): Promise<OAuthCredential>;
	/** The request credential the stream function expects (a JSON string with token and project id). */
	apiKey(credential: OAuthCredential): string;
}

/**
 * `pi-antigravity` is written for Pi's extension host: it ships TypeScript sources with `.js` import specifiers inside node_modules,
 * which Node cannot run natively, so it is loaded through jiti. It keeps its multi-account state in `$PI_CODING_AGENT_DIR`; that is
 * pointed at the service's own directory so a workstation's `~/.pi` is never read or written.
 */
export async function loadAntigravity(options: { stateDir: string }): Promise<AntigravityImplementation> {
	process.env.PI_CODING_AGENT_DIR ??= options.stateDir;
	const sources = join(dirname(createRequire(import.meta.url).resolve("pi-antigravity/package.json")), "src");
	const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
	const load = (path: string) => jiti.import<any>(join(sources, path));
	const [models, stream, auth, client] = await Promise.all([load("models/index.ts"), load("stream/index.ts"), load("auth/index.ts"), load("client/index.ts")]);
	return {
		api: stream.ANTIGRAVITY_API,
		endpoint: client.DEFAULT_ENDPOINT,
		models: models.getCurrentAntigravityCatalog().models,
		stream: stream.streamAntigravity,
		refresh: (credential) => auth.refreshAntigravityToken(credential),
		apiKey: (credential) => auth.getApiKey(credential),
	};
}

const oauthFor = (implementation: AntigravityImplementation): OAuthAuth => ({
	name: "Antigravity (Google account)",
	isSubscription: true,
	login: async () => {
		throw new Error("log in to Antigravity with Pi on a workstation and install the resulting auth.json entry; the service never logs in");
	},
	refresh: async (credential, signal) => {
		signal.throwIfAborted();
		return { ...(await implementation.refresh(credential)), type: "oauth" };
	},
	toAuth: async (credential) => ({ apiKey: implementation.apiKey(credential) }),
});

export function antigravityProvider(implementation: AntigravityImplementation): Provider {
	const api = implementation.api;
	return createProvider({
		id: ANTIGRAVITY_PROVIDER,
		name: "Antigravity",
		baseUrl: implementation.endpoint,
		auth: { oauth: oauthFor(implementation) },
		models: implementation.models.map((model) => ({ ...model, api, provider: ANTIGRAVITY_PROVIDER, baseUrl: implementation.endpoint })),
		api: { [api]: { stream: implementation.stream, streamSimple: implementation.stream } },
	} as never) as Provider;
}

export type { Credential };
