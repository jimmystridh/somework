import { SomeWorkError, type RuleSpec, type RuleView } from "@somework/sdk";
import { hasChanges, plan as makePlan, type Change, type Plan } from "./plan.ts";
import type { LoadedRule } from "./rules.ts";

/** What apply needs from the domain; `SomeWorkClient` provides it (see `clientApi`). */
export interface RulesApi {
	list(): Promise<RuleView[]>;
	put(name: string, spec: RuleSpec): Promise<RuleView>;
	remove(name: string): Promise<void>;
	pause(name: string): Promise<RuleView>;
	resume(name: string): Promise<RuleView>;
}

export const clientApi = (client: { listRules(): Promise<RuleView[]>; putRule(name: string, spec: RuleSpec): Promise<RuleView>; deleteRule(name: string): Promise<void>; pauseRule(name: string): Promise<RuleView>; resumeRule(name: string): Promise<RuleView> }): RulesApi => ({
	list: () => client.listRules(),
	put: (name, spec) => client.putRule(name, spec),
	remove: (name) => client.deleteRule(name),
	pause: (name) => client.pauseRule(name),
	resume: (name) => client.resumeRule(name),
});

export interface ApplyOptions {
	dryRun?: boolean;
	/** Delete the domain's rules that no file declares (default true). */
	prune?: boolean;
	/** Refuse to delete more than this many rules in one apply unless `allowDeleteMany` (default 5). */
	maxDeletes?: number;
	allowDeleteMany?: boolean;
	/** Allow an apply with no rule files at all (it would delete everything). */
	allowEmpty?: boolean;
}

export interface ApplyResult {
	plan: Plan;
	applied: Change[];
	failures: { name: string; action: string; error: string }[];
	converged: boolean;
}

export class ApplyRefused extends Error {
	override readonly name = "ApplyRefused";
}

export function refuseIfRisky(plan: Plan, desired: LoadedRule[], live: RuleView[], options: ApplyOptions): void {
	if (desired.length === 0 && live.length > 0 && !options.allowEmpty) throw new ApplyRefused(`no rule files were found but the domain has ${live.length} rule(s); applying would delete them all (pass --allow-empty if that is intended)`);
	const limit = options.maxDeletes ?? 5;
	if (plan.counts.delete > limit && !options.allowDeleteMany) throw new ApplyRefused(`applying would delete ${plan.counts.delete} rules (limit ${limit}); pass --allow-delete-many to confirm`);
}

/** Creates and replaces first, then corrects pause state, then deletes: a failure midway never leaves a rule's replacement missing. */
export async function apply(api: RulesApi, desired: LoadedRule[], options: ApplyOptions = {}): Promise<ApplyResult> {
	const live = await api.list();
	const plan = makePlan(desired, live, { prune: options.prune });
	refuseIfRisky(plan, desired, live, options);
	if (options.dryRun) return { plan, applied: [], failures: [], converged: !hasChanges(plan) };

	const applied: Change[] = [];
	const failures: ApplyResult["failures"] = [];
	const attempt = async (change: Change, work: () => Promise<void>) => {
		try {
			await work();
			applied.push(change);
		} catch (error) {
			failures.push({ name: change.name, action: change.action, error: error instanceof Error ? error.message : String(error) });
		}
	};

	const order = (action: Change["action"]) => plan.changes.filter((change) => change.action === action);
	for (const change of [...order("create"), ...order("replace")]) {
		await attempt(change, async () => {
			const result = await api.put(change.name, change.body!);
			const wanted = change.body!.status!;
			if (result.status !== wanted) await (wanted === "paused" ? api.pause(change.name) : api.resume(change.name));
		});
	}
	for (const change of order("pause")) await attempt(change, async () => void (await api.pause(change.name)));
	for (const change of order("resume")) await attempt(change, async () => void (await api.resume(change.name)));
	for (const change of order("delete")) {
		await attempt(change, async () => {
			try {
				await api.remove(change.name);
			} catch (error) {
				if (!(error instanceof SomeWorkError && error.status === 404)) throw error;
			}
		});
	}

	const after = makePlan(desired, await api.list(), { prune: options.prune });
	return { plan, applied, failures, converged: failures.length === 0 && !hasChanges(after) };
}
