export interface ModelRef {
	provider: string;
	modelId: string;
}

export const sameModel = (a: ModelRef, b: ModelRef): boolean => a.provider === b.provider && a.modelId === b.modelId;

export const isAllowed = (allowed: readonly ModelRef[], wanted: ModelRef): boolean => allowed.some((ref) => sameModel(ref, wanted));

/** Parses `provider/model-id` (the model id may itself contain slashes), comma separated. */
export function parseModelList(text: string | undefined): ModelRef[] {
	const refs: ModelRef[] = [];
	for (const entry of (text ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
		const slash = entry.indexOf("/");
		if (slash <= 0 || slash === entry.length - 1) throw new Error(`PI_ALLOWED_MODELS entry "${entry}" must look like provider/model-id`);
		refs.push({ provider: entry.slice(0, slash), modelId: entry.slice(slash + 1) });
	}
	return refs;
}

/** The configured default is always allowed; everything else must be listed explicitly. */
export function allowlist(defaultModel: ModelRef, extra: ModelRef[]): ModelRef[] {
	return [defaultModel, ...extra.filter((ref) => !sameModel(ref, defaultModel))];
}
