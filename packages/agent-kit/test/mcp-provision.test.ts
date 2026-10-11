import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import { McpHub } from "../src/mcp/hub.ts";
import { fetchOverHttps, provision } from "../src/mcp/provision.ts";
import { sha256Hex, type McpEntry } from "../src/setup/contract.ts";

afterEach(() => mock.restoreAll());

const tmp = (): string => mkdtempSync(join(tmpdir(), "kit-provision-"));

interface TarEntry {
	name: string;
	data?: string;
	type?: string;
	mode?: number;
}

function tarOf(entries: TarEntry[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const data = Buffer.from(entry.data ?? "");
		const header = Buffer.alloc(512);
		header.write(entry.name, 0, 100);
		header.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100);
		header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
		header.write(entry.type ?? "0", 156);
		header.write("ustar\0", 257);
		blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

function zipOf(entries: { name: string; data: string; deflate?: boolean; mode?: number }[]): Buffer {
	const locals: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const raw = Buffer.from(entry.data);
		const body = entry.deflate ? deflateRawSync(raw) : raw;
		const name = Buffer.from(entry.name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
		local.writeUInt32LE(crc32(raw), 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		const head = Buffer.alloc(46);
		head.writeUInt32LE(0x02014b50, 0);
		head.writeUInt16LE(entry.deflate ? 8 : 0, 10);
		head.writeUInt32LE(crc32(raw), 16);
		head.writeUInt32LE(body.length, 20);
		head.writeUInt32LE(raw.length, 24);
		head.writeUInt16LE(name.length, 28);
		head.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
		head.writeUInt32LE(offset, 42);
		locals.push(local, name, body);
		central.push(head, name);
		offset += 30 + name.length + body.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

const download = (bytes: Buffer, archive: "none" | "zip" | "tar.gz", executable: string) => ({ url: "https://example.test/server", sha256: sha256Hex(bytes), archive, executable });
const serving = (bytes: Buffer) => {
	const calls: string[] = [];
	return { calls, fetchBytes: async (url: string) => (calls.push(url), bytes) };
};

describe("fetching a catalog download", () => {
	it("makes a plain executable available only after its checksum matched, and fetches it once", async () => {
		const root = tmp();
		const bytes = Buffer.from("#!/bin/sh\necho hi\n");
		const { calls, fetchBytes } = serving(bytes);
		const path = await provision({ root, name: "tool", download: download(bytes, "none", "tool"), fetchBytes });
		assert.equal(path, join(root, "tool", sha256Hex(bytes), "tool"));
		assert.equal(readFileSync(path, "utf8"), bytes.toString());
		assert.ok((statSync(path).mode & 0o111) !== 0, "executable");
		assert.equal(await provision({ root, name: "tool", download: download(bytes, "none", "tool"), fetchBytes }), path);
		assert.equal(calls.length, 1, "the second start uses what is cached by checksum");
	});

	it("refuses a file whose checksum is not the one the document names, and leaves nothing behind", async () => {
		const root = tmp();
		const wanted = download(Buffer.from("what the catalog says"), "none", "tool");
		await assert.rejects(provision({ root, name: "tool", download: wanted, ...serving(Buffer.from("something else")) }), /does not match its checksum/);
		assert.equal(existsSync(join(root, "tool", wanted.sha256)), false);
		assert.equal(existsSync(join(root, "tool", `${wanted.sha256}.partial`)), false);
		assert.deepEqual(existsSync(join(root, "tool")) ? readdirSync(join(root, "tool")) : [], [], "nothing was written");
	});

	it("unpacks a tar.gz and makes the named executable runnable", async () => {
		const root = tmp();
		const bytes = tarOf([{ name: "bin/", type: "5" }, { name: "bin/server", data: "#!/bin/sh\n", mode: 0o644 }, { name: "README", data: "docs" }]);
		const path = await provision({ root, name: "srv", download: download(bytes, "tar.gz", "bin/server"), ...serving(bytes) });
		assert.ok(path.endsWith(join("bin", "server")));
		assert.ok((statSync(path).mode & 0o111) !== 0);
		assert.equal(readFileSync(join(root, "srv", sha256Hex(bytes), "README"), "utf8"), "docs");
		assert.equal(statSync(join(root, "srv", sha256Hex(bytes), "README")).mode & 0o111, 0, "other files are not made executable");
	});

	it("unpacks a zip with stored and deflated entries", async () => {
		const root = tmp();
		const bytes = zipOf([{ name: "server.exe", data: "MZ stored" }, { name: "lib/data.txt", data: "deflated ".repeat(50), deflate: true }]);
		const path = await provision({ root, name: "srv", download: download(bytes, "zip", "server.exe"), ...serving(bytes) });
		assert.equal(readFileSync(path, "utf8"), "MZ stored");
		assert.equal(readFileSync(join(root, "srv", sha256Hex(bytes), "lib", "data.txt"), "utf8"), "deflated ".repeat(50));
	});

	it("refuses an archive entry that would land outside its folder, in a tar.gz and in a zip", async () => {
		const root = tmp();
		for (const [kind, bytes] of [["tar.gz", tarOf([{ name: "../../escaped.txt", data: "x" }, { name: "server", data: "x" }])], ["zip", zipOf([{ name: "../../escaped.txt", data: "x" }, { name: "server", data: "x" }])]] as const) {
			await assert.rejects(provision({ root, name: `srv-${kind}`, download: download(bytes, kind, "server"), ...serving(bytes) }), /outside its folder/);
			assert.equal(existsSync(join(root, "escaped.txt")), false);
			assert.equal(existsSync(join(root, "srv-escaped.txt")), false);
			assert.equal(existsSync(join(root, `srv-${kind}`, sha256Hex(bytes))), false, "no folder is made visible");
		}
		const absolute = tarOf([{ name: "/tmp/kit-provision-absolute.txt", data: "x" }, { name: "server", data: "x" }]);
		await assert.rejects(provision({ root, name: "abs", download: download(absolute, "tar.gz", "server"), ...serving(absolute) }), /outside its folder/);
	});

	it("refuses links in an archive", async () => {
		const root = tmp();
		const tar = tarOf([{ name: "server", data: "x" }, { name: "link", type: "2" }]);
		await assert.rejects(provision({ root, name: "l", download: download(tar, "tar.gz", "server"), ...serving(tar) }), /neither a file nor a folder/);
		const zip = zipOf([{ name: "server", data: "x" }, { name: "link", data: "server", mode: 0o120777 }]);
		await assert.rejects(provision({ root, name: "z", download: download(zip, "zip", "server"), ...serving(zip) }), /symbolic link/);
	});

	it("refuses an archive that lacks the executable it names", async () => {
		const root = tmp();
		const bytes = tarOf([{ name: "other", data: "x" }]);
		await assert.rejects(provision({ root, name: "srv", download: download(bytes, "tar.gz", "server"), ...serving(bytes) }), /does not contain server/);
	});

	it("fetches over https only, and follows a redirect only to https", async () => {
		await assert.rejects(fetchOverHttps("http://example.test/server", 1000), /https only/);
		mock.method(globalThis, "fetch", async () => new Response(null, { status: 302, headers: { location: "http://example.test/plain" } }));
		await assert.rejects(fetchOverHttps("https://example.test/server", 1000), /https only/);
	});

	it("refuses a download that is larger than allowed", async () => {
		mock.method(globalThis, "fetch", async () => new Response(Buffer.alloc(5000)));
		await assert.rejects(fetchOverHttps("https://example.test/server", 1000), /larger than allowed/);
	});
});

describe("the hub fetches what an entry needs", () => {
	const entryFor = (bytes: Buffer, over: Partial<McpEntry> = {}): McpEntry => ({
		name: "local",
		transport: "stdio",
		command: "${LOCAL}",
		args: ["--stdio"],
		approval: "never",
		downloads: { [process.platform]: download(bytes, "none", "server") },
		...over,
	});

	it("runs the downloaded executable for ${LOCAL}", async () => {
		const bytes = Buffer.from("#!/bin/sh\n");
		const hub = new McpHub({ root: tmp(), env: { PATH: "/bin" }, fetchBytes: serving(bytes).fetchBytes });
		const prepared = await hub.prepare([entryFor(bytes)], true);
		assert.equal(prepared.servers.length, 1);
		await hub.close();
	});

	it("reads the catalog's name for Windows, which Node calls win32", async () => {
		const bytes = Buffer.from("MZ");
		const hub = new McpHub({ root: tmp(), env: {}, platform: "win32", fetchBytes: serving(bytes).fetchBytes });
		const entry = entryFor(bytes, { downloads: { windows: download(bytes, "none", "server.exe") }, command: "${LOCAL}" });
		assert.equal((await hub.prepare([entry], true)).servers.length, 1);
		await assert.rejects(new McpHub({ root: tmp(), env: {}, platform: "darwin", fetchBytes: serving(bytes).fetchBytes }).prepare([entry], true), /has no download for darwin/);
	});

	it("rejects an entry with a checksum mismatch, with no download for this system, or that runs ${LOCAL} without one", async () => {
		const bytes = Buffer.from("#!/bin/sh\n");
		const hub = new McpHub({ root: tmp(), env: {}, fetchBytes: serving(Buffer.from("tampered")).fetchBytes });
		await assert.rejects(hub.prepare([entryFor(bytes)], true), /could not be fetched.*does not match its checksum/);
		await assert.rejects(hub.prepare([entryFor(bytes, { downloads: { plan9: download(bytes, "none", "server") } })], true), /has no download for/);
		await assert.rejects(hub.prepare([entryFor(bytes, { downloads: undefined })], true), /runs \$\{LOCAL\} but has no download/);
	});
});
