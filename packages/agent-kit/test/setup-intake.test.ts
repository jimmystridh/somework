import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { McpHub } from "../src/mcp/hub.ts";
import { createSetupIntercept } from "../src/setup/intake.ts";
import { SETUP_LABELS, sha256Hex, type FleetLimits } from "../src/setup/contract.ts";
import { Setup } from "../src/setup/setup.ts";
import type { InboundMessage } from "../src/threads/message.ts";

const AGENT = "qa";
const DOMAIN = "somework-test";
const MODELS = [{ provider: "faux", modelId: "a" }, { provider: "faux", modelId: "b" }];
const OPERATIONS = { kind: "service", id: "operations" };

const hubs: McpHub[] = [];
afterEach(async () => {
	for (const hub of hubs.splice(0)) await hub.close();
});

interface Posted {
	path: string;
	body: any;
	options: any;
}

function rig(options: { dir?: string; env?: NodeJS.ProcessEnv } = {}) {
	const dir = options.dir ?? mkdtempSync(join(tmpdir(), "kit-setup-"));
	const logged: { level: string; event: string; fields?: Record<string, unknown> }[] = [];
	const hub = new McpHub({ root: join(dir, "mcp"), env: options.env ?? { PATH: process.env.PATH ?? "", DOCS_TOKEN: "docs-secret-value" } });
	hubs.push(hub);
	const models: (typeof MODELS[number] | undefined)[] = [];
	const limitsApplied: FleetLimits[] = [];
	const setup = new Setup({
		agentId: AGENT,
		dir: join(dir, "setup"),
		defaults: { approvalPatterns: [{ pattern: "sudo", reason: "root" }], repositorySkills: ["verify-skill"], model: MODELS[0]!, allowedModels: MODELS },
		hub,
		checkModel: (ref) => (MODELS.some((known) => known.provider === ref.provider && known.modelId === ref.modelId) ? undefined : `the model ${ref.provider}/${ref.modelId} is not one of this agent's allowed models`),
		setModel: (ref) => void models.push(ref),
		applyLimits: (limits) => void limitsApplied.push(limits),
		log: (level, event, fields) => void logged.push({ level, event, fields }),
		now: () => new Date("2026-10-10T12:00:00Z"),
	});
	const artifacts = new Map<string, Buffer>();
	const downloads: { artifactId: string; maxBytes?: number }[] = [];
	const posts: Posted[] = [];
	let failAck = false;
	const client = {
		downloadArtifact: async (ref: { artifactId: string }, opts: { maxBytes?: number } = {}): Promise<Buffer> => {
			downloads.push({ artifactId: ref.artifactId, maxBytes: opts.maxBytes });
			const bytes = artifacts.get(ref.artifactId);
			if (!bytes) throw new Error("object download failed: 404");
			return bytes;
		},
		post: async (path: string, body: unknown, options?: unknown): Promise<any> => {
			if (failAck) throw new Error("domain down");
			posts.push({ path, body, options });
			return {};
		},
	};
	const intercept = createSetupIntercept({ agentId: AGENT, domainId: DOMAIN, client: client as any, setup, log: (level, event, fields) => void logged.push({ level, event, fields }) });
	let counter = 0;

	/** Delivers a document the way Operations does: the bytes as an artifact, a notice with the labels. */
	async function deliver(document: unknown, over: { sender?: { kind: string; id: string }; senderDomain?: string; labels?: Record<string, string>; bytes?: Buffer; type?: string; artifacts?: unknown[] } = {}): Promise<boolean> {
		counter += 1;
		const bytes = over.bytes ?? Buffer.from(JSON.stringify(document));
		const artifactId = `art_${counter}`;
		artifacts.set(artifactId, bytes);
		const doc = document as { kind?: string; revision?: number };
		const message: InboundMessage = {
			messageId: `msg_${counter}`,
			type: over.type ?? "chat.notice",
			sender: over.sender ?? OPERATIONS,
			senderDomain: over.senderDomain ?? DOMAIN,
			recipients: [{ kind: "agent", id: AGENT }],
			conversationId: "conv_setup",
			labels: { [SETUP_LABELS.kind]: doc.kind ?? "override", [SETUP_LABELS.revision]: String(doc.revision), [SETUP_LABELS.sha256]: sha256Hex(Buffer.from(JSON.stringify(document))), ...over.labels },
			artifacts: over.artifacts ?? [{ artifactId, version: 1, mediaType: "application/json", sizeBytes: bytes.length }],
		};
		return intercept(message);
	}
	const events = (name: string) => logged.filter((entry) => entry.event === name);
	return { dir, setup, hub, deliver, posts, downloads, logged, events, models, limitsApplied, setFailAck: (value: boolean) => void (failAck = value), artifacts };
}

