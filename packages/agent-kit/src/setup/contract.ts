import { createHash } from "node:crypto";

/**
 * The wire contract between Operations and an agent (ADR 0004). Operations sends a `chat.notice` message from the service
 * principal `operations`, addressed to the agent, with `triggerMode: "directed"`, the labels below and the JSON document as an
 * attachment (`application/json`). The agent checks the sender, the label and the attachment's SHA-256, applies the document as a
 * whole (the latest revision wins; older or equal revisions are acknowledged and ignored) and answers with a `chat.notice` to the
 * sender carrying `setup.ack`. The agent also reports what it has applied in `/profile` (`setup`), which Operations polls.
 *
 * The domain allows a `chat.notice` no trigger mode but `never` (verified against the real domain: `directed` is a 422 `trigger_not_allowed`), so a
 * notice does not wake the agent: it finds it in its inbox at the next sweep (at most a minute). To apply at once Operations sends the same labels
 * and attachment as a `chat.message` with `triggerMode: "directed"`; the agent takes either type from `service:operations`. The agent's own `setup.ack`
 * is a `chat.notice` with `triggerMode: "never"`, which Operations reads from its inbox.
 */

export const SETUP_SCHEMA = 1;
export const OPERATIONS_PRINCIPAL = { kind: "service", id: "operations" } as const;

/** Labels on the message that carries a document. `setup.kind` is `override` or `limits`. */
export const SETUP_LABELS = { kind: "setup.kind", revision: "setup.revision", sha256: "setup.sha256", ack: "setup.ack", status: "setup.status" } as const;

export type SetupKind = "override" | "limits";

export const MCP_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface ApprovalPatternSetting {
	/** A regular expression tested against a bash command. */
	pattern: string;
	reason: string;
}

export interface LibrarySkill {
	name: string;
	/** The version Operations keeps for the skill: a number that grows with every edit. */
	version: number;
	description: string;
	/** The whole `SKILL.md`. */
	content: string;
	sha256: string;
}

/** How an MCP server that runs locally is obtained on one operating system; the file is fixed by version and checksum. */
export interface McpDownload {
	url: string;
	sha256: string;
	/** `none` (the download is the executable), `zip` or `tar.gz`. */
	archive: "none" | "zip" | "tar.gz";
	/** The executable's path inside the archive, or its file name when `archive` is `none`. */
	executable: string;
}

/** One enabled catalog entry as an agent receives it. The shape follows Pi's `mcpServers` entries, with what the kit also needs. */
export interface McpEntry {
	name: string;
	description?: string;
	transport: "stdio" | "http";
	/** stdio: the command, or `${LOCAL}` to run the downloaded executable; http: absent. */
	command?: string;
	args?: string[];
	/** Values may hold `${SECRET_NAME}`; a secret is read from the agent's own environment and never sent by Operations. */
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	/** Names of the secrets the entry needs; the agent rejects the document when its host lacks one. */
	secrets?: string[];
	/** `ask` sends every call of the server through the agent's approval, `never` allows it, `writes` asks for calls whose tool is not read-only. */
	approval: "ask" | "never" | "writes";
	/** Per operating system (`linux`, `windows`, `darwin`) for a server that must be fetched. */
	downloads?: Record<string, McpDownload>;
	timeoutSeconds?: number;
}

export interface SetupOverride {
	schema: typeof SETUP_SCHEMA;
	kind: "override";
	agent: string;
	revision: number;
	savedBy: string;
	savedAt: string;
	/** Appended to the role's built-in prompt. */
	instructions?: string;
	/** True keeps the fleet's global prompt out of this agent's prompt. */
	disableGlobalPrompt?: boolean;
	model?: { provider: string; modelId: string };
	/** When present, replaces the role's own list of commands that need approval. */
	approvalPatterns?: ApprovalPatternSetting[];
	skills: {
		/** Repository skills the agent may use; absent keeps the role's list. */
		repository?: string[];
		library: LibrarySkill[];
		/** Differences from a repository skill, by skill name. */
		overlays: Record<string, string>;
	};
	mcp: McpEntry[];
}

