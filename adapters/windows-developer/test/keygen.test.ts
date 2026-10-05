import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Identity } from "@somework/sdk";

const script = new URL("../deploy/keygen.ts", import.meta.url).pathname;
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

describe("keygen", () => {
	it("writes a key file the SDK can sign with, prints the matching public key, and never overwrites", () => {
		const out = join(mkdtempSync(join(tmpdir(), "windev-key-")), "agent.key.json");
		const run = spawnSync("node", [script, "--id", "agent/windows-developer", "--domain", "development", "--out", out], { encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
		const printed = JSON.parse(run.stdout.trim().split("\n").pop()!);
		assert.equal(printed.id, "agent/windows-developer");
		assert.ok(!run.stdout.includes(JSON.parse(readFileSync(out, "utf8")).privateKey), "the private key is not printed");
		if (process.platform !== "win32") assert.equal(statSync(out).mode & 0o777, 0o600);

		const identity = Identity.fromFile(out);
		assert.equal(identity.issuer, "agent:agent/windows-developer");
		assert.equal(identity.audience, "somework:development");
		const [header, claims, signature] = identity.mintAssertion().split(".");
		const publicKey = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(printed.publicKey, "base64url")]), format: "der", type: "spki" });
		assert.equal(verify(null, Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature!, "base64url")), true, "the printed public key verifies the assertions");

		const again = spawnSync("node", [script, "--id", "agent/windows-developer", "--out", out], { encoding: "utf8" });
		assert.notEqual(again.status, 0, "an existing key file is never overwritten");
		assert.ok(existsSync(out));
	});

	it("refuses ids that are not agent ids", () => {
		const out = join(mkdtempSync(join(tmpdir(), "windev-key-")), "k.json");
		assert.equal(spawnSync("node", [script, "--id", "../evil", "--out", out], { encoding: "utf8" }).status, 2);
		assert.equal(existsSync(out), false);
	});
});
