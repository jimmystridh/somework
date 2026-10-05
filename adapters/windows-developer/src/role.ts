import { InvalidInput, silent, type Log, type RoleHooks } from "@somework/agent-kit";
import { runChecks, type ChecksResult } from "./checks.ts";
import { selectProfiles, type Profiles, type Selection } from "./profiles.ts";

export interface RoleDeps {
	profiles: Profiles;
	/** Literal secrets the service holds; they are removed from the logs of builds and tests. */
	secrets?: string[];
	log?: Log;
}

interface Plan {
	selection: Selection;
}

const BLOCKED_PREFIX = "blocked by checks";

/** Output fields of the card: what was built and tested, which encoding problems were found, and why nothing was pushed. */
export function resultFields(checks: ChecksResult, artifactIds: Map<string, string>): Record<string, unknown> {
	const withLog = (kind: "build" | "test", step: { name: string }) => ({ ...step, ...(artifactIds.has(`${kind}:${step.name}`) ? { logArtifact: artifactIds.get(`${kind}:${step.name}`) } : {}) });
	return {
		...(checks.build ? { build: withLog("build", checks.build) } : {}),
		...(checks.tests.length > 0 ? { tests: checks.tests.map((step) => withLog("test", step)) } : {}),
		...(checks.encoding ? { encoding: { ok: checks.encoding.ok, checked: checks.encoding.checked, violations: checks.encoding.violations.slice(0, 20) } } : {}),
		...(checks.blocked.length > 0 ? { blocked: checks.blocked } : {}),
	};
}

const describe = (checks: ChecksResult): string[] => [
	...(checks.build ? [`Build \`${checks.build.name}\`: ${checks.build.ok ? "passed" : "failed"}`] : []),
	...checks.tests.map((step) => `Tests \`${step.name}\`: ${step.skipped ? "skipped" : step.ok ? "passed" : "failed"}`),
	...(checks.encoding ? [`Encoding check: ${checks.encoding.ok ? `${checks.encoding.checked} modified files preserved` : `${checks.encoding.violations.length} files damaged`}`] : []),
];

/**
 * The role's code, as kit hooks:
 *  - `instruction` validates the build/test selection (names of configured profiles only) and builds the instruction;
 *  - `beforeFinalize` runs the encoding check and the selected profiles in the workspace once the model has finished, and blocks the push
 *    when one of them says so (the task then completes as `blocked`: the work stays in the workspace and the result says why);
 *  - `result` uploads the logs as artifacts and adds `build`, `tests`, `encoding`, `blocked` and `baseSha` to the result;
 *  - `pullRequest` adds the outcome of the checks to the pull request body.
 */
export function createRole(deps: RoleDeps) {
	const log = deps.log ?? silent;
	const plans = new Map<string, Plan>();
	const checked = new Map<string, ChecksResult>();

	const hooks: RoleHooks = {
		instruction(input, { taskId }) {
			const selection = selectProfiles(input, deps.profiles);
			if (typeof input.instruction !== "string") throw new InvalidInput("instruction is required");
			plans.set(taskId, { selection });
			const notes = [
				selection.build ? `after you finish, the service builds with the profile "${selection.build}"` : undefined,
				selection.tests.length > 0 ? `and runs the tests ${selection.tests.map((name) => `"${name}"`).join(", ")}` : undefined,
				"it then commits and pushes the task branch itself; leave your changes in the working tree",
			].filter(Boolean);
			return `${input.instruction}\n\n[service notes] ${notes.join(", ")}.`;
		},

		pullRequest(input, { taskId, instruction }) {
			const checks = checked.get(taskId);
			const summary = checks ? describe(checks) : [];
			return {
				title: String(input.instruction ?? instruction).split("\n")[0]!.slice(0, 72),
				body: [`Opened by the SomeWork Windows developer agent for task ${taskId}.`, ...(summary.length > 0 ? ["", ...summary.map((line) => `- ${line}`)] : [])].join("\n"),
			};
		},

		async beforeFinalize(context) {
			const plan = plans.get(context.taskId);
			if (!plan) return;
			context.onProgress({ message: "running the encoding check, the build and the tests" });
			const checks = await runChecks({ env: context.envFor(context.workspace), workspace: context.workspace, ref: context.baseSha, taskId: context.taskId, selection: plan.selection, profiles: deps.profiles, secrets: deps.secrets, signal: context.signal });
			checked.set(context.taskId, checks);
			log("info", "checks_finished", { taskId: context.taskId, build: checks.build?.ok, tests: checks.tests.length, encodingOk: checks.encoding?.ok, blocked: checks.blocked.length });
			if (checks.blocked.length > 0) return { blocked: { reason: `${BLOCKED_PREFIX}: ${checks.blocked.join("; ")}`.slice(0, 400), details: checks.blocked } };
		},

		async result(base, context) {
			const checks = checked.get(context.taskId);
			if (!checks) return;
			const artifacts: unknown[] = [];
			const ids = new Map<string, string>();
			for (const [key, file] of checks.logs) {
				try {
					const artifact = await context.client.uploadArtifact({ filename: file.filename, mediaType: "text/plain", bytes: file.bytes, sourceTaskId: context.taskId });
					artifacts.push(artifact);
					if (artifact?.artifactId) ids.set(key, artifact.artifactId);
				} catch (error) {
					log("warn", "log_upload_failed", { taskId: context.taskId, step: key, error: error instanceof Error ? error.message : String(error) });
				}
			}
			return { result: { ...base, baseSha: context.baseSha, ...resultFields(checks, ids) }, artifacts };
		},

		onSettled(taskId) {
			plans.delete(taskId);
			checked.delete(taskId);
		},
	};

	return { hooks, pending: () => ({ plans: plans.size, checked: checked.size }) };
}
