import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import type { Log } from "@somework/agent-kit";
import { createFetch, type Fetch } from "../http.ts";
import type { ClusterSettings } from "../settings.ts";
import { CI_TOOLS, createCiTools, type CiToolOptions } from "./ci.ts";
import { createDeployStatus, DEPLOY_STATUS_TOOL } from "./deploy-status.ts";
import { createGitPush, GIT_PUSH_TOOL } from "./git-push.ts";
import { approvedByGate, createHostExec, HOST_EXEC_TOOL, type ApprovalApi, type Spawn } from "./host-exec.ts";

/** The tools this role adds to the kit's: `host_exec`, `git_push`, `ci_pipelines`, `ci_logs` and `deploy_status`. The logs and metrics are the kit's observe tools. */
export const CLUSTER_TOOLS = [HOST_EXEC_TOOL, GIT_PUSH_TOOL, ...CI_TOOLS, DEPLOY_STATUS_TOOL] as const;

export interface ClusterToolOptions {
	settings: ClusterSettings;
	/** Everything the service holds that must never reach the model: tokens and key files. */
	secrets?: () => string[];
	spawn?: Spawn;
	fetch?: Fetch;
	ci?: CiToolOptions["client"];
	/** The credential for the organisation repository, when the service has one. */
	gitToken?: () => Promise<string>;
	approved?: (api: ApprovalApi, context: unknown) => Promise<boolean>;
	log?: Log;
	boundary?: () => string;
}

export function createClusterTools(options: ClusterToolOptions): { extension: Extension<any>; toolNames: string[] } {
	const common = { ...(options.secrets ? { secrets: options.secrets } : {}), ...(options.log ? { log: options.log } : {}) };
	const withBoundary = { ...common, ...(options.boundary ? { boundary: options.boundary } : {}) };
	const tools = [
		createHostExec({ settings: options.settings, ...withBoundary, ...(options.spawn ? { spawn: options.spawn } : {}), approved: options.approved ?? approvedByGate }),
		createGitPush({ settings: options.settings, ...common, ...(options.gitToken ? { token: options.gitToken } : {}) }),
		...createCiTools({ client: options.ci, ...withBoundary }),
		createDeployStatus({ settings: options.settings, ...withBoundary, fetch: options.fetch ?? createFetch(options.settings.agentsCaFile ? { caFile: options.settings.agentsCaFile } : {}) }),
	];
	return { extension: defineExtension({ name: "cluster-dev", tools }), toolNames: tools.map((tool) => tool.name) };
}

export { CI_TOOLS, DEPLOY_STATUS_TOOL, GIT_PUSH_TOOL, HOST_EXEC_TOOL };
