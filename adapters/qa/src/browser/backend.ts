/** What the daemon needs of a browser. Playwright implements it for real; `FakeBackend` for tests and for a machine without the browser. */
export interface PageInfo {
	url: string;
	title: string;
}

export interface WaitOptions {
	ms?: number;
	text?: string;
	selector?: string;
	timeoutMs?: number;
}

export interface ErrorSummary {
	console: string[];
	pageErrors: string[];
	network: string[];
	truncated: boolean;
}

export interface BrowserBackend {
	open(url: string): Promise<PageInfo>;
	/** A text outline of the page; every control has a ref (`e12`) that `click` and `fill` take. Refs are valid until the next snapshot. */
	snapshot(): Promise<PageInfo & { text: string; truncated: boolean }>;
	click(ref: string): Promise<PageInfo>;
	/** Clicks the element whose visible text is exactly `text` (the first one): for tree nodes and labels the outline gives no ref. */
	clickText(text: string): Promise<PageInfo>;
	fill(ref: string, text: string): Promise<PageInfo>;
	press(key: string): Promise<PageInfo>;
	wait(options: WaitOptions): Promise<PageInfo>;
	/** Writes a PNG to `file`. */
	screenshot(file: string): Promise<void>;
	errors(): Promise<ErrorSummary>;
	/** Starts recording the page into `dir` (the page is reopened on the same URL and keeps its cookies and storage). */
	videoStart(dir: string): Promise<void>;
	/** Stops recording and returns the finished .webm file, or undefined when nothing was recording. */
	videoStop(): Promise<string | undefined>;
	close(): Promise<void>;
}
