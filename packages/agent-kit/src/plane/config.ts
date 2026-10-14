/**
 * Tickets in Plane (see docs/AGENT_FLEET.md, "Plane tickets"): four narrow tools fixed to one project, for the agents that file and read tickets.
 * Off unless `PLANE_BASE_URL` is set; then the key file, the workspace and the project are required.
 */
export const DEFAULT_PLANE_LABELS = ["feature", "bug", "product-feedback"] as const;

export interface ResolvedPlane {
	enabled: boolean;
	baseUrl?: string;
	apiKeyFile?: string;
	workspace?: string;
	projectId?: string;
	caFile?: string;
	labels: string[];
}

const WORKSPACE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL = /^[a-z][a-z0-9-]{0,39}$/;

export function resolvePlane(env: NodeJS.ProcessEnv = process.env): ResolvedPlane {
	const baseUrl = env.PLANE_BASE_URL?.trim();
	if (!baseUrl) return { enabled: false, labels: [...DEFAULT_PLANE_LABELS] };
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		throw new Error("PLANE_BASE_URL must be an http or https address");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("PLANE_BASE_URL must be an http or https address");
	if (!env.PLANE_API_KEY_FILE) throw new Error("PLANE_BASE_URL needs PLANE_API_KEY_FILE (the API key of the agent's own Plane user)");
	const workspace = env.PLANE_WORKSPACE_SLUG?.trim() ?? "";
	if (!WORKSPACE.test(workspace)) throw new Error("PLANE_BASE_URL needs PLANE_WORKSPACE_SLUG (the workspace's slug, as in its address)");
	const projectId = env.PLANE_PROJECT_ID?.trim() ?? "";
	if (!PROJECT_ID.test(projectId)) throw new Error("PLANE_BASE_URL needs PLANE_PROJECT_ID (the project's id, a UUID)");
	const labels = env.PLANE_LABELS === undefined ? [...DEFAULT_PLANE_LABELS] : env.PLANE_LABELS.split(",").map((label) => label.trim()).filter(Boolean);
	if (labels.length === 0 || !labels.every((label) => LABEL.test(label))) throw new Error("PLANE_LABELS must be a comma-separated list of label names (lowercase letters, digits, hyphens)");
	return { enabled: true, baseUrl: parsed.origin + parsed.pathname.replace(/\/+$/, ""), apiKeyFile: env.PLANE_API_KEY_FILE, workspace, projectId: projectId.toLowerCase(), ...(env.PLANE_CA_FILE ? { caFile: env.PLANE_CA_FILE } : {}), labels };
}
