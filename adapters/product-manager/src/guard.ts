import { classifyCommand } from "@somework/agent-kit";
import { defineExtension, hook, ToolTask, type Extension } from "@earendil-works/pi-durable";

/** The most of a ticket's description the requester is shown in the approval question, and so the most `plane_create` may carry through it. */
export const MAX_APPROVED_DESCRIPTION = 2800;

/** `toolApprovals.plane_create`: the question the requester answers is the ticket itself, so what is filed is what was approved. */
export function filingApproval(args: Record<string, unknown>): string | undefined {
	const title = typeof args.title === "string" ? args.title.trim() : "";
	const description = typeof args.description === "string" ? args.description.trim() : "";
	const kind = typeof args.kind === "string" ? args.kind : "?";
	const part = typeof args.part === "string" && args.part !== "" ? `, part ${args.part}` : "";
	const parent = typeof args.parent === "string" && args.parent !== "" ? `, under ${args.parent}` : "";
	return `file this ticket in Plane (${kind}${part}${parent}): ${title.slice(0, 200)}\n\n${description.slice(0, MAX_APPROVED_DESCRIPTION)}`;
}

/** Why a call must not run at all, whoever answers; undefined when the gate may decide. */
export function refusal(tool: string, args: Record<string, unknown>): string | undefined {
	if (tool === "bash") {
		const command = typeof args.command === "string" ? args.command : "";
		return classifyCommand(command) === "allow" ? undefined : "refused: the product manager only reads. Use plain inspection (cat, ls, ag, git log/show/diff) or ask the developer agents";
	}
	if (tool === "plane_create") {
		const description = typeof args.description === "string" ? args.description.trim() : "";
		return description.length > MAX_APPROVED_DESCRIPTION ? `refused: the description is ${description.length} characters; the requester approves the whole text, so keep it to ${MAX_APPROVED_DESCRIPTION} (put detail into a plane_comment after filing)` : undefined;
	}
	return undefined;
}

/** The part of the rule the approval gate cannot express: a command that is not inspection, or a ticket too long to show, is stopped before anybody is asked. */
export function createGuard(): Extension<any> {
	return defineExtension({
		name: "product-manager-guard",
		hooks: [
			hook(ToolTask, {
				beforeTool: (call: { name: string; arguments: Record<string, unknown> }) => {
					const reason = refusal(call.name, call.arguments);
					return reason ? { block: reason } : undefined;
				},
			}),
		],
	});
}
