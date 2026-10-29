import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CliUsageError, parseCli, send } from "../src/browser/client.ts";
import { BrowserDaemon } from "../src/browser/daemon.ts";
import { FakeBackend } from "../src/browser/fake.ts";
import { displayUrl, isAllowedUrl, safeName } from "../src/browser/policy.ts";

describe("where the browser may go", () => {
	const allow = ["127.0.0.1", "localhost"];
	it("allows the application's own addresses only", () => {
		for (const url of ["http://127.0.0.1:3000/", "http://localhost/x?y=1", "https://LOCALHOST:8443/"]) assert.equal(isAllowedUrl(url, allow).ok, true, url);
		for (const url of ["https://example.com/", "http://10.0.0.5/", "http://127.0.0.1.evil.test/", "file:///etc/passwd", "data:text/html,hi", "javascript:alert(1)", "http://user:pw@127.0.0.1/", "not a url", "http://[::1]:3000/"]) assert.equal(isAllowedUrl(url, allow).ok, false, url);
		assert.equal(isAllowedUrl("http://[::1]:3000/", ["::1"]).ok, true, "IPv6 loopback when configured");
	});
	it("shows URLs without query or fragment, and accepts only plain file names", () => {
		assert.equal(displayUrl("http://127.0.0.1:3000/a/b?token=secret#frag"), "http://127.0.0.1:3000/a/b");
		assert.equal(safeName("after-fix", "x"), "after-fix");
		assert.equal(safeName("after.PNG", "x"), "after");
		for (const bad of ["../x", "a/b", "", ".hidden", "x".repeat(80), undefined]) assert.equal(safeName(bad, "fallback"), "fallback", String(bad));
	});
});

describe("the command line", () => {
	const state = "/tmp/browser.json";
	it("turns arguments into the daemon's requests", () => {
		assert.deepEqual(parseCli(["--state", state, "open", "http://127.0.0.1:1/"]), { state, cmd: "open", args: { url: "http://127.0.0.1:1/" } });
		assert.deepEqual(parseCli(["--state", state, "click", "e12"]).args, { ref: "e12" });
		assert.deepEqual(parseCli(["--state", state, "fill", "e3", "hello", "big", "world"]).args, { ref: "e3", text: "hello big world" });
		assert.deepEqual(parseCli(["--state", state, "wait", "--ms", "500", "--text", "Saved"]).args, { ms: 500, text: "Saved" });
		assert.deepEqual(parseCli(["--state", state, "screenshot", "after"]).args, { name: "after" });
		assert.deepEqual(parseCli(["--state", state, "screenshot"]).args, {});
		assert.deepEqual(parseCli(["--state", state, "upload", "e7", "C:/w/.qa/job-1/ticket-files/1-a b.BCK"]).args, { ref: "e7", file: "C:/w/.qa/job-1/ticket-files/1-a b.BCK" });
		assert.deepEqual(parseCli(["--state", state, "upload", "C:/w/x.BCK"]).args, { file: "C:/w/x.BCK" });
		for (const cmd of ["snapshot", "errors", "prints", "video-start", "video-stop", "status"]) assert.equal(parseCli(["--state", state, cmd]).cmd, cmd);
	});
	it("explains bad usage", () => {
		for (const argv of [[], ["snapshot"], ["--state", state], ["--state", state, "dance"], ["--state", state, "open"], ["--state", state, "fill", "e1"], ["--state", state, "snapshot", "extra"], ["--state", state, "wait", "--ms"], ["--state", state, "wait", "--bogus", "1"]]) {
			assert.throws(() => parseCli(argv), CliUsageError, JSON.stringify(argv));
		}
	});
});

const pages = {
	"http://127.0.0.1:3000/": { title: "Invoices", lines: ["# Invoices", '[e1] link "New"', '[e2] textbox "Customer"'] },
	"http://127.0.0.1:3000/new": { title: "New invoice", lines: ["# New invoice"] },
};

