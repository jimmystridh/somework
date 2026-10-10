// Lets every agent publish its job events (`agent.<slug>.job.started|waiting|finished`): adds `events.publish:agent.<slug>.*` to the
// permissions of each agent principal, keeping everything else it may do. The admin API replaces the whole permission set, so this reads
// the current one first and writes the merge.
// Usage: node scripts/grant-job-events.ts --url https://domain:8443 --key root.key.json [--ca ca.pem] [--only agent/qa --only agent/pi] [--apply]
// Without --apply nothing is changed: it prints what it would do.
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Identity, SomeWorkClient } from "@somework/sdk";
import { topicSlug } from "../packages/agent-kit/src/threads/reporter.ts";

export interface PermissionSet {
	actions?: string[];
	[field: string]: unknown;
}

/** The permission that lets an agent publish its own job events (the domain matches `*` as any run of characters). */
export const jobEventGrant = (agentId: string): string => `events.publish:agent.${topicSlug(agentId)}.*`;

/** The permissions with `grant` among the actions, or undefined when they already hold it. Every other field is kept as it is. */
export function withGrant(permissions: PermissionSet | undefined, grant: string): PermissionSet | undefined {
	const actions = permissions?.actions ?? [];
	if (actions.includes(grant)) return undefined;
	return { ...permissions, actions: [...actions, grant] };
}

interface Principal {
	kind: string;
	id: string;
	status: string;
	permissions?: PermissionSet;
}

export async function grantJobEvents(client: Pick<SomeWorkClient, "get" | "raw">, options: { apply: boolean; only?: string[]; log?: (line: string) => void }): Promise<{ granted: string[]; already: string[] }> {
	const log = options.log ?? console.log;
	const listed = (await client.get("/v1/admin/principals")) as { principals: Principal[] };
	const agents = listed.principals.filter((principal) => principal.kind === "agent" && principal.status === "active" && (!options.only?.length || options.only.includes(principal.id)));
	const granted: string[] = [];
	const already: string[] = [];
	for (const agent of agents) {
		const grant = jobEventGrant(agent.id);
		const merged = withGrant(agent.permissions, grant);
		if (!merged) {
			already.push(agent.id);
			log(`${agent.id}: already has ${grant}`);
			continue;
		}
		if (options.apply) await client.raw("PATCH", `/v1/admin/principals/${agent.kind}/${encodeURIComponent(agent.id)}`, { body: { permissions: merged } });
		granted.push(agent.id);
		log(`${agent.id}: ${options.apply ? "granted" : "would grant"} ${grant}`);
	}
	if (agents.length === 0) log("no active agent principal matched");
	return { granted, already };
}

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { url: { type: "string" }, key: { type: "string" }, ca: { type: "string" }, only: { type: "string", multiple: true }, apply: { type: "boolean" } } });
	if (!values.url || !values.key) throw new Error("usage: grant-job-events.ts --url <domain url> --key <admin key file> [--ca <ca.pem>] [--only <agent id>]... [--apply]");
	const client = new SomeWorkClient({ baseUrl: values.url, identity: Identity.fromFile(values.key), ...(values.ca ? { caFile: values.ca } : {}), requireTls: values.url.startsWith("https:") });
	const { granted } = await grantJobEvents(client, { apply: values.apply === true, ...(values.only ? { only: values.only } : {}) });
	if (!values.apply && granted.length > 0) console.log("dry run: nothing changed; run again with --apply");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