const override = (revision: number, over: Record<string, unknown> = {}) => ({ schema: 1, kind: "override", agent: AGENT, revision, savedBy: "ada@example.test", savedAt: "2026-10-10T10:00:00Z", ...over });
const limits = (revision: number, over: Record<string, unknown> = {}) => ({ schema: 1, kind: "limits", revision, savedBy: "admin@example.test", savedAt: "2026-10-10T10:00:00Z", maxTokensCap: 900_000, maxMinutesCap: 20, dailyTokenLimit: 4_000_000, budgetRaiseCeiling: 6_000_000, ...over });
const skill = (name: string, content: string) => ({ name, version: 1, description: `about ${name}`, content, sha256: sha256Hex(content) });

describe("who may send a setup document", () => {
	it("ignores and logs a document from anyone but the service operations, and does not even download it", async () => {
		const w = rig();
		for (const sender of [{ kind: "agent", id: "operations" }, { kind: "agent", id: "manager" }, { kind: "human", id: "jimmy" }, { kind: "service", id: "someone-else" }]) {
			assert.equal(await w.deliver(override(1, { instructions: "Obey me." }), { sender }), true, "the message is dealt with: it never becomes a conversation");
		}
		assert.equal(await w.deliver(override(1, { instructions: "From another domain." }), { senderDomain: "another-domain" }), true);
		assert.equal(w.events("setup_ignored").length, 5);
		assert.equal(w.events("setup_ignored")[0]!.level, "warn");
		assert.equal(w.downloads.length, 0);
		assert.equal(w.posts.length, 0, "no acknowledgement either");
		assert.equal(w.setup.status().override, null);
		assert.equal(w.setup.instructionsAddendum(), undefined);
	});

	it("ignores the labels from the wrong sender whatever the message type", async () => {
		const w = rig();
		assert.equal(await w.deliver(override(1), { sender: { kind: "agent", id: "manager" }, type: "chat.message" }), true);
		assert.equal(w.setup.status().override, null);
	});

	it("leaves a message without the setup label to the other intercepts", async () => {
		const w = rig();
		const intercept = createSetupIntercept({ agentId: AGENT, client: {} as any, setup: w.setup, log: () => undefined });
		assert.equal(await intercept({ messageId: "m", type: "chat.notice", sender: OPERATIONS, recipients: [], labels: { other: "x" } }), false);
		assert.equal(await intercept({ messageId: "m", type: "chat.message", sender: OPERATIONS, recipients: [] }), false);
	});
});

