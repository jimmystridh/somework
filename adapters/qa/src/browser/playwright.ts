import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BrowserBackend, ErrorSummary, PageInfo, WaitOptions } from "./backend.ts";
import { displayUrl, isAllowedUrl } from "./policy.ts";
import { buildSnapshot } from "./snapshot-script.ts";

export interface PlaywrightOptions {
	/** The installed browser to drive: `msedge` on the Windows machine. */
	channel: string;
	allowHosts: readonly string[];
	/** For tests that want a specific binary. */
	executablePath?: string;
	size?: { width: number; height: number };
	maxSnapshotLines?: number;
	maxSnapshotChars?: number;
}

/** The encoder shares two processors with the application: a smaller picture keeps `video-stop` from taking minutes. */
const VIDEO_SIZE = { width: 800, height: 450 };
const MAX_ERRORS = 30;
const NAVIGATION_TIMEOUT = 90_000;

/**
 * Playwright (`playwright-core`, no bundled browsers) driving the installed Edge headlessly. One context and one page at a time. The
 * context only reaches hosts the daemon allows; recording a video means a fresh context with video on, carrying the cookies and local
 * storage of the old one, because Playwright records per context. The page is reloaded then, and keeps the refs of its last outline.
 */
export class PlaywrightBackend implements BrowserBackend {
	readonly #options: PlaywrightOptions;
	readonly #size: { width: number; height: number };
	#browser: any;
	#context: any;
	#page: any;
	#outlined = false;
	#errors: ErrorSummary = { console: [], pageErrors: [], network: [], truncated: false };

	private constructor(options: PlaywrightOptions) {
		this.#options = options;
		this.#size = options.size ?? { width: 1280, height: 720 };
	}

	static async launch(options: PlaywrightOptions): Promise<PlaywrightBackend> {
		const { chromium } = await import("playwright-core");
		const backend = new PlaywrightBackend(options);
		backend.#browser = await chromium.launch({ headless: true, ...(options.executablePath ? { executablePath: options.executablePath } : { channel: options.channel }) });
		await backend.#newContext();
		return backend;
	}

	#note(kind: keyof Omit<ErrorSummary, "truncated">, text: string): void {
		if (this.#errors[kind].length >= MAX_ERRORS) {
			this.#errors.truncated = true;
			return;
		}
		this.#errors[kind].push(text.replace(/\s+/g, " ").slice(0, 300));
	}

	async #newContext(recordDir?: string, storageState?: unknown): Promise<void> {
		const context = await this.#browser.newContext({
			viewport: this.#size,
			...(recordDir ? { recordVideo: { dir: recordDir, size: VIDEO_SIZE } } : {}),
			...(storageState ? { storageState } : {}),
		});
		await context.route("**/*", (route: any) => {
			const url: string = route.request().url();
			if (url.startsWith("data:") || url.startsWith("blob:") || url === "about:blank") return route.continue();
			const verdict = isAllowedUrl(url, this.#options.allowHosts);
			if (verdict.ok) return route.continue();
			this.#note("network", `blocked ${displayUrl(url)} (${verdict.reason})`);
			return route.abort("blockedbyclient");
		});
		const page = await context.newPage();
		page.setDefaultTimeout(30_000);
		page.on("console", (message: any) => {
			if (message.type() === "error" || message.type() === "warning") this.#note("console", `${message.type()}: ${message.text()}`);
		});
		page.on("pageerror", (error: Error) => this.#note("pageErrors", error.message));
		page.on("requestfailed", (request: any) => this.#note("network", `failed ${request.method()} ${displayUrl(request.url())}: ${request.failure()?.errorText ?? "?"}`));
		page.on("response", (response: any) => {
			if (response.status() >= 400) this.#note("network", `${response.status()} ${response.request().method()} ${displayUrl(response.url())}`);
		});
		this.#context = context;
		this.#page = page;
	}

	#info = async (): Promise<PageInfo> => ({ url: this.#page.url(), title: await this.#page.title().catch(() => "") });

	async open(url: string): Promise<PageInfo> {
		this.#errors = { console: [], pageErrors: [], network: [], truncated: false };
		await this.#page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT });
		return this.#info();
	}

	async snapshot() {
		this.#outlined = true;
		const shot = await this.#page.evaluate(buildSnapshot, { maxLines: this.#options.maxSnapshotLines ?? 400, maxChars: this.#options.maxSnapshotChars ?? 20_000 });
		return { ...(await this.#info()), text: shot.lines.join("\n"), truncated: shot.truncated };
	}

	#target(ref: string): any {
		if (!/^e[0-9]{1,5}$/.test(ref)) throw new Error("not a ref");
		return this.#page.locator(`[data-qa-ref="${ref}"]`);
	}

	async click(ref: string): Promise<PageInfo> {
		const target = this.#target(ref);
		if ((await target.count()) === 0) throw new Error(`no control ${ref} on the page (take a new snapshot)`);
		await target.first().click({ timeout: 30_000 });
		await this.#page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
		return this.#info();
	}

	async clickText(text: string): Promise<PageInfo> {
		const target = this.#page.getByText(text, { exact: true });
		if ((await target.count()) === 0) throw new Error(`no element with the text "${text}" on the page (take a new snapshot)`);
		await target.first().click({ timeout: 30_000 });
		await this.#page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
		return this.#info();
	}

	async fill(ref: string, text: string): Promise<PageInfo> {
		const target = this.#target(ref);
		if ((await target.count()) === 0) throw new Error(`no control ${ref} on the page (take a new snapshot)`);
		await target.first().fill(text, { timeout: 30_000 });
		return this.#info();
	}

	async press(key: string): Promise<PageInfo> {
		await this.#page.keyboard.press(key);
		await this.#page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
		return this.#info();
	}

	async wait(options: WaitOptions): Promise<PageInfo> {
		const timeout = options.timeoutMs ?? 30_000;
		if (options.ms !== undefined) await this.#page.waitForTimeout(options.ms);
		if (options.text !== undefined) await this.#page.getByText(options.text).first().waitFor({ timeout });
		if (options.selector !== undefined) await this.#page.locator(options.selector).first().waitFor({ timeout });
		return this.#info();
	}

	async screenshot(file: string): Promise<void> {
		mkdirSync(dirname(file), { recursive: true });
		await this.#page.screenshot({ path: file, fullPage: false });
	}

	async errors(): Promise<ErrorSummary> {
		return { ...this.#errors, console: [...this.#errors.console], pageErrors: [...this.#errors.pageErrors], network: [...this.#errors.network] };
	}

	async #reopen(recordDir: string | undefined): Promise<string | undefined> {
		const url: string = this.#page.url();
		const state = await this.#context.storageState().catch(() => undefined);
		const video = recordDir === undefined ? this.#page.video() : null;
		await this.#context.close();
		const finished: string | undefined = video ? await video.path().catch(() => undefined) : undefined;
		await this.#newContext(recordDir, state);
		if (/^https?:/.test(url) && isAllowedUrl(url, this.#options.allowHosts).ok) {
			await this.#page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT }).catch(() => {});
			// a page that was outlined before keeps its refs: the same page numbers its controls the same way
			if (this.#outlined) await this.snapshot().catch(() => {});
		}
		return finished;
	}

	async videoStart(dir: string): Promise<void> {
		mkdirSync(dir, { recursive: true });
		await this.#reopen(dir);
	}

	async videoStop(): Promise<string | undefined> {
		return this.#reopen(undefined);
	}

	async close(): Promise<void> {
		await this.#context?.close().catch(() => {});
		await this.#browser?.close().catch(() => {});
	}
}