async function daemon() {
	const dir = mkdtempSync(join(tmpdir(), "qa-daemon-"));
	const backend = new FakeBackend(pages);
	const d = await BrowserDaemon.start({ backend, dir, allowHosts: ["127.0.0.1", "localhost"] });
	const cmd = (argv: string[]) => send(parseCli(["--state", d.statePath, ...argv]));
	return { d, backend, dir, cmd };
}

describe("handing a file to the page", () => {
	async function uploading(uploadRoot?: string) {
		const dir = mkdtempSync(join(tmpdir(), "qa-daemon-"));
		const backend = new FakeBackend(pages);
		const d = await BrowserDaemon.start({ backend, dir, allowHosts: ["127.0.0.1"], ...(uploadRoot ? { uploadRoot } : {}) });
		return { d, backend, cmd: (argv: string[]) => send(parseCli(["--state", d.statePath, ...argv])) };
	}
	const files = mkdtempSync(join(tmpdir(), "qa-files-"));
	writeFileSync(join(files, "backup.BCK"), "backup bytes");
	writeFileSync(join(files, "empty.BCK"), "");

	it("gives a file inside the workspace to the page, through a control or into the first file input", async () => {
		const { d, backend, cmd } = await uploading(files);
		try {
			assert.match(await cmd(["upload", "e5", join(files, "backup.BCK")]), /uploaded .*backup\.BCK \(12 bytes\) through e5/);
			assert.match(await cmd(["upload", join(files, "backup.BCK")]), /uploaded .*backup\.BCK \(12 bytes\); now/);
			assert.ok(backend.calls.some((call) => /^upload e5 .*backup\.BCK$/.test(call)));
			assert.ok(backend.calls.some((call) => /^upload - .*backup\.BCK$/.test(call)));
		} finally {
			await d.stop();
		}
	});

	it("refuses a file outside the workspace, a missing or empty one, and any file when no root is given", async () => {
		const { d, backend, cmd } = await uploading(files);
		try {
			await assert.rejects(cmd(["upload", "/etc/passwd"]), /upload: /);
			await assert.rejects(cmd(["upload", join(files, "missing.BCK")]), /no file at/);
			await assert.rejects(cmd(["upload", join(files, "empty.BCK")]), /between 1 byte and/);
			assert.equal(backend.calls.some((call) => call.startsWith("upload")), false, "the backend never saw them");
		} finally {
			await d.stop();
		}
		const none = await uploading();
		try {
			await assert.rejects(none.cmd(["upload", join(files, "backup.BCK")]), /may not hand files to the page/);
		} finally {
			await none.d.stop();
		}
	});
});

