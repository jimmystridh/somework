import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserBackend, ErrorSummary, PageInfo, PrintRecord, WaitOptions } from "./backend.ts";
import { isAllowedUrl } from "./policy.ts";

export interface FakePage {
	title: string;
	/** Lines of the outline; a control is written `[ref] role "name"`. */
	lines: string[];
}

/** A browser without a browser: pages are given up front, every call is recorded. Used by the tests and by the smoke test on a machine without Edge. */
export class FakeBackend implements BrowserBackend {
	readonly calls: string[] = [];
	readonly #pages: Record<string, FakePage>;
	readonly #allowHosts: readonly string[];
	#url = "about:blank";
	#recording: string | undefined;
	#videos = 0;
	failOn: string | undefined;

	constructor(pages: Record<string, FakePage>, allowHosts: readonly string[] = ["127.0.0.1", "localhost"]) {
		this.#pages = pages;
		this.#allowHosts = allowHosts;
	}

	#info(): PageInfo {
		return { url: this.#url, title: this.#pages[this.#url]?.title ?? "" };
	}

	#record(call: string): void {
		this.calls.push(call);
		if (this.failOn && call.startsWith(this.failOn)) throw new Error(`fake failure for ${call}`);
	}

	async open(url: string): Promise<PageInfo> {
		this.#record(`open ${url}`);
		const checked = isAllowedUrl(url, this.#allowHosts);
		if (!checked.ok) throw new Error(checked.reason);
		if (!this.#pages[url]) throw new Error(`404 ${url}`);
		this.#url = url;
		return this.#info();
	}
	async snapshot() {
		this.#record("snapshot");
		return { ...this.#info(), text: (this.#pages[this.#url]?.lines ?? []).join("\n"), truncated: false };
	}
	async click(ref: string) {
		this.#record(`click ${ref}`);
		return this.#info();
	}
	async clickText(text: string) {
		this.#record(`clickText ${text}`);
		return this.#info();
	}
	async fill(ref: string, text: string) {
		this.#record(`fill ${ref} ${text}`);
		return this.#info();
	}
	async upload(ref: string | undefined, file: string) {
		this.#record(`upload ${ref ?? "-"} ${file}`);
		return this.#info();
	}
	async press(key: string) {
		this.#record(`press ${key}`);
		return this.#info();
	}
	async wait(options: WaitOptions) {
		this.#record(`wait ${JSON.stringify(options)}`);
		return this.#info();
	}
	async screenshot(file: string) {
		this.#record(`screenshot ${file}`);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, Buffer.from("89504e470d0a1a0a", "hex"));
	}
	async errors(): Promise<ErrorSummary> {
		this.#record("errors");
		return { console: [], pageErrors: [], network: [], truncated: false };
	}
	async prints(): Promise<PrintRecord[]> {
		this.#record("prints");
		return [];
	}
	async videoStart(dir: string) {
		this.#record(`videoStart ${dir}`);
		this.#recording = dir;
	}
	async videoStop() {
		this.#record("videoStop");
		if (!this.#recording) return undefined;
		const file = join(this.#recording, `fake-${++this.#videos}.webm`);
		mkdirSync(this.#recording, { recursive: true });
		writeFileSync(file, Buffer.concat([Buffer.from("1a45dfa3", "hex"), Buffer.alloc(4096, 1)]));
		this.#recording = undefined;
		return file;
	}
	async close() {
		this.#record("close");
	}
}