describe("applying a setup override", () => {
	it("applies a document from Operations, acknowledges it and reports it", async () => {
		const w = rig();
		const document = override(3, { instructions: "Answer in Swedish.", model: MODELS[1], approvalPatterns: [{ pattern: "^make deploy", reason: "deploys" }], skills: { repository: [], library: [skill("notes", "# Notes")], overlays: { "verify-skill": "Be brief." } } });
		assert.equal(await w.deliver(document), true);
		assert.deepEqual(w.downloads.map((entry) => entry.maxBytes), [2 * 1024 * 1024], "the download is capped at 2 MiB");

		const status = w.setup.status();
		assert.equal(status.override!.revision, 3);
		assert.equal(status.override!.hash, sha256Hex(Buffer.from(JSON.stringify(document))), "the hash is that of the bytes Operations sent");
		assert.equal(status.override!.appliedAt, "2026-10-10T12:00:00.000Z");
		assert.equal(status.rejected, undefined);
		assert.match(w.setup.instructionsAddendum()!, /Answer in Swedish\./);
		assert.deepEqual(w.models, [MODELS[1]]);
		assert.deepEqual(w.setup.approvalPatterns()!.map(([pattern, reason]) => [pattern.source, reason]), [["^make deploy", "deploys"]]);
		assert.deepEqual(w.setup.repositorySkills(["verify-skill"]), []);
		assert.equal(w.setup.overlay("verify-skill"), "Be brief.");
		assert.equal(w.setup.librarySkills()[0]!.name, "notes");

		assert.equal(w.posts.length, 1);
		const ack = w.posts[0]!;
		assert.equal(ack.path, "/v1/messages");
		assert.equal(ack.options.idempotencyKey, "setup-ack:qa:override:3");
		assert.equal(ack.body.type, "chat.notice");
		assert.equal(ack.body.triggerMode, "never", "the domain allows no other trigger mode for a notice");
		assert.deepEqual(ack.body.recipients, [OPERATIONS]);
		assert.deepEqual(ack.body.labels, { [SETUP_LABELS.kind]: "override", [SETUP_LABELS.ack]: "3", [SETUP_LABELS.status]: "applied" });
		assert.equal(ack.body.conversationId, "conv_setup");
		assert.equal(ack.body.replyTo, "msg_1");
		assert.match(ack.body.content.data, /Applied override revision 3/);
	});

	it("acknowledges a revision that is not newer than the applied one and ignores it without downloading it", async () => {
		const w = rig();
		await w.deliver(override(5, { instructions: "five" }));
		const before = w.downloads.length;
		await w.deliver(override(5, { instructions: "five again" }));
		await w.deliver(override(4, { instructions: "four" }));
		assert.equal(w.downloads.length, before, "nothing was downloaded for them");
		assert.match(w.setup.instructionsAddendum()!, /five$/);
		assert.equal(w.setup.status().override!.revision, 5);
		assert.deepEqual(w.posts.slice(1).map((post) => [post.body.labels[SETUP_LABELS.ack], post.body.labels[SETUP_LABELS.status]]), [["5", "applied"], ["4", "rejected"]]);
		assert.match(w.posts[2]!.body.content.data, /revision 5 is already applied/);
		assert.equal(w.setup.status().rejected, undefined, "a superseded revision is not a failure");
	});

	it("keeps the previous setup and reports the reason when a document is refused", async () => {
		const w = rig({ env: { PATH: "", DOCS_TOKEN: "docs-secret-value" } });
		await w.deliver(override(3, { instructions: "keep me" }));
		const keepsOld = (): void => {
			assert.match(w.setup.instructionsAddendum()!, /keep me/);
			assert.equal(w.setup.status().override!.revision, 3);
		};
		const refused = async (revision: number, deliver: () => Promise<boolean>, reason: RegExp): Promise<void> => {
			const before = w.posts.length;
			await deliver();
			keepsOld();
			const { rejected } = w.setup.status();
			assert.equal(rejected!.kind, "override");
			assert.equal(rejected!.revision, revision);
			assert.match(rejected!.reason, reason);
			const ack = w.posts[before]!;
			assert.equal(ack.body.labels[SETUP_LABELS.status], "rejected");
			assert.equal(ack.body.labels[SETUP_LABELS.ack], String(revision));
			assert.match(ack.body.content.data, reason);
		};

		await refused(4, () => w.deliver(override(4, { instructions: "bad" }), { bytes: Buffer.from("tampered bytes") }), /does not match its checksum/);
		await refused(5, () => w.deliver(override(5), { labels: { [SETUP_LABELS.sha256]: "" } }), /names no checksum/);
		await refused(6, () => w.deliver(override(6, { model: { provider: "openai", modelId: "unknown" } })), /not one of this agent's allowed models/);
		await refused(7, () => w.deliver(override(7, { mcp: [{ name: "docs", transport: "http", url: "https://docs.example.test/mcp", approval: "never", secrets: ["NOT_ON_THIS_HOST"] }] })), /needs NOT_ON_THIS_HOST \(listed under secrets\)/);
		await refused(8, () => w.deliver(override(8, { agent: "somebody-else" })), /is for somebody-else, not for qa/);
		await refused(9, () => w.deliver(override(9, { approvalPatterns: [{ pattern: "(", reason: "x" }] })), /not a regular expression/);
		await refused(10, () => w.deliver(override(10), { bytes: Buffer.from("not json"), labels: { [SETUP_LABELS.sha256]: sha256Hex(Buffer.from("not json")) } }), /not valid JSON/);
		await refused(11, () => w.deliver(override(11), { artifacts: [] }), /carries no document/);
		await refused(12, () => w.deliver(override(12), { artifacts: [{ artifactId: "art_missing", version: 1 }] }), /could not be downloaded/);
		await refused(13, () => w.deliver(override(13), { artifacts: [{ artifactId: "art_big", version: 1, sizeBytes: 3 * 1024 * 1024 }] }), /larger than/);
		await refused(15, () => w.deliver(override(14), { labels: { [SETUP_LABELS.revision]: "15" } }), /revision is not the one the message names/);
	});

	it("clears the refusal when the next document applies", async () => {
		const w = rig();
		await w.deliver(override(1), { bytes: Buffer.from("garbage") });
		assert.equal(w.setup.status().rejected!.revision, 1);
		await w.deliver(override(2, { instructions: "fixed" }));
		assert.equal(w.setup.status().rejected, undefined);
		assert.equal(w.setup.status().override!.revision, 2);
	});

	it("applies two documents that arrive together in the order they came", async () => {
		const w = rig();
		await Promise.all([w.deliver(override(1, { instructions: "one" })), w.deliver(override(2, { instructions: "two" }))]);
		assert.equal(w.setup.status().override!.revision, 2);
		assert.match(w.setup.instructionsAddendum()!, /two$/);
	});

	it("still applies the document when the acknowledgement cannot be sent", async () => {
		const w = rig();
		w.setFailAck(true);
		assert.equal(await w.deliver(override(1, { instructions: "one" })), true);
		assert.equal(w.setup.status().override!.revision, 1);
		assert.equal(w.events("setup_ack_failed").length, 1);
	});

	it("takes an empty override as the reset: no instructions, model, patterns, skills or servers", async () => {
		const w = rig();
		await w.deliver(override(1, { instructions: "x", model: MODELS[1], approvalPatterns: [], mcp: [{ name: "docs", transport: "http", url: "https://docs.example.test/mcp", approval: "never" }] }));
		assert.equal(w.setup.conversationSuffix() !== "", true);
		await w.deliver(override(2));
		assert.equal(w.setup.instructionsAddendum(), undefined);
		assert.equal(w.setup.approvalPatterns(), undefined);
		assert.deepEqual(w.setup.operatorTools(), []);
		assert.equal(w.setup.conversationSuffix(), "");
		assert.deepEqual(w.models, [MODELS[1], undefined], "the model goes back to the configured one");
		assert.deepEqual(w.hub.names(), []);
	});
});

describe("fleet limits", () => {
	it("applies limits from Operations, acknowledges them and ignores an older revision", async () => {
		const w = rig();
		await w.deliver(limits(4));
		assert.equal(w.limitsApplied.length, 1);
		assert.equal(w.limitsApplied[0]!.dailyTokenLimit, 4_000_000);
		assert.deepEqual(w.setup.status().limits, { revision: 4, appliedAt: "2026-10-10T12:00:00.000Z" });
		assert.deepEqual(w.posts[0]!.body.labels, { [SETUP_LABELS.kind]: "limits", [SETUP_LABELS.ack]: "4", [SETUP_LABELS.status]: "applied" });
		assert.equal(w.posts[0]!.options.idempotencyKey, "setup-ack:qa:limits:4");
		await w.deliver(limits(3, { dailyTokenLimit: 1 }));
		assert.equal(w.limitsApplied.length, 1);
		assert.equal(w.setup.status().override, null, "limits are not part of the override");
	});

	it("refuses limits that are not positive whole numbers and keeps the earlier ones", async () => {
		const w = rig();
		await w.deliver(limits(1));
		await w.deliver(limits(2, { dailyTokenLimit: 0 }));
		assert.equal(w.limitsApplied.length, 1);
		assert.equal(w.setup.status().limits!.revision, 1);
		assert.match(w.setup.status().rejected!.reason, /dailyTokenLimit must be a positive integer/);
		assert.equal(w.setup.status().rejected!.kind, "limits");
	});
});

describe("after a restart", () => {
	it("loads what was applied before anything else is built", async () => {
		const first = rig();
		const document = override(7, { instructions: "stay", model: MODELS[1], skills: { library: [skill("notes", "# Notes")], overlays: {} }, mcp: [{ name: "docs", transport: "http", url: "https://docs.example.test/mcp", headers: { authorization: "Bearer ${DOCS_TOKEN}" }, secrets: ["DOCS_TOKEN"], approval: "ask" }] });
		await first.deliver(document);
		await first.deliver(limits(2));
		const hash = first.setup.status().override!.hash;

		const second = rig({ dir: first.dir });
		await second.setup.restore();
		assert.equal(second.setup.status().override!.revision, 7);
		assert.equal(second.setup.status().override!.hash, hash);
		assert.equal(second.setup.status().limits!.revision, 2);
		assert.equal(second.limitsApplied[0]!.revision, 2, "the limits are put into effect on restore");
		assert.match(second.setup.instructionsAddendum()!, /stay/);
		assert.deepEqual(second.setup.model(), MODELS[1]);
		assert.equal(second.setup.librarySkills()[0]!.name, "notes");
		assert.deepEqual(second.hub.names(), ["docs"]);
		assert.equal(second.setup.conversationSuffix(), first.setup.conversationSuffix(), "the conversation key suffix is the same as before the restart");
		assert.equal(await second.deliver(document), true);
		assert.match(second.posts[0]!.body.content.data, /already applied/, "a repeated document is acknowledged, not applied twice");
	});

	it("keeps the document in the state directory in files only the agent can read", async () => {
		const w = rig();
		await w.deliver(override(1, { instructions: "x" }));
		const { statSync } = await import("node:fs");
		assert.equal(statSync(join(w.dir, "setup", "override.json")).mode & 0o077, 0);
	});

	it("starts on its defaults, and says so in the log, when the stored document is damaged", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kit-setup-"));
		mkdirSync(join(dir, "setup"), { recursive: true });
		writeFileSync(join(dir, "setup", "override.json"), "{ not json");
		writeFileSync(join(dir, "setup", "limits.json"), JSON.stringify({ sha256: "x", appliedAt: "y", document: { kind: "limits" } }));
		const w = rig({ dir });
		await w.setup.restore();
		assert.deepEqual(w.setup.status(), { override: null, limits: null });
		assert.equal(w.events("setup_restore_failed").length, 1, "the limits document is refused; the override file could not be read at all");
	});

	it("leaves out a server whose secret has gone and reports why, without refusing the rest", async () => {
		const first = rig();
		await first.deliver(override(1, { instructions: "stay", mcp: [{ name: "docs", transport: "http", url: "https://docs.example.test/mcp", secrets: ["DOCS_TOKEN"], approval: "never" }, { name: "open", transport: "http", url: "https://open.example.test/mcp", approval: "never" }] }));
		const second = rig({ dir: first.dir, env: { PATH: "" } });
		await second.setup.restore();
		assert.deepEqual(second.hub.names(), ["open"]);
		assert.match(second.setup.instructionsAddendum()!, /stay/);
		const report = second.setup.report({ model: MODELS[0]! });
		assert.match(report.effective.mcp.find((entry) => entry.name === "docs")!.error!, /needs DOCS_TOKEN \(listed under secrets\)/);
		assert.equal(report.effective.mcp.find((entry) => entry.name === "open")!.error, undefined);
	});
});