describe("the browser daemon", () => {
	it("drives the backend through the command line and keeps the state file private", async () => {
		const { d, backend, cmd } = await daemon();
		try {
			assert.match(await cmd(["open", "http://127.0.0.1:3000/"]), /opened http:\/\/127\.0\.0\.1:3000\/ - Invoices/);
			const snapshot = await cmd(["snapshot"]);
			assert.match(snapshot, /url: http:\/\/127\.0\.0\.1:3000\//);
			assert.match(snapshot, /\[e1\] link "New"/);
			assert.match(await cmd(["click", "e1"]), /clicked e1/);
			assert.match(await cmd(["click-text", "Mallar"]), /clicked "Mallar"/);
			assert.ok(backend.calls.includes("clickText Mallar"));
			assert.match(await cmd(["fill", "e2", "ACME", "AB"]), /filled e2/);
			assert.match(await cmd(["press", "Enter"]), /pressed/);
			assert.match(await cmd(["wait", "--text", "Saved"]), /waited/);
			assert.match(await cmd(["errors"]), /no console, page or network errors/);
			assert.match(await cmd(["prints"]), /nothing was sent to the printer/);
			assert.ok(backend.calls.includes("fill e2 ACME AB"));
			const state = JSON.parse(readFileSync(d.statePath, "utf8"));
			assert.equal(typeof state.token, "string");
			assert.equal((await import("node:fs")).statSync(d.statePath).mode & 0o077, 0, "only the owner can read the token");
		} finally {
			await d.stop();
		}
	});

	it("refuses a host that is not allowed before the backend sees it, and bad arguments", async () => {
		const { d, backend, cmd } = await daemon();
		try {
			await assert.rejects(() => cmd(["open", "https://example.com/"]), /not allowed/);
			await assert.rejects(() => cmd(["open", "file:///etc/passwd"]), /only http and https/);
			assert.deepEqual(backend.calls, []);
			await assert.rejects(() => cmd(["click", "button-1"]), /ref must look like e12/);
			await assert.rejects(() => cmd(["wait"]), /give --ms, --text or --selector/);
			await assert.rejects(() => cmd(["wait", "--ms", "999999"]), /ms must be from 0 to 30000/);
		} finally {
			await d.stop();
		}
	});

	it("rejects a caller without the token and an unknown route", async () => {
		const { d } = await daemon();
		try {
			const { port, token } = JSON.parse(readFileSync(d.statePath, "utf8"));
			assert.equal((await fetch(`http://127.0.0.1:${port}/cmd`, { method: "POST", body: "{}" })).status, 401);
			assert.equal((await fetch(`http://127.0.0.1:${port}/cmd`, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" })).status, 401);
			assert.equal((await fetch(`http://127.0.0.1:${port}/other`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" })).status, 404);
			assert.equal((await fetch(`http://127.0.0.1:${port}/cmd`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "not json" })).status, 400);
		} finally {
			await d.stop();
		}
	});

	it("saves screenshots under safe names and collects them", async () => {
		const { d, dir, cmd } = await daemon();
		try {
			assert.equal(await cmd(["screenshot", "before"]), "saved screenshots/before.png");
			assert.match(await cmd(["screenshot", "../../escape"]), /saved screenshots\/screenshot-\d+\.png/, "an unsafe name becomes a numbered one");
			assert.ok(existsSync(join(dir, "screenshots", "before.png")));
			assert.equal(d.files().screenshots.length, 2);
		} finally {
			await d.stop();
		}
	});

	it("records one video: start, stop, and the file is in videos/", async () => {
		const { d, dir, cmd } = await daemon();
		try {
			await assert.rejects(() => cmd(["video-stop"]), /not recording/);
			assert.match(await cmd(["video-start"]), /recording started/);
			await assert.rejects(() => cmd(["video-start"]), /already recording/);
			assert.equal(await cmd(["video-stop"]), "saved videos/qa-video-1.webm");
			assert.ok(existsSync(join(dir, "videos", "qa-video-1.webm")));
			assert.deepEqual(d.files().videos, ["videos/qa-video-1.webm"]);
		} finally {
			await d.stop();
		}
	});

	it("finishes a recording the model forgot to stop, and closes the backend, once", async () => {
		const { d, backend, cmd } = await daemon();
		await cmd(["video-start"]);
		const files = await d.stop();
		assert.deepEqual(files.videos, ["videos/qa-video-1.webm"]);
		assert.equal(backend.calls.filter((call) => call === "close").length, 1);
		await d.stop();
		assert.equal(backend.calls.filter((call) => call === "close").length, 1, "stopping twice closes once");
		await assert.rejects(() => cmd(["status"]), /not running/);
	});

	it("reports a backend failure to the caller as text", async () => {
		const { d, backend, cmd } = await daemon();
		try {
			backend.failOn = "snapshot";
			await assert.rejects(() => cmd(["snapshot"]), /fake failure for snapshot/);
			backend.failOn = undefined;
			assert.match(await cmd(["status"]), /recording: false/);
		} finally {
			await d.stop();
		}
	});

	it("cuts an over-long outline", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qa-daemon-"));
		const backend = new FakeBackend({ "http://127.0.0.1:3000/": { title: "Big", lines: Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(50)}`) } });
		const d = await BrowserDaemon.start({ backend, dir, allowHosts: ["127.0.0.1"], maxSnapshotChars: 1000 });
		try {
			await send(parseCli(["--state", d.statePath, "open", "http://127.0.0.1:3000/"]));
			const text = await send(parseCli(["--state", d.statePath, "snapshot"]));
			assert.ok(text.length < 1300);
			assert.match(text, /\[outline cut\]/);
		} finally {
			await d.stop();
		}
	});
});
