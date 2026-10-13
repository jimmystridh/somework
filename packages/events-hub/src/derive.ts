import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const MIN_SECRET_BYTES = 32;

/** Every credential of the event path is derived from the one hub secret, so a leaked webhook URL forges only its own source. */
export function checkSecret(secret: string): string {
	const trimmed = secret.trim();
	if (Buffer.byteLength(trimmed) < MIN_SECRET_BYTES) throw new Error(`the hub secret must be at least ${MIN_SECRET_BYTES} bytes`);
	return trimmed;
}

const derive = (secret: string, label: string): string => createHmac("sha256", secret).update(label).digest("base64url").slice(0, 43);

export const hookToken = (secret: string, source: string, version: number): string => derive(secret, `hook:${source}:${version}`);
export const pullToken = (secret: string): string => derive(secret, "pull");
/** What one agent presents to ask for timers; a leaked token lets one agent schedule events for itself, nothing else. */
export const timerToken = (secret: string, agent: string): string => derive(secret, `timer:${agent}`);
/** What one agent presents to ask for watches on pull requests; a leaked token lets one agent watch for itself, nothing else. No list of agents is kept: the token is derived for whichever agent id is claimed. */
export const watchToken = (secret: string, agent: string): string => derive(secret, `watch:${agent}`);
export const adminToken = (secret: string): string => derive(secret, "admin");
/** The key a code host signs deliveries with for one source (the `github-hmac` check); it is never put in a URL. */
export const signingSecret = (secret: string, source: string, version: number): string => derive(secret, `hmac:${source}:${version}`);

export function safeEqual(a: string, b: string): boolean {
	return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export function githubSignature(signingKey: string, body: Uint8Array): string {
	return `sha256=${createHmac("sha256", signingKey).update(body).digest("hex")}`;
}