describe("what /profile reports", () => {
	it("tells the status with the role's defaults and what is in effect, and nothing secret", async () => {
		const w = rig();
		let report = w.setup.report({ model: MODELS[0]! });
		assert.deepEqual(report.defaults, { approvalPatterns: [{ pattern: "sudo", reason: "root" }], repositorySkills: ["verify-skill"], model: MODELS[0], allowedModels: MODELS });
		assert.deepEqual(report.effective.approvalPatterns, [{ pattern: "sudo", reason: "root" }]);
		assert.equal(report.effective.instructions, undefined);
		assert.equal(report.override, null);

		await w.deliver(override(2, { instructions: "  Be kind.  ", approvalPatterns: [{ pattern: "x", reason: "y" }], skills: { repository: ["a"], library: [skill("notes", "# Notes")], overlays: {} }, mcp: [{ name: "docs", transport: "http", url: "https://docs.example.test/mcp?key=abc", headers: { authorization: "Bearer ${DOCS_TOKEN}" }, secrets: ["DOCS_TOKEN"], approval: "writes" }] }));
		report = w.setup.report({ model: MODELS[1]! });
		assert.equal(report.override!.revision, 2);
		assert.equal(report.effective.instructions!.text, "Be kind.");
		assert.equal(report.effective.instructions!.sha256, sha256Hex("Be kind."));
		assert.deepEqual(report.effective.approvalPatterns, [{ pattern: "x", reason: "y" }]);
		assert.deepEqual(report.effective.repositorySkills, ["a"]);
		assert.deepEqual(report.effective.librarySkills, [{ name: "notes", version: 1 }]);
		assert.deepEqual(report.effective.mcp, [{ name: "docs", transport: "http", approval: "writes" }]);
		assert.deepEqual(report.effective.model, MODELS[1]);
		const json = JSON.stringify(report);
		assert.doesNotMatch(json, /docs-secret-value|key=abc|docs\.example\.test/, "no secret, no url, no header");
	});
});