export interface FleetLimits {
	schema: typeof SETUP_SCHEMA;
	kind: "limits";
	revision: number;
	savedBy: string;
	savedAt: string;
	maxTokensCap: number;
	maxMinutesCap: number;
	dailyTokenLimit: number;
	budgetRaiseCeiling: number;
	/** The text every agent adds after its role's prompt; absent means the built-in default, empty means none. */
	globalPrompt?: string;
}

/** What an agent reports of its applied setup. */
export interface SetupStatus {
	override: { revision: number; hash: string; appliedAt: string } | null;
	limits: { revision: number; appliedAt: string } | null;
	/** The last document that was refused, with the reason. Cleared by the next one that applies. */
	rejected?: { kind: SetupKind; revision: number; reason: string; at: string };
}

/** What `/profile` carries under `setup`: the status above plus what the editor needs to show next to the role's defaults. Free of secrets. */
export interface SetupReport extends SetupStatus {
	defaults: {
		/** The role's own commands that need approval, as the role ships them. */
		approvalPatterns: ApprovalPatternSetting[];
		/** The repository skills the role (or the deployment) allows. */
		repositorySkills: string[];
		model: { provider: string; modelId: string };
		allowedModels: { provider: string; modelId: string }[];
	};
	/** What is in effect now: the defaults with the applied override on top. */
	effective: {
		instructions?: { sha256: string; characters: number; text: string };
		model: { provider: string; modelId: string };
		/** The global prompt in effect: from the fleet, the built-in default, or switched off for this agent or for the fleet. */
		globalPrompt: { source: "fleet" | "default" | "off"; sha256?: string; characters?: number; text?: string };
		approvalPatterns: ApprovalPatternSetting[];
		repositorySkills: string[];
		librarySkills: { name: string; version: number }[];
		/** `error` names why an entry could not be set up when the agent restarted (a secret or a download gone); it is then not offered. */
		mcp: { name: string; transport: "stdio" | "http"; approval: "ask" | "never" | "writes"; error?: string }[];
	};
}

export const MAX_INSTRUCTIONS_CHARS = 16_000;
export const MAX_GLOBAL_PROMPT_CHARS = 16_000;
export const MAX_SKILL_BYTES = 64 * 1024;
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.length <= max ? value : undefined);
const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);
const words = (value: unknown): string[] | undefined => (Array.isArray(value) && value.every((item) => typeof item === "string" && item.length <= 500) ? (value as string[]) : undefined);

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** A stable fingerprint of a document, for `/profile` and the acknowledgement. */
export const documentHash = (document: SetupOverride | FleetLimits): string => sha256Hex(JSON.stringify(document));

export class SetupRejected extends Error {}

function fail(reason: string): never {
	throw new SetupRejected(reason);
}

function validatePattern(entry: unknown): ApprovalPatternSetting {
	if (!isRecord(entry)) fail("an approval pattern is not an object");
	const pattern = text(entry.pattern, 300);
	const reason = text(entry.reason, 200);
	if (!pattern || !reason) fail("an approval pattern needs a pattern (at most 300 characters) and a reason");
	try {
		new RegExp(pattern);
	} catch {
		fail(`the approval pattern ${pattern.slice(0, 60)} is not a regular expression`);
	}
	return { pattern, reason };
}

function validateDownload(os: string, entry: unknown): McpDownload {
	if (!isRecord(entry)) fail(`the download for ${os} is not an object`);
	const url = text(entry.url, 1000);
	const sha256 = text(entry.sha256, 64);
	const archive = entry.archive;
	const executable = text(entry.executable, 300);
	if (!url || !/^https:\/\//.test(url)) fail(`the download for ${os} needs an https url`);
	if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) fail(`the download for ${os} needs a SHA-256`);
	if (archive !== "none" && archive !== "zip" && archive !== "tar.gz") fail(`the download for ${os} has an unknown archive kind`);
	if (!executable || executable.startsWith("/") || executable.includes("..")) fail(`the download for ${os} names an executable outside its folder`);
	return { url, sha256, archive, executable };
}

