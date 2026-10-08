import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { BrowserBackend } from "./backend.ts";
import { displayUrl, isAllowedUrl, safeName } from "./policy.ts";

export interface DaemonOptions {
	backend: BrowserBackend;
	/** Where state, screenshots and videos go. Created if missing. */
	dir: string;
	allowHosts: readonly string[];
	/** For tests: how long a snapshot may be before it is cut. */
	maxSnapshotChars?: number;
}

export interface DaemonFiles {
	videos: string[];
	screenshots: string[];
}

const MAX_BODY = 64 * 1024;
const REF = /^e[0-9]{1,5}$/;

class UsageError extends Error {}

/**
 * The persistent browser of one verification: a loopback HTTP server in the harness process in front of a `BrowserBackend`. The model drives
 * it through the `qa-browser` command line (see `cli.ts`), which reads the port and token from the state file. One command runs at a time.
 * The daemon, not the model, decides where files go and which hosts the browser may visit.
 */
export class BrowserDaemon {
	readonly dir: string;
	readonly statePath: string;
	readonly #backend: BrowserBackend;
	readonly #allowHosts: readonly string[];
	readonly #maxSnapshot: number;
	readonly #token = randomBytes(24).toString("hex");
	#server: Server | undefined;
	#queue: Promise<unknown> = Promise.resolve();
	#recording = false;
	#videoCount = 0;
	#screenshotCount = 0;
	#closed = false;

	private constructor(options: DaemonOptions) {
		this.dir = options.dir;
		this.statePath = join(options.dir, "browser.json");
		this.#backend = options.backend;
		this.#allowHosts = options.allowHosts;
		this.#maxSnapshot = options.maxSnapshotChars ?? 24_000;
	}

	static async start(options: DaemonOptions): Promise<BrowserDaemon> {
		mkdirSync(join(options.dir, "videos"), { recursive: true });
		mkdirSync(join(options.dir, "screenshots"), { recursive: true });
		const daemon = new BrowserDaemon(options);
		await daemon.#listen();
		return daemon;
	}

