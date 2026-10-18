import type { Models, Provider } from "@earendil-works/pi-ai";
import type { ModelRef } from "./allowlist.ts";
import { codexProxyProvider, type CodexProxyOptions } from "./codex-proxy.ts";

export const PROVIDERS = ["openai-codex", "openai", "opencode-go", "antigravity"] as const;

/** Provider factories are loaded lazily so the service only pulls in the providers it is configured for. */
export async function loadProvider(id: string, options: { stateDir: string; codexProxy?: CodexProxyOptions }): Promise<Provider> {
	switch (id) {
		case "openai-codex":
			// with a proxy configured the same provider id is served by it, so nothing that names openai-codex/<model> has to change
			if (options.codexProxy) return codexProxyProvider(options.codexProxy);
			return (await import("@earendil-works/pi-ai/providers/openai-codex")).openaiCodexProvider();
		case "openai":
			return (await import("@earendil-works/pi-ai/providers/openai")).openaiProvider();
		case "opencode-go":
			return (await import("@earendil-works/pi-ai/providers/opencode-go")).opencodeGoProvider();
		case "antigravity": {
			const { antigravityProvider, loadAntigravity } = await import("./antigravity.ts");
			return antigravityProvider(await loadAntigravity(options));
		}
		default:
			throw new Error(`provider ${id} is not wired yet (add it to loadProvider with its own credential); known: ${PROVIDERS.join(", ")}`);
	}
}

/** Registers every provider the allowed models need, and fails at startup (not mid-job) if one of the models does not exist. */
export async function registerProviders(models: Models, allowed: ModelRef[], options: { stateDir: string; codexProxy?: CodexProxyOptions }): Promise<void> {
	for (const id of new Set(allowed.map((ref) => ref.provider))) models.setProvider(await loadProvider(id, options));
	for (const ref of allowed) {
		if (!models.getModel(ref.provider, ref.modelId)) throw new Error(`model ${ref.provider}/${ref.modelId} is not offered by that provider`);
	}
}
