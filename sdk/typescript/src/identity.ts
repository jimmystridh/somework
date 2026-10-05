import { createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

/** The key file written by `somework admin enroll-agent` or `somework-sidecar keygen`. */
export interface KeyFile {
	kind: string;
	id: string;
	domainId: string;
	privateKey: string;
	publicKey: string;
}

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const b64u = (value: Buffer | string): string => Buffer.from(value).toString("base64url");

export function loadKeyFile(path: string): KeyFile {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<KeyFile>;
	for (const field of ["kind", "id", "domainId", "privateKey", "publicKey"] as const) {
		if (typeof parsed[field] !== "string" || parsed[field] === "") throw new Error(`key file ${path}: missing ${field}`);
	}
	return parsed as KeyFile;
}

/** A principal's own signing identity. The private key stays in this object and is never put in a request. */
export class Identity {
	readonly issuer: string;
	readonly audience: string;
	readonly agentId: string;
	readonly #key: KeyObject;

	constructor(keyFile: KeyFile) {
		const seed = Buffer.from(keyFile.privateKey, "base64url");
		if (seed.length !== 32) throw new Error("the private key must be 32 bytes");
		this.#key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
		this.issuer = `${keyFile.kind}:${keyFile.id}`;
		this.audience = `somework:${keyFile.domainId}`;
		this.agentId = keyFile.id;
	}

	static fromFile(path: string): Identity {
		return new Identity(loadKeyFile(path));
	}

	/** A short-lived, audience-bound client assertion (EdDSA compact JWS), like the Rust client's `mint_assertion`. */
	mintAssertion(runtimeInstanceId?: string, ttlSeconds = 120, now = Date.now()): string {
		const iat = Math.floor(now / 1000);
		const claims: Record<string, unknown> = {
			iss: this.issuer,
			sub: this.issuer,
			aud: [this.audience],
			iat,
			exp: iat + ttlSeconds,
			jti: randomBytes(16).toString("hex"),
		};
		if (runtimeInstanceId) claims.runtimeInstanceId = runtimeInstanceId;
		const header = { alg: "EdDSA", typ: "somework+assertion", kid: this.issuer };
		const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
		return `${signingInput}.${b64u(sign(null, Buffer.from(signingInput), this.#key))}`;
	}
}

/** A runtime instance id is minted per process: two workers of one agent are distinct runtimes. */
export function newRuntimeInstanceId(): string {
	return `rt_${randomBytes(13).toString("hex").toUpperCase()}`;
}
