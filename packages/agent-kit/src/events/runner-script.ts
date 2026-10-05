/**
 * The program that runs one handler inside the sandbox: `node runner.mjs <handler.mjs> <input.json>`. It is plain ESM with no
 * dependencies so it runs wherever the agent's tools run. The handler receives the input `{event, agent, now}` and a small `kit`; its
 * `console` goes to stderr, and the decision is the single marked line on stdout. The kit's fetch helpers never add credentials: they
 * talk only to https hosts on the agent's allow-list and refuse authorization and cookie headers.
 */
export const DECISION_MARKER = "@@somework-decision@@";

export const RUNNER_SOURCE = String.raw`import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MARKER = ${JSON.stringify(DECISION_MARKER)};
const [handlerPath, inputPath] = process.argv.slice(2);
const maxOutput = Number(process.env.HANDLER_MAX_OUTPUT ?? 65536);
const hosts = (process.env.HANDLER_FETCH_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);

for (const level of ["log", "info", "warn", "error", "debug"]) {
	console[level] = (...args) => process.stderr.write(redact(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")) + "\n");
}

function redact(text) {
	return String(text)
		.replace(/\b(?:ghp|gho|ghs|ghu|github_pat|xox[abprs]|sk|AKIA)[-_A-Za-z0-9]{8,}/g, "[redacted]")
		.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[redacted]")
		.replace(/\b(authorization|bearer|token|secret|password|api[_-]?key)(["'\s:=]+)([^\s"',;]{8,})/gi, "$1$2[redacted]");
}

async function limitedFetch(url, options = {}) {
	const { timeoutMs = 5000, maxBytes = 262144, headers = {}, ...rest } = options;
	for (const name of Object.keys(headers)) {
		if (/^(authorization|cookie|proxy-authorization|x-api-key)$/i.test(name)) throw new Error("the handler kit does not send credentials: " + name);
	}
	let target = new URL(url);
	for (let hop = 0; hop < 4; hop += 1) {
		if (target.protocol !== "https:") throw new Error("only https URLs can be fetched");
		if (!hosts.includes(target.hostname.toLowerCase())) throw new Error("host " + target.hostname + " is not on this agent's fetch allow-list");
		const response = await fetch(target, { ...rest, headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
		if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
			target = new URL(response.headers.get("location"), target);
			continue;
		}
		const reader = response.body?.getReader();
		const chunks = [];
		let size = 0;
		while (reader) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				throw new Error("the response is larger than " + maxBytes + " bytes");
			}
			chunks.push(value);
		}
		return { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers), text: Buffer.concat(chunks).toString("utf8") };
	}
	throw new Error("too many redirects");
}

const kit = {
	redact,
	async fetchText(url, options) {
		return (await limitedFetch(url, options)).text;
	},
	async fetchJson(url, options) {
		const response = await limitedFetch(url, { ...options, headers: { accept: "application/json", ...(options?.headers ?? {}) } });
		if (!response.ok) throw new Error("request to " + new URL(url).hostname + " answered " + response.status);
		return JSON.parse(response.text);
	},
	log(...args) {
		console.log(...args);
	},
};

try {
	const input = JSON.parse(readFileSync(inputPath, "utf8"));
	const module = await import(pathToFileURL(handlerPath).href);
	if (typeof module.default !== "function") throw new Error("the handler has no default export function");
	const decision = await module.default(input, kit);
	const line = MARKER + JSON.stringify(decision ?? null);
	if (Buffer.byteLength(line) > maxOutput) {
		process.stderr.write("handler output is larger than " + maxOutput + " bytes\n");
		process.exit(3);
	}
	process.stdout.write(line + "\n", () => process.exit(0));
} catch (error) {
	process.stderr.write(redact(error && error.stack ? error.stack : String(error)).slice(0, 4000) + "\n");
	process.exit(1);
}
`;