	async #listen(): Promise<void> {
		this.#server = createServer((request, response) => {
			const reply = (status: number, body: unknown) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify(body));
			};
			const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
			const given = Buffer.from(bearer);
			const wanted = Buffer.from(this.#token);
			if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return reply(401, { ok: false, error: "not authorised" });
			if (request.method !== "POST" || request.url !== "/cmd") return reply(404, { ok: false, error: "unknown route" });
			let body = "";
			let size = 0;
			request.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_BODY) request.destroy();
				else body += chunk.toString("utf8");
			});
			request.on("end", () => {
				let parsed: { cmd?: unknown; args?: unknown };
				try {
					parsed = JSON.parse(body);
				} catch {
					return reply(400, { ok: false, error: "the request is not JSON" });
				}
				const args = parsed.args && typeof parsed.args === "object" ? (parsed.args as Record<string, unknown>) : {};
				const run = this.#queue.then(() => this.#command(String(parsed.cmd), args));
				this.#queue = run.catch(() => {});
				run.then(
					(text) => reply(200, { ok: true, text }),
					(error) => reply(error instanceof UsageError ? 400 : 200, { ok: false, error: error instanceof Error ? error.message.slice(0, 1000) : String(error) }),
				);
			});
		});
		await new Promise<void>((resolve, reject) => {
			this.#server!.once("error", reject);
			this.#server!.listen(0, "127.0.0.1", () => resolve());
		});
		const { port } = this.#server.address() as { port: number };
		writeFileSync(this.statePath, JSON.stringify({ port, token: this.#token, dir: this.dir }), { mode: 0o600 });
	}

	async #command(cmd: string, args: Record<string, unknown>): Promise<string> {
		const str = (name: string, max: number, required = true): string => {
			const value = args[name];
			if (value === undefined && !required) return "";
			if (typeof value !== "string" || value.length === 0 || value.length > max) throw new UsageError(`${cmd}: ${name} must be a text of 1 to ${max} characters`);
			return value;
		};
		const ref = (): string => {
			const value = str("ref", 8);
			if (!REF.test(value)) throw new UsageError(`${cmd}: ref must look like e12 (take it from the last snapshot)`);
			return value;
		};
		const page = (info: { url: string; title: string }): string => `${displayUrl(info.url)}${info.title ? ` - ${info.title.slice(0, 120)}` : ""}`;
		switch (cmd) {
			case "open": {
				const url = str("url", 2000);
				const checked = isAllowedUrl(url, this.#allowHosts);
				if (!checked.ok) throw new UsageError(`open: ${checked.reason}`);
				return `opened ${page(await this.#backend.open(url))}`;
			}
			case "snapshot": {
				const shot = await this.#backend.snapshot();
				const text = shot.text.length > this.#maxSnapshot ? `${shot.text.slice(0, this.#maxSnapshot)}\n[outline cut]` : shot.text;
				return `url: ${displayUrl(shot.url)}\ntitle: ${shot.title.slice(0, 200)}\n${text}${shot.truncated ? "\n[outline cut]" : ""}`;
			}
			case "click":
				return `clicked ${args.ref}; now ${page(await this.#backend.click(ref()))}`;
			case "click-text":
				return `clicked "${str("text", 80)}"; now ${page(await this.#backend.clickText(str("text", 80)))}`;
			case "fill":
				return `filled ${args.ref}; now ${page(await this.#backend.fill(ref(), str("text", 5000)))}`;
			case "press":
				return `pressed; now ${page(await this.#backend.press(str("key", 40)))}`;
			case "wait": {
				const ms = args.ms === undefined ? undefined : Number(args.ms);
				if (ms !== undefined && (!Number.isFinite(ms) || ms < 0 || ms > 30_000)) throw new UsageError("wait: ms must be from 0 to 30000");
				const text = args.text === undefined ? undefined : str("text", 300);
				const selector = args.selector === undefined ? undefined : str("selector", 300);
				if (ms === undefined && text === undefined && selector === undefined) throw new UsageError("wait: give --ms, --text or --selector");
				return `waited; now ${page(await this.#backend.wait({ ms, text, selector, timeoutMs: 30_000 }))}`;
			}
			case "screenshot": {
				const name = safeName(typeof args.name === "string" ? args.name : undefined, `screenshot-${++this.#screenshotCount}`);
				const file = join(this.dir, "screenshots", `${name}.png`);
				await this.#backend.screenshot(file);
				return `saved screenshots/${name}.png`;
			}
			case "errors": {
				const summary = await this.#backend.errors();
				const lines = [...summary.pageErrors.map((e) => `page error: ${e}`), ...summary.console.map((e) => `console: ${e}`), ...summary.network.map((e) => `network: ${e}`)];
				return lines.length === 0 ? "no console, page or network errors" : `${lines.join("\n")}${summary.truncated ? "\n[more not shown]" : ""}`;
			}
			case "video-start": {
				if (this.#recording) throw new UsageError("video-start: already recording; run video-stop first");
				await this.#backend.videoStart(join(this.dir, "videos"));
				this.#recording = true;
				return "recording started (the page was reloaded, so typed text is gone and the refs of your last snapshot still apply; do the decisive steps now, then run video-stop)";
			}
			case "video-stop": {
				if (!this.#recording) throw new UsageError("video-stop: not recording");
				const raw = await this.#backend.videoStop();
				this.#recording = false;
				if (!raw) throw new Error("the recording produced no file");
				const name = `qa-video-${++this.#videoCount}.webm`;
				renameSync(raw, join(this.dir, "videos", name));
				return `saved videos/${name}`;
			}
			case "status":
				return `recording: ${this.#recording}\nfiles: ${JSON.stringify(this.files())}`;
			default:
				throw new UsageError(`unknown command "${cmd}" (open, snapshot, click, click-text, fill, press, wait, screenshot, errors, video-start, video-stop, status)`);
		}
	}

	/** What the verification produced so far, as paths relative to the directory. */
	files(): DaemonFiles {
		const list = (sub: string, extension: string): string[] => {
			try {
				return readdirSync(join(this.dir, sub)).filter((name) => name.endsWith(extension) && statSync(join(this.dir, sub, name)).isFile()).sort().map((name) => `${sub}/${name}`);
			} catch {
				return [];
			}
		};
		return { videos: list("videos", ".webm"), screenshots: list("screenshots", ".png") };
	}

	/** Finishes a recording that is still open (the model forgot video-stop), closes the browser and the server. Safe to call twice. */
	async stop(): Promise<DaemonFiles> {
		if (this.#closed) return this.files();
		this.#closed = true;
		await this.#queue.catch(() => {});
		if (this.#recording) {
			try {
				const raw = await this.#backend.videoStop();
				if (raw) renameSync(raw, join(this.dir, "videos", `qa-video-${++this.#videoCount}.webm`));
			} catch {
				// a recording that cannot be finished is simply not evidence
			}
			this.#recording = false;
		}
		await this.#backend.close().catch(() => {});
		await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
		this.#server?.closeAllConnections?.();
		return this.files();
	}
}
