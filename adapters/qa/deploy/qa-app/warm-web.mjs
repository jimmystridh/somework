// Loads the web app's initial module graph once, the way a browser does, so that the dev server has transformed it before the agent opens a page.
// A cold dev server on this two-processor machine needs minutes for that, and the agent gives up on a blank page.
//   node warm-web.mjs <port> [seconds]
const port = Number(process.argv[2] ?? 4499);
const budgetMs = Number(process.argv[3] ?? 180) * 1000;
const base = `http://127.0.0.1:${port}`;
const started = Date.now();
const seen = new Set();
const queue = ["/"];
let fetched = 0;
let failed = 0;

const staticImports = /(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/g;
const attribute = /<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["']/gi;

function candidates(text, type, from) {
	const found = [];
	const pattern = type.includes("html") ? attribute : staticImports;
	for (const match of text.matchAll(pattern)) {
		const specifier = match[1];
		if (/^(https?:|data:|blob:|\/\/)/.test(specifier)) continue;
		if (!specifier.startsWith("/") && !specifier.startsWith(".")) continue;
		try {
			const url = new URL(specifier, new URL(from, base));
			if (url.origin === base) found.push(url.pathname + url.search);
		} catch {}
	}
	return found;
}

async function visit(path) {
	if (seen.has(path)) return;
	seen.add(path);
	try {
		const response = await fetch(base + path, { signal: AbortSignal.timeout(60_000) });
		const type = response.headers.get("content-type") ?? "";
		fetched++;
		if (!response.ok) { failed++; return; }
		if (!/html|javascript|typescript|css/.test(type) && !/\.(m?[jt]sx?)(\?|$)/.test(path)) { await response.arrayBuffer(); return; }
		const text = await response.text();
		if (/css/.test(type)) return;
		for (const next of candidates(text, type, path)) if (!seen.has(next)) queue.push(next);
	} catch {
		failed++;
	}
}

async function worker() {
	while (Date.now() - started < budgetMs) {
		const next = queue.shift();
		if (next === undefined) { if (active === 0) return; await new Promise((resolve) => setTimeout(resolve, 100)); continue; }
		active++;
		try { await visit(next); } finally { active--; }
	}
}
let active = 0;
await Promise.all([worker(), worker(), worker()]);
console.log(`warmed ${fetched} modules (${failed} failed, ${queue.length} left) in ${Math.round((Date.now() - started) / 1000)}s`);
