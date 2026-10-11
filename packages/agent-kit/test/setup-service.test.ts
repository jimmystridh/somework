import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { sleep } from "@somework/sdk";
import { freePort } from "../../../sdk/typescript/test/harness.ts";
import { sha256Hex } from "../src/setup/contract.ts";

const here = new URL(".", import.meta.url).pathname;
const children: ChildProcess[] = [];
afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
});

/** What an earlier run applied, written the way the agent keeps it. */
function seed(state: string, files: { override?: unknown; limits?: unknown }): void {
	mkdirSync(join(state, "setup"), { recursive: true });
	for (const [name, document] of Object.entries(files)) writeFileSync(join(state, "setup", `${name}.json`), JSON.stringify({ sha256: sha256Hex(JSON.stringify(document)), appliedAt: "2026-10-10T09:00:00.000Z", document }));
}

async function start(files: { override?: unknown; limits?: unknown }, env: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "kit-setup-service-"));
	const state = join(dir, "state");
	mkdirSync(state);
	seed(state, files);
	const seed32 = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64url");
	const keyFile = join(dir, "agent.key.json");
	writeFileSync(keyFile, JSON.stringify({ kind: "agent", id: "fixture", domainId: "somework-test", privateKey: seed32, publicKey: "unused" }));
	const healthPort = await freePort();
	const child = spawn("node", [join(here, "fixtures/setup-main.ts")], {
		env: { PATH: process.env.PATH!, HOME: process.env.HOME!, SOMEWORK_URL: "http://127.0.0.1:1", SOMEWORK_KEY_FILE: keyFile, PI_STATE_DIR: state, PI_PROVIDER: "faux", SANDBOX_URL: "http://127.0.0.1:1", SANDBOX_WORKSPACES: join(dir, "workspaces"), HEALTH_PORT: String(healthPort), ...env },
		stdio: ["ignore", "ignore", "pipe"],
	});
	let log = "";
	child.stderr!.on("data", (chunk) => (log += chunk));
	children.push(child);
	const url = `http://127.0.0.1:${healthPort}`;
	for (let attempt = 0; attempt < 200; attempt++) {
		if (await fetch(`${url}/ready`).then((response) => response.ok, () => false)) return { url, profile: async () => (await (await fetch(`${url}/profile`)).json()) as any, log: () => log };
		await sleep(100);
	}
	throw new Error(`the service did not become ready\n${log.slice(-2000)}`);
}

const skill = (name: string, content: string) => ({ name, version: 2, description: `about ${name}`, content, sha256: sha256Hex(content) });

describe("the service starts with the setup an earlier run applied", () => {
	it("reports the defaults and no setup when nothing was ever applied", async () => {
		const service = await start({});
		const profile = await service.profile();
		assert.equal(profile.setup.override, null);
		assert.equal(profile.setup.limits, null);
		assert.equal(profile.setup.defaults.repositorySkills[0], "verify-skill");
		assert.ok(profile.setup.defaults.approvalPatterns.some((entry: { pattern: string }) => /sudo/.test(entry.pattern)));
		assert.equal(profile.setup.effective.instructions, undefined);
		assert.equal(profile.budgets.maxTokensCap, 2_000_000, "the environment's value is the fallback");
	});

	it("loads the override and the fleet limits before it serves, and reports them under setup", async () => {
		const override = {
			schema: 1,
			kind: "override",
			agent: "fixture",
			revision: 4,
			savedBy: "ada@example.test",
			savedAt: "2026-10-10T08:00:00Z",
			instructions: "Answer in Swedish.",
			approvalPatterns: [{ pattern: "^make deploy", reason: "deploys" }],
			skills: { repository: ["review-skill"], library: [skill("notes", "# Notes")], overlays: {} },
			mcp: [{ name: "wiki", transport: "http", url: "https://wiki.example.test/mcp", headers: { authorization: "Bearer ${WIKI_TOKEN}" }, secrets: ["WIKI_TOKEN"], approval: "ask" }],
		};
		const limits = { schema: 1, kind: "limits", revision: 2, savedBy: "admin@example.test", savedAt: "2026-10-10T08:00:00Z", maxTokensCap: 111_000, maxMinutesCap: 7, dailyTokenLimit: 222_000, budgetRaiseCeiling: 333_000 };
		const service = await start({ override, limits }, { WIKI_TOKEN: "wiki-token-value-1234" });
		const profile = await service.profile();
		assert.equal(profile.setup.override.revision, 4);
		assert.equal(profile.setup.override.hash, sha256Hex(JSON.stringify(override)));
		assert.equal(profile.setup.limits.revision, 2);
		assert.equal(profile.setup.rejected, undefined);
		assert.equal(profile.setup.effective.instructions.text, "Answer in Swedish.");
		assert.deepEqual(profile.setup.effective.approvalPatterns, [{ pattern: "^make deploy", reason: "deploys" }]);
		assert.deepEqual(profile.setup.effective.repositorySkills, ["review-skill"]);
		assert.deepEqual(profile.setup.effective.librarySkills, [{ name: "notes", version: 2 }]);
		assert.deepEqual(profile.setup.effective.mcp, [{ name: "wiki", transport: "http", approval: "ask" }]);
		assert.equal(profile.setup.defaults.repositorySkills[0], "verify-skill", "the role's own values stay visible next to the override");
		assert.equal(profile.budgets.maxTokensCap, 111_000);
		assert.equal(profile.budgets.dailyTokenLimit, 222_000);
		assert.doesNotMatch(JSON.stringify(profile), /wiki-token-value|wiki\.example/, "nothing secret on /profile");
	});

	it("leaves a server out, and says why on /profile, when the secret it needs is no longer on the host", async () => {
		const override = { schema: 1, kind: "override", agent: "fixture", revision: 1, savedBy: "ada", savedAt: "2026-10-10T08:00:00Z", mcp: [{ name: "wiki", transport: "http", url: "https://wiki.example.test/mcp", secrets: ["WIKI_TOKEN"], approval: "never" }] };
		const profile = await (await start({ override })).profile();
		assert.equal(profile.setup.override.revision, 1);
		assert.match(profile.setup.effective.mcp[0].error, /needs WIKI_TOKEN/);
	});
});
