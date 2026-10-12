/** The part of the domain client the directory reads with. */
export interface DirectoryClient {
	get(path: string): Promise<any>;
	post(path: string, body: unknown): Promise<any>;
}

export interface DirectoryCapability {
	id: string;
	version: string;
	name?: string;
	description?: string;
	sideEffects?: string;
}

export interface DirectoryAgent {
	agentId: string;
	displayName?: string;
	description?: string;
	availability?: string;
	capabilities: DirectoryCapability[];
	/** Why a search found it, when it did. */
	why?: string[];
}

export const DIRECTORY_SEARCH_LIMIT = 20;

const clean = (value: unknown, max: number): string | undefined => {
	if (typeof value !== "string") return undefined;
	// eslint-disable-next-line no-control-regex
	const flat = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
	return flat === "" ? undefined : flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const availabilityOf = (value: any): string | undefined => clean(typeof value === "string" ? value : value?.state, 20);

function fromEntry(entry: any): DirectoryAgent | undefined {
	const card = entry?.agentCard ?? {};
	const agentId = clean(card.agentId ?? entry?.agentId, 120);
	if (!agentId) return undefined;
	return {
		agentId,
		displayName: clean(card.displayName, 80),
		description: clean(card.description, 400),
		availability: availabilityOf(entry.availability),
		capabilities: (Array.isArray(card.capabilities) ? card.capabilities : []).flatMap((capability: any) => {
			const id = clean(capability?.id, 80);
			if (!id) return [];
			return [{ id, version: clean(String(capability.version ?? ""), 20) ?? "", name: clean(capability.name, 80), description: clean(capability.description, 240), sideEffects: clean(capability.sideEffects, 20) }];
		}),
	};
}

/** Who else is in the domain and what they advertise: the same catalog the manager reads, read only. */
export class AgentDirectory {
	readonly #client: DirectoryClient;
	readonly #selfId: string;

	constructor(client: DirectoryClient, selfId: string) {
		this.#client = client;
		this.#selfId = selfId;
	}

	async list(): Promise<DirectoryAgent[]> {
		const response = await this.#client.get("/v1/catalog/entries");
		return (Array.isArray(response?.entries) ? response.entries : []).map(fromEntry).filter((agent: DirectoryAgent | undefined): agent is DirectoryAgent => agent !== undefined);
	}

	/** The agents whose cards match the words, best first, each with only the capabilities that matched. */
	async search(query: string, limit: number): Promise<DirectoryAgent[]> {
		const found = await this.#client.post("/v1/catalog/search", { query, limit: Math.min(Math.max(1, Math.floor(limit)), DIRECTORY_SEARCH_LIMIT) });
		const matches: any[] = Array.isArray(found?.matches) ? found.matches : [];
		if (matches.length === 0) return [];
		const known = new Map((await this.list()).map((agent) => [agent.agentId, agent]));
		const seen = new Set<string>();
		const agents: DirectoryAgent[] = [];
		for (const match of matches) {
			const agentId = clean(match?.agentId, 120);
			if (!agentId || seen.has(agentId)) continue;
			seen.add(agentId);
			const card = known.get(agentId);
			const matched = new Set((Array.isArray(match.matchedCapabilities) ? match.matchedCapabilities : []).map((ref: any) => `${ref?.id}@${ref?.version}`));
			const capabilities = (card?.capabilities ?? []).filter((capability) => matched.size === 0 || matched.has(`${capability.id}@${capability.version}`));
			const why = (Array.isArray(match.why) ? match.why : []).map((line: unknown) => clean(line, 120)).filter((line: string | undefined): line is string => line !== undefined).slice(0, 3);
			agents.push({ agentId, displayName: card?.displayName, description: card?.description, availability: availabilityOf(match.availability) ?? card?.availability, capabilities, ...(why.length > 0 ? { why } : {}) });
		}
		return agents;
	}

	describe(agents: readonly DirectoryAgent[]): string {
		if (agents.length === 0) return "No agent matches.";
		return agents
			.map((agent) => {
				const head = `${agent.agentId}${agent.agentId === this.#selfId ? " (you)" : ""}${agent.availability ? ` [${agent.availability}]` : ""}${agent.displayName ? ` - ${agent.displayName}` : ""}`;
				const lines = agent.capabilities.map((capability) => `  ${capability.id}@${capability.version}${capability.sideEffects ? ` (${capability.sideEffects})` : ""}${capability.name ? `: ${capability.name}` : ""}`);
				return [head, ...(agent.description ? [`  ${agent.description}`] : []), ...lines, ...(agent.why ? [`  matched: ${agent.why.join("; ")}`] : [])].join("\n");
			})
			.join("\n\n");
	}
}
