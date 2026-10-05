import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { describe, it } from "node:test";
import { Backoff, jittered } from "../src/backoff.ts";
import { Identity } from "../src/identity.ts";

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const seed = Buffer.alloc(32, 7);
const keyFile = { kind: "agent", id: "agent/t", domainId: "development", privateKey: seed.toString("base64url"), publicKey: "" };

describe("identity", () => {
	it("mints an audience-bound, short-lived EdDSA assertion whose signature verifies", () => {
		const identity = new Identity(keyFile);
		const token = identity.mintAssertion("rt_1", 120, 1_700_000_000_000);
		const [header, claims, signature] = token.split(".") as [string, string, string];
		assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "EdDSA", typ: "somework+assertion", kid: "agent:agent/t" });
		const body = JSON.parse(Buffer.from(claims, "base64url").toString());
		assert.equal(body.iss, "agent:agent/t");
		assert.deepEqual(body.aud, ["somework:development"]);
		assert.equal(body.exp - body.iat, 120);
		assert.equal(body.runtimeInstanceId, "rt_1");
		assert.match(body.jti, /^[0-9a-f]{32}$/);

		const publicKey = createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" }));
		assert.ok(publicKey.export({ format: "der", type: "spki" }).subarray(0, 12).equals(SPKI_ED25519_PREFIX));
		assert.ok(verify(null, Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url")));
	});

	it("never repeats a jti", () => {
		const identity = new Identity(keyFile);
		const ids = new Set(Array.from({ length: 50 }, () => JSON.parse(Buffer.from(identity.mintAssertion().split(".")[1]!, "base64url").toString()).jti));
		assert.equal(ids.size, 50);
	});

	it("rejects a malformed private key", () => {
		assert.throws(() => new Identity({ ...keyFile, privateKey: "AAAA" }), /32 bytes/);
	});
});

describe("backoff", () => {
	it("grows exponentially, stays jittered and is capped", () => {
		const backoff = new Backoff(1000, 30_000);
		const ceilings: number[] = [];
		for (let i = 0; i < 8; i++) {
			const ceiling = backoff.ceilingMs();
			const delay = backoff.nextDelayMs();
			assert.ok(delay >= ceiling / 2 && delay <= ceiling, `${delay} outside [${ceiling / 2}, ${ceiling}]`);
			ceilings.push(ceiling / 1000);
		}
		assert.deepEqual(ceilings, [1, 2, 4, 8, 16, 30, 30, 30]);
		backoff.reset();
		assert.equal(backoff.ceilingMs(), 1000);
	});

	it("spreads periodic intervals", () => {
		const values = Array.from({ length: 50 }, () => jittered(20_000));
		assert.ok(values.every((v) => v >= 16_000 && v <= 24_000));
		assert.ok(new Set(values).size > 1);
	});
});
