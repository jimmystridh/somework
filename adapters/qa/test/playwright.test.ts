import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { PlaywrightBackend } from "../src/browser/playwright.ts";

// The real backend, against a tiny local page. It needs an installed Edge (the channel the production machine uses), so it is skipped on
// a machine without one.
const EDGE = ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find((path) => existsSync(path));

const PAGE = `<!doctype html><html><head><title>Invoice form</title></head><body>
<h1>Invoice</h1>
<label for="customer">Customer</label><input id="customer" type="text" placeholder="name">
<input id="secret" type="password" value="hunter2">
<button id="add" onclick="document.getElementById('out').textContent = 'Total: ' + (document.getElementById('customer').value.length * 10)">Calculate</button>
<p id="out">Total: 0</p>
<a id="away" href="http://example.invalid/page">elsewhere</a>
<button id="boom" onclick="console.error('exploded'); fetch('/missing')">Break</button>
<div style="display:none"><button>hidden</button></div>
<button id="print" onclick="document.getElementById('frame').contentWindow.print()">Print</button>
<iframe id="frame" srcdoc="<title>Invoice 7</title><p>Total 70 kr</p><script>window.addEventListener('afterprint', function () { parent.document.getElementById('after').textContent = 'print finished' })</script>"></iframe>
<p id="after">not printed</p>
<script>console.warn('page loaded')</script>
</body></html>`;

describe("the Playwright backend", { skip: EDGE ? false : "no installed Edge on this machine" }, () => {
	let server: Server;
	let base: string;
	let backend: PlaywrightBackend;
	const dir = mkdtempSync(join(tmpdir(), "qa-pw-"));

	before(async () => {
		server = createServer((req, res) => {
			if (req.url === "/") {
				res.setHeader("content-type", "text/html");
				return res.end(PAGE);
			}
			res.statusCode = 404;
			res.end("missing");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
		backend = await PlaywrightBackend.launch({ channel: "msedge", allowHosts: ["127.0.0.1", "localhost"], executablePath: EDGE });
	});
	after(async () => {
		await backend?.close();
		server.close();
	});

	const ref = (text: string, name: string): string => {
		const line = text.split("\n").find((candidate) => candidate.includes(name));
		const found = /\[(e[0-9]+)\]/.exec(line ?? "");
		assert.ok(found, `a control named ${name} in:\n${text}`);
		return found[1]!;
	};

	it("opens a page and outlines it with refs; hidden controls and passwords stay out", async () => {
		const info = await backend.open(base);
		assert.equal(info.title, "Invoice form");
		const { text } = await backend.snapshot();
		assert.match(text, /# Invoice/);
		assert.match(text, /textbox "Customer"/);
		assert.match(text, /button "Calculate"/);
		assert.match(text, /link "elsewhere"/);
		assert.doesNotMatch(text, /hidden/);
		assert.doesNotMatch(text, /hunter2/);
	});

	it("fills a field and clicks a button by ref, and sees the result", async () => {
		const { text } = await backend.snapshot();
		await backend.fill(ref(text, 'textbox "Customer"'), "ACME");
		await backend.click(ref(text, 'button "Calculate"'));
		await backend.wait({ text: "Total: 40" });
		const after = await backend.snapshot();
		assert.match(after.text, /Total: 40/);
		assert.match(after.text, /value="ACME"/);
	});

	it("refuses a ref that is not on the page", async () => {
		await assert.rejects(() => backend.click("e999"), /no control e999/);
		await assert.rejects(() => backend.click("a[href]"), /not a ref/);
	});

	it("collects console and network errors since the page opened", async () => {
		await backend.open(base);
		const { text } = await backend.snapshot();
		await backend.click(ref(text, 'button "Break"'));
		await backend.wait({ ms: 300 });
		const errors = await backend.errors();
		assert.ok(errors.console.some((line) => line.includes("exploded")), JSON.stringify(errors));
		assert.ok(errors.network.some((line) => line.startsWith("404 GET") && line.endsWith("/missing")), JSON.stringify(errors));
	});

	it("notes what the page prints, and lets it carry on as after a finished print", async () => {
		await backend.open(base);
		assert.deepEqual(await backend.prints(), []);
		const { text } = await backend.snapshot();
		await backend.click(ref(text, 'button "Print"'));
		await backend.wait({ ms: 300 });
		const printed = await backend.prints();
		assert.equal(printed.length, 1, JSON.stringify(printed));
		assert.equal(printed[0]!.title, "Invoice 7");
		assert.match(printed[0]!.text, /Total 70 kr/);
		assert.match((await backend.snapshot()).text, /print finished/);
	});

	it("blocks a link to a host that is not allowed instead of leaving the machine", async () => {
		await backend.open(base);
		const { text } = await backend.snapshot();
		await backend.click(ref(text, 'link "elsewhere"')).catch(() => {});
		await backend.wait({ ms: 300 });
		assert.match((await backend.errors()).network.join("\n"), /blocked http:\/\/example\.invalid\/page/);
	});

	it("takes a screenshot", async () => {
		const file = join(dir, "shots", "page.png");
		await backend.screenshot(file);
		assert.equal(readFileSync(file).subarray(1, 4).toString(), "PNG");
	});

	it("records a video of the decisive pass and keeps working afterwards", async () => {
		await backend.open(base);
		const { text } = await backend.snapshot();
		await backend.videoStart(join(dir, "videos"));
		// the refs of the outline taken before the recording still work: starting it reloads the page but not the numbering
		await backend.fill(ref(text, 'textbox "Customer"'), "Video");
		await backend.click(ref(text, 'button "Calculate"'));
		await backend.wait({ text: "Total: 50" });
		const video = await backend.videoStop();
		assert.ok(video && video.endsWith(".webm"), String(video));
		assert.ok(statSync(video!).size > 1000, "a real recording, not an empty file");
		assert.equal(readFileSync(video!).subarray(0, 4).toString("hex"), "1a45dfa3", "WebM/EBML header");
		assert.equal((await backend.snapshot()).title, "Invoice form", "the page is back after the recording");
		assert.equal(await backend.videoStop(), undefined, "nothing is being recorded any more");
	});
});
