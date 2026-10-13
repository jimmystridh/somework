import { defineExtension, hook, ToolTask, type Extension } from "@earendil-works/pi-durable";
import { classifyCommand, secretPathReason } from "./classifier/index.ts";
import { classifyContext, loadSettings, type ClusterSettings } from "./settings.ts";
import { MAX_CONFIRMABLE_COMMAND } from "./tools/host-exec.ts";

export { hostExecApproval } from "./tools/host-exec.ts";

let cached: ClusterSettings | undefined;

/** The settings of this process, read from the environment once; for the profile's approval functions, which are built before the service is. */
export const currentSettings = (): ClusterSettings => (cached ??= loadSettings(process.env));

const shown = (command: string): string => (command.length > MAX_CONFIRMABLE_COMMAND ? `${command.slice(0, MAX_CONFIRMABLE_COMMAND)}...` : command);

/** `toolApprovals.bash`: the sandbox's own commands go through the same classifier as the ones sent to a host. A summary when the owner must say yes. */
export function bashApproval(args: Record<string, unknown>, settings: ClusterSettings = currentSettings()): string | undefined {
	const command = typeof args.command === "string" ? args.command : "";
	const verdict = classifyCommand(command, classifyContext(settings));
	if (!verdict.destructive || verdict.forbidden || command.length > MAX_CONFIRMABLE_COMMAND) return undefined;
	return `bash: ${shown(command)} [${verdict.category}: ${verdict.reason}]`;
}

/**
 * `toolApprovals` of `read`, `write` and `edit`: these tools only work in the sandbox, which holds no secrets and has no way into the cluster, so nothing is
 * asked, unless the deployment sets `CLUSTER_DEV_ASK_IN_SANDBOX=1`: then a file that holds secrets is not read or changed without the owner.
 */
export function fileApproval(tool: "read" | "write" | "edit", args: Record<string, unknown>, settings: ClusterSettings = currentSettings()): string | undefined {
	if (!settings.askInSandbox) return undefined;
	const path = typeof args.path === "string" ? args.path : "";
	const reason = secretPathReason(path);
	return reason ? `${tool}: ${path.slice(0, 200)} [secrets: ${reason}]` : undefined;
}

/** Why a sandbox command must not run at all, whatever the owner says; undefined when the gate may decide. */
export function refusal(tool: string, args: Record<string, unknown>, settings: ClusterSettings): string | undefined {
	if (tool !== "bash") return undefined;
	const command = typeof args.command === "string" ? args.command : "";
	const verdict = classifyCommand(command, classifyContext(settings));
	if (verdict.forbidden) return `refused: ${verdict.reason}. This is never allowed.`;
	if (verdict.destructive && command.length > MAX_CONFIRMABLE_COMMAND) return `refused: this command is destructive (${verdict.reason}) and too long to show the owner for confirmation (${command.length} characters, at most ${MAX_CONFIRMABLE_COMMAND}). Split it up.`;
	return undefined;
}

/**
 * The part of the rule the approval gate cannot express: the gate only asks, so a command that is never allowed (a push to a remote that is
 * not the organisation's) or too long to confirm is stopped here before anybody is asked. `host_exec` makes the same checks itself.
 */
export function createGuard(settings: ClusterSettings): Extension<any> {
	return defineExtension({
		name: "cluster-dev-guard",
		hooks: [
			hook(ToolTask, {
				beforeTool: (call: { name: string; arguments: Record<string, unknown> }) => {
					const reason = refusal(call.name, call.arguments, settings);
					return reason ? { block: reason } : undefined;
				},
			}),
		],
	});
}
