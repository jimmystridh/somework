/**
 * Where the browser may go. The application under test runs on this machine, so by default only loopback; anything else (the internet,
 * the intranet, `file:`, `data:`) is refused before a request leaves, so a page cannot talk the agent into reading or sending somewhere else.
 */
export function isAllowedUrl(url: string, allowHosts: readonly string[]): { ok: true; url: URL } | { ok: false; reason: string } {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { ok: false, reason: `not a URL: ${url.slice(0, 200)}` };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, reason: `only http and https pages are allowed, not ${parsed.protocol}` };
	if (parsed.username || parsed.password) return { ok: false, reason: "credentials in a URL are not allowed" };
	const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	const allowed = allowHosts.map((entry) => entry.replace(/^\[|\]$/g, "").toLowerCase());
	if (!allowed.includes(host)) return { ok: false, reason: `the host ${host} is not allowed (allowed: ${allowed.join(", ")})` };
	return { ok: true, url: parsed };
}

/** Query strings and fragments can carry tokens: a URL is reported without them. */
export function displayUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return url.slice(0, 200);
	}
}

/** A file name the model chose for a screenshot: letters, digits, dot, dash, underscore, at most 64 characters, never a path. */
export function safeName(name: string | undefined, fallback: string): string {
	const cleaned = (name ?? "").replace(/\.(png|webm)$/i, "");
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(cleaned) ? cleaned : fallback;
}
