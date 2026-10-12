import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isOperations, MAX_INSTRUCTIONS_CHARS, parseLimits, parseOverride, SetupRejected, sha256Hex } from "../src/setup/contract.ts";

const AGENT = "qa";
const skill = (name: string, content = "# Skill\nDo it."): Record<string, unknown> => ({ name, version: 1, description: "does it", content, sha256: sha256Hex(content) });
const document = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ schema: 1, kind: "override", agent: AGENT, revision: 3, savedBy: "ada@example.test", savedAt: "2026-10-10T10:00:00Z", ...over });
const rejects = (raw: unknown, reason: RegExp, agent = AGENT): void => assert.throws(() => parseOverride(raw, agent), (error: unknown) => error instanceof SetupRejected && reason.test(error.message), String(reason));
const download = (over: Record<string, unknown> = {}) => ({ url: "https://example.test/server.tgz", sha256: "a".repeat(64), archive: "tar.gz", executable: "bin/server", ...over });
const entry = (over: Record<string, unknown> = {}) => ({ name: "files", transport: "stdio", command: "npx", args: ["-y", "files-server"], approval: "ask", ...over });

describe("parsing a setup override", () => {
	it("accepts the smallest document and fills in the empty parts", () => {
		const parsed = parseOverride(document(), AGENT);
		assert.equal(parsed.revision, 3);
		assert.deepEqual(parsed.skills, { library: [], overlays: {} });
		assert.deepEqual(parsed.mcp, []);
		assert.equal(parsed.instructions, undefined);
		assert.equal(parsed.model, undefined);
		assert.equal(parsed.approvalPatterns, undefined);
	});

	it("accepts a full document", () => {
		const parsed = parseOverride(
			document({
				instructions: "Answer in Swedish.",
				model: { provider: "openai", modelId: "gpt-5.5" },
				approvalPatterns: [{ pattern: "^make deploy", reason: "deploys" }],
				skills: { repository: ["verify-skill"], library: [skill("release-notes")], overlays: { "verify-skill": "Be brief." } },
				mcp: [entry(), { name: "docs", transport: "http", url: "https://docs.example.test/mcp", headers: { authorization: "Bearer ${DOCS_TOKEN}" }, secrets: ["DOCS_TOKEN"], approval: "writes" }],
			}),
			AGENT,
		);
		assert.equal(parsed.instructions, "Answer in Swedish.");
		assert.deepEqual(parsed.model, { provider: "openai", modelId: "gpt-5.5" });
		assert.deepEqual(parsed.skills.repository, ["verify-skill"]);
		assert.equal(parsed.skills.library[0]!.name, "release-notes");
		assert.deepEqual(parsed.mcp.map((item) => item.name), ["files", "docs"]);
	});

	it("takes the provider, the model and the effort one by one, so an old document with both names stays valid", () => {
		assert.deepEqual(parseOverride(document({ model: { provider: "openai" } }), AGENT).model, { provider: "openai" });
		assert.deepEqual(parseOverride(document({ model: { modelId: "gpt-6.1-sol" } }), AGENT).model, { modelId: "gpt-6.1-sol" });
		assert.deepEqual(parseOverride(document({ model: { effort: "high" } }), AGENT).model, { effort: "high" });
		assert.deepEqual(parseOverride(document({ model: { provider: "openai-codex", modelId: "gpt-6.1-sol", effort: "high", unknown: 1 } }), AGENT).model, { provider: "openai-codex", modelId: "gpt-6.1-sol", effort: "high" });
		assert.deepEqual(parseOverride(document({ model: { provider: "openai", modelId: "gpt-5.5" } }), AGENT).model, { provider: "openai", modelId: "gpt-5.5" });
		assert.deepEqual(parseOverride(document({ model: { provider: null, modelId: null, effort: "low" } }), AGENT).model, { effort: "low" }, "null is the same as absent");
		for (const effort of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) assert.equal(parseOverride(document({ model: { effort } }), AGENT).model?.effort, effort);
	});

	it("refuses a model with no field, an unknown effort, or a blank or oversized name", () => {
		rejects(document({ model: {} }), /needs at least one of provider, model id and effort/);
		rejects(document({ model: { provider: null } }), /needs at least one of provider, model id and effort/);
		rejects(document({ model: { effort: "extreme" } }), /unknown effort \(use off, minimal, low, medium, high, xhigh, max\)/);
		rejects(document({ model: { effort: 3 } }), /unknown effort/);
		rejects(document({ model: { provider: "" } }), /empty or too long provider/);
		rejects(document({ model: { provider: "p".repeat(81) } }), /empty or too long provider/);
		rejects(document({ model: { modelId: "m".repeat(201) } }), /empty or too long model id/);
	});

	it("keeps an empty repository list (no repository skills) apart from an absent one (the role's list)", () => {
		assert.deepEqual(parseOverride(document({ skills: { repository: [] } }), AGENT).skills.repository, []);
		assert.equal(parseOverride(document({ skills: {} }), AGENT).skills.repository, undefined);
	});

	it("rejects a document for another agent, another schema or kind, and one without a revision", () => {
		rejects(document(), /is for qa, not for reviewer/, "reviewer");
		rejects(document({ schema: 2 }), /not a setup override/);
		rejects(document({ kind: "limits" }), /not a setup override/);
		rejects("text", /not a setup override/);
		rejects(document({ revision: 0 }), /no revision/);
		rejects(document({ revision: 1.5 }), /no revision/);
		rejects(document({ revision: "3" }), /no revision/);
	});

	it("rejects bad instructions, models and approval patterns", () => {
		rejects(document({ instructions: "x".repeat(MAX_INSTRUCTIONS_CHARS + 1) }), /longer than/);
		rejects(document({ instructions: 5 }), /longer than/);
		rejects(document({ model: "openai/gpt" }), /override's model is not an object/);
		rejects(document({ approvalPatterns: [{ pattern: "(", reason: "broken" }] }), /is not a regular expression/);
		rejects(document({ approvalPatterns: [{ pattern: "x" }] }), /needs a pattern .* and a reason/);
		rejects(document({ approvalPatterns: "all" }), /not a list/);
		rejects(document({ approvalPatterns: Array.from({ length: 101 }, () => ({ pattern: "x", reason: "y" })) }), /at most 100/);
	});

	it("rejects bad skills: a name, a checksum that does not match, a duplicate, an oversized skill, a bad overlay", () => {
		rejects(document({ skills: { repository: ["Not Valid"] } }), /invalid skill/);
		rejects(document({ skills: { library: [skill("../escape")] } }), /invalid name/);
		rejects(document({ skills: { library: [{ ...skill("a"), sha256: sha256Hex("something else") }] } }), /does not match its checksum/);
		rejects(document({ skills: { library: [skill("a"), skill("a", "other content")] } }), /appears twice/);
		const big = "x".repeat(64 * 1024 + 1);
		rejects(document({ skills: { library: [skill("big", big)] } }), /larger than/);
		rejects(document({ skills: { library: [{ ...skill("a"), version: 0 }] } }), /no version/);
		rejects(document({ skills: { overlays: { "Bad Name": "x" } } }), /overlay for Bad Name is invalid/);
		rejects(document({ skills: { overlays: { fine: "x".repeat(16 * 1024 + 1) } } }), /larger than 16 KiB/);
	});

	it("rejects bad MCP entries: names, duplicates, transports, secrets, approval", () => {
		rejects(document({ mcp: [entry({ name: "Bad Name" })] }), /invalid name/);
		rejects(document({ mcp: [entry(), entry({ command: "other" })] }), /appears twice/);
		rejects(document({ mcp: [entry({ transport: "websocket" })] }), /unknown transport/);
		rejects(document({ mcp: [entry({ approval: "sometimes" })] }), /unknown approval/);
		rejects(document({ mcp: [entry({ command: undefined })] }), /needs a command/);
		rejects(document({ mcp: [{ name: "web", transport: "http", approval: "never", url: "ftp://x" }] }), /needs an http\(s\) url/);
		rejects(document({ mcp: [entry({ secrets: ["lower-case"] })] }), /invalid secret/);
		rejects(document({ mcp: [entry({ env: { A: 1 } })] }), /invalid env/);
		rejects(document({ mcp: [entry({ timeoutSeconds: -1 })] }), /invalid timeout/);
		rejects(document({ mcp: Array.from({ length: 51 }, (_, index) => entry({ name: `s${index}` })) }), /at most 50/);
	});

	it("rejects a download that is not https, has no checksum, an unknown archive kind or an executable outside its folder", () => {
		const withDownload = (over: Record<string, unknown>) => document({ mcp: [entry({ command: "${LOCAL}", downloads: { linux: download(over) } })] });
		assert.equal(parseOverride(withDownload({}), AGENT).mcp[0]!.downloads!.linux!.executable, "bin/server");
		rejects(withDownload({ url: "http://example.test/server.tgz" }), /needs an https url/);
		rejects(withDownload({ sha256: "abc" }), /needs a SHA-256/);
		rejects(withDownload({ sha256: "A".repeat(64) }), /needs a SHA-256/);
		rejects(withDownload({ archive: "rar" }), /unknown archive kind/);
		rejects(withDownload({ executable: "../../bin/sh" }), /outside its folder/);
		rejects(withDownload({ executable: "/bin/sh" }), /outside its folder/);
	});
});

describe("parsing fleet limits", () => {
	const limits = (over: Record<string, unknown> = {}) => ({ schema: 1, kind: "limits", revision: 2, savedBy: "admin", savedAt: "2026-10-10T10:00:00Z", maxTokensCap: 1_000_000, maxMinutesCap: 30, dailyTokenLimit: 5_000_000, budgetRaiseCeiling: 8_000_000, ...over });

	it("accepts a complete set", () => {
		const parsed = parseLimits(limits());
		assert.equal(parsed.dailyTokenLimit, 5_000_000);
		assert.equal(parsed.revision, 2);
	});

	it("carries no model unless the fleet sets one, and takes the same shape as an override", () => {
		assert.equal(parseLimits(limits()).model, undefined);
		assert.equal(parseLimits(limits({ model: null })).model, undefined);
		assert.deepEqual(parseLimits(limits({ model: { provider: "openai-codex", modelId: "gpt-6.1-sol", effort: "high" } })).model, { provider: "openai-codex", modelId: "gpt-6.1-sol", effort: "high" });
		assert.deepEqual(parseLimits(limits({ model: { effort: "max", extra: true } })).model, { effort: "max" });
		assert.throws(() => parseLimits(limits({ model: {} })), /the fleet's model needs at least one/);
		assert.throws(() => parseLimits(limits({ model: { effort: "huge" } })), /the fleet's model has an unknown effort/);
		assert.throws(() => parseLimits(limits({ model: "x" })), /the fleet's model is not an object/);
	});

	it("rejects a missing, zero, negative, fractional or textual limit", () => {
		for (const field of ["maxTokensCap", "maxMinutesCap", "dailyTokenLimit", "budgetRaiseCeiling"]) {
			for (const bad of [undefined, 0, -5, 1.5, "10"]) assert.throws(() => parseLimits(limits({ [field]: bad })), (error: unknown) => error instanceof SetupRejected && error.message.includes(field), `${field}=${String(bad)}`);
		}
		assert.throws(() => parseLimits(limits({ kind: "override" })), SetupRejected);
		assert.throws(() => parseLimits(limits({ revision: 0 })), /no revision/);
	});
});

describe("who Operations is", () => {
	it("is the service principal operations and nobody else", () => {
		assert.equal(isOperations({ kind: "service", id: "operations" }), true);
		assert.equal(isOperations({ kind: "agent", id: "operations" }), false);
		assert.equal(isOperations({ kind: "service", id: "operations2" }), false);
		assert.equal(isOperations({ kind: "human", id: "service/operations" }), false);
	});
});