function validateMcp(entry: unknown): McpEntry {
	if (!isRecord(entry)) fail("an MCP entry is not an object");
	const name = text(entry.name, 40);
	if (!name || !MCP_NAME.test(name)) fail("an MCP entry has an invalid name");
	const transport = entry.transport;
	if (transport !== "stdio" && transport !== "http") fail(`the MCP entry ${name} has an unknown transport`);
	const approval = entry.approval;
	if (approval !== "ask" && approval !== "never" && approval !== "writes") fail(`the MCP entry ${name} has an unknown approval setting`);
	const result: McpEntry = { name, transport, approval };
	if (entry.description !== undefined) result.description = text(entry.description, 300) ?? fail(`the MCP entry ${name} has a long description`);
	if (transport === "stdio") {
		result.command = text(entry.command, 300) ?? fail(`the MCP entry ${name} needs a command`);
		if (entry.args !== undefined) result.args = words(entry.args) ?? fail(`the MCP entry ${name} has invalid arguments`);
	} else {
		const url = text(entry.url, 1000);
		if (!url || !/^https?:\/\//.test(url)) fail(`the MCP entry ${name} needs an http(s) url`);
		result.url = url;
	}
	for (const field of ["env", "headers"] as const) {
		const value = entry[field];
		if (value === undefined) continue;
		if (!isRecord(value) || !Object.values(value).every((item) => typeof item === "string" && item.length <= 2000)) fail(`the MCP entry ${name} has invalid ${field}`);
		result[field] = value as Record<string, string>;
	}
	if (entry.secrets !== undefined) {
		const secrets = words(entry.secrets);
		if (!secrets || !secrets.every((secret) => SECRET_NAME.test(secret))) fail(`the MCP entry ${name} names an invalid secret`);
		result.secrets = secrets;
	}
	if (entry.downloads !== undefined) {
		if (!isRecord(entry.downloads)) fail(`the MCP entry ${name} has invalid downloads`);
		result.downloads = Object.fromEntries(Object.entries(entry.downloads).map(([os, download]) => [os, validateDownload(os, download)]));
	}
	if (entry.timeoutSeconds !== undefined) result.timeoutSeconds = positive(entry.timeoutSeconds) ?? fail(`the MCP entry ${name} has an invalid timeout`);
	return result;
}

function validateSkill(entry: unknown): LibrarySkill {
	if (!isRecord(entry)) fail("a library skill is not an object");
	const name = text(entry.name, 64);
	if (!name || !SKILL_NAME.test(name)) fail("a library skill has an invalid name");
	const content = typeof entry.content === "string" && Buffer.byteLength(entry.content) <= MAX_SKILL_BYTES ? entry.content : fail(`the library skill ${name} is missing or larger than ${MAX_SKILL_BYTES} bytes`);
	const sha256 = text(entry.sha256, 64);
	if (sha256 !== sha256Hex(content)) fail(`the library skill ${name} does not match its checksum`);
	return { name, version: positive(entry.version) ?? fail(`the library skill ${name} has no version`), description: text(entry.description, 500) ?? "", content, sha256 };
}

/** Parses and checks a setup override; throws `SetupRejected` with a reason an operator can read. */
export function parseOverride(raw: unknown, agent: string): SetupOverride {
	if (!isRecord(raw) || raw.schema !== SETUP_SCHEMA || raw.kind !== "override") fail("not a setup override this agent understands");
	if (raw.agent !== agent) fail(`the override is for ${String(raw.agent)}, not for ${agent}`);
	const revision = positive(raw.revision) ?? fail("the override has no revision");
	const override: SetupOverride = {
		schema: SETUP_SCHEMA,
		kind: "override",
		agent,
		revision,
		savedBy: text(raw.savedBy, 200) ?? "",
		savedAt: text(raw.savedAt, 40) ?? "",
		skills: { library: [], overlays: {} },
		mcp: [],
	};
	if (raw.instructions !== undefined && raw.instructions !== null) override.instructions = text(raw.instructions, MAX_INSTRUCTIONS_CHARS) ?? fail(`the instructions are longer than ${MAX_INSTRUCTIONS_CHARS} characters`);
	if (raw.disableGlobalPrompt !== undefined && raw.disableGlobalPrompt !== null) {
		if (typeof raw.disableGlobalPrompt !== "boolean") fail("disableGlobalPrompt must be true or false");
		override.disableGlobalPrompt = raw.disableGlobalPrompt;
	}
	if (raw.model !== undefined && raw.model !== null) {
		const model = raw.model;
		if (!isRecord(model) || !text(model.provider, 80) || !text(model.modelId, 200)) fail("the model needs a provider and a model id");
		override.model = { provider: model.provider as string, modelId: model.modelId as string };
	}
	if (raw.approvalPatterns !== undefined && raw.approvalPatterns !== null) {
		if (!Array.isArray(raw.approvalPatterns) || raw.approvalPatterns.length > 100) fail("approvalPatterns is not a list of at most 100");
		override.approvalPatterns = raw.approvalPatterns.map(validatePattern);
	}
	if (raw.skills !== undefined) {
		if (!isRecord(raw.skills)) fail("skills is not an object");
		if (raw.skills.repository !== undefined && raw.skills.repository !== null) {
			const names = words(raw.skills.repository);
			if (!names || !names.every((name) => SKILL_NAME.test(name))) fail("skills.repository names an invalid skill");
			override.skills.repository = names;
		}
		if (raw.skills.library !== undefined) {
			if (!Array.isArray(raw.skills.library) || raw.skills.library.length > 100) fail("skills.library is not a list of at most 100");
			override.skills.library = raw.skills.library.map(validateSkill);
			const skillNames = new Set<string>();
			for (const skill of override.skills.library) {
				if (skillNames.has(skill.name)) fail(`the library skill ${skill.name} appears twice`);
				skillNames.add(skill.name);
			}
		}
		if (raw.skills.overlays !== undefined) {
			if (!isRecord(raw.skills.overlays)) fail("skills.overlays is not an object");
			for (const [name, overlay] of Object.entries(raw.skills.overlays)) {
				if (!SKILL_NAME.test(name) || typeof overlay !== "string" || Buffer.byteLength(overlay) > 16 * 1024) fail(`the overlay for ${name} is invalid or larger than 16 KiB`);
				override.skills.overlays[name] = overlay;
			}
		}
	}
	if (raw.mcp !== undefined) {
		if (!Array.isArray(raw.mcp) || raw.mcp.length > 50) fail("mcp is not a list of at most 50");
		override.mcp = raw.mcp.map(validateMcp);
		const names = new Set<string>();
		for (const entry of override.mcp) {
			if (names.has(entry.name)) fail(`the MCP entry ${entry.name} appears twice`);
			names.add(entry.name);
		}
	}
	return override;
}

export function parseLimits(raw: unknown): FleetLimits {
	if (!isRecord(raw) || raw.schema !== SETUP_SCHEMA || raw.kind !== "limits") fail("not fleet limits this agent understands");
	const limits: FleetLimits = {
		schema: SETUP_SCHEMA,
		kind: "limits",
		revision: positive(raw.revision) ?? fail("the limits have no revision"),
		savedBy: text(raw.savedBy, 200) ?? "",
		savedAt: text(raw.savedAt, 40) ?? "",
		maxTokensCap: positive(raw.maxTokensCap) ?? fail("maxTokensCap must be a positive integer"),
		maxMinutesCap: positive(raw.maxMinutesCap) ?? fail("maxMinutesCap must be a positive integer"),
		dailyTokenLimit: positive(raw.dailyTokenLimit) ?? fail("dailyTokenLimit must be a positive integer"),
		budgetRaiseCeiling: positive(raw.budgetRaiseCeiling) ?? fail("budgetRaiseCeiling must be a positive integer"),
	};
	if (raw.globalPrompt !== undefined && raw.globalPrompt !== null) limits.globalPrompt = text(raw.globalPrompt, MAX_GLOBAL_PROMPT_CHARS) ?? fail(`the global prompt is longer than ${MAX_GLOBAL_PROMPT_CHARS} characters`);
	return limits;
}

/** True for the one principal an agent takes setup from. */
export const isOperations = (sender: { kind: string; id: string }): boolean => sender.kind === OPERATIONS_PRINCIPAL.kind && sender.id === OPERATIONS_PRINCIPAL.id;
