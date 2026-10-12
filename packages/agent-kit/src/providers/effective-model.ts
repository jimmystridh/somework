import { getSupportedThinkingLevels, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { isAllowed, type ModelRef } from "./allowlist.ts";
import type { Effort, ModelChoice } from "../setup/contract.ts";

/** Lowest first: the agent's environment, the fleet's document, the agent's own override, and one job's `input.model`. */
export type ModelLayer = "env" | "fleet" | "override" | "job";

export interface ModelLayers {
	env: ModelRef;
	fleet?: ModelChoice;
	override?: ModelChoice;
	job?: ModelChoice;
}

/** Where each field of an effective model comes from. `effort` is absent when no layer sets one. */
export interface ModelSources {
	provider: ModelLayer;
	modelId: ModelLayer;
	effort?: ModelLayer;
}

export type ModelResolution = { ok: true; model: ModelRef; sources: ModelSources } | { ok: false; reason: string };

/** The reason a complete model cannot be used, or `undefined` when it can. */
export type ModelCheck = (model: ModelRef) => string | undefined;

const LAYER_NAMES: Record<ModelLayer, string> = { env: "the agent's environment", fleet: "the fleet's document", override: "the agent's override", job: "the job" };

export const describeModel = (model: ModelRef): string => `${model.provider}/${model.modelId}${model.effort ? ` with effort ${model.effort}` : ""}`;

function describeSources(sources: ModelSources): string {
	const parts = [`provider from ${LAYER_NAMES[sources.provider]}`, `model from ${LAYER_NAMES[sources.modelId]}`, ...(sources.effort ? [`effort from ${LAYER_NAMES[sources.effort]}`] : [])];
	return parts.join(", ");
}

/**
 * Builds the model field by field: the environment's complete default, then each higher layer replaces the fields it sets.
 * The result must pass `check`; else the resolution fails with a reason that says which layers the pieces came from.
 */
export function resolveModel(layers: ModelLayers, check: ModelCheck): ModelResolution {
	let model: ModelRef = { provider: layers.env.provider, modelId: layers.env.modelId, ...(layers.env.effort ? { effort: layers.env.effort } : {}) };
	const sources: ModelSources = { provider: "env", modelId: "env", ...(layers.env.effort ? { effort: "env" } : {}) };
	for (const [layer, choice] of [["fleet", layers.fleet], ["override", layers.override], ["job", layers.job]] as const) {
		if (!choice) continue;
		if (choice.provider !== undefined) {
			model = { ...model, provider: choice.provider };
			sources.provider = layer;
		}
		if (choice.modelId !== undefined) {
			model = { ...model, modelId: choice.modelId };
			sources.modelId = layer;
		}
		if (choice.effort !== undefined) {
			model = { ...model, effort: choice.effort };
			sources.effort = layer;
		}
	}
	const refused = check(model);
	if (refused) return { ok: false, reason: `${refused} (the model is ${describeModel(model)}: ${describeSources(sources)})` };
	return { ok: true, model, sources };
}

/** The part of a registry entry that decides which efforts a model takes. */
export interface RegistryModel {
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

export interface ModelRules {
	/** The default model is always part of it. */
	allowed: readonly ModelRef[];
	find(provider: string, modelId: string): RegistryModel | undefined;
}

/** What the registry says a model takes: no reasoning means `off` only; a level mapped to null is not supported. */
export const supportedEfforts = (model: RegistryModel): Effort[] => getSupportedThinkingLevels(model as never);

/** The agent's own check of a complete model: on the allowlist, offered by its provider, and taking the effort. */
export function modelCheck(rules: ModelRules): ModelCheck {
	return (wanted) => {
		const name = `${wanted.provider}/${wanted.modelId}`;
		if (!isAllowed(rules.allowed, wanted)) return `the model ${name} is not one of this agent's allowed models (${rules.allowed.map((ref) => `${ref.provider}/${ref.modelId}`).join(", ")})`;
		const entry = rules.find(wanted.provider, wanted.modelId);
		if (!entry) return `the model ${name} is not offered by its provider`;
		if (wanted.effort !== undefined) {
			const supported = supportedEfforts(entry);
			if (!supported.includes(wanted.effort)) return `the model ${name} does not support the effort ${wanted.effort} (it supports ${supported.join(", ")})`;
		}
		return undefined;
	};
}
