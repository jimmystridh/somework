import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { extractTarGz, extractZip, insideFolder } from "./archive.ts";
import { sha256Hex, SetupRejected, type McpDownload, type McpEntry } from "./contract.ts";

export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export type FetchBytes = (url: string, maxBytes: number) => Promise<Buffer>;

/** https only, also for every redirect; the body is cut off at `maxBytes`. */
export const fetchHttps: FetchBytes = async (url, maxBytes) => {
	let target = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		if (!target.startsWith("https://")) throw new SetupRejected(`only https downloads are accepted: ${target.slice(0, 80)}`);
		const response = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(300_000) });
		const next = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && next) {
			target = new URL(next, target).toString();
			continue;
		}
		if (!response.ok || !response.body) throw new SetupRejected(`the download answered ${response.status}`);
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of response.body) {
			size += chunk.length;
			if (size > maxBytes) throw new SetupRejected(`the download is larger than ${maxBytes} bytes`);
			chunks.push(Buffer.from(chunk));
		}
		return Buffer.concat(chunks);
	}
	throw new SetupRejected("the download redirects too often");
};

export interface DownloadOptions {
	/** On this host: one folder per SHA-256 below it, so a version that is already there is not fetched again. */
	cacheDir: string;
	/** The same folder as Pi (in its container) sees it. */
	containerDir: string;
	/** Of the machine Pi runs on: `linux`, `windows` or `darwin`. */
	os: string;
	fetchBytes?: FetchBytes;
}

async function isFile(path: string): Promise<boolean> {
	return stat(path).then((info) => info.isFile(), () => false);
}

async function unpack(download: McpDownload, executable: string, bytes: Buffer, folder: string): Promise<void> {
	if (download.archive === "tar.gz") return extractTarGz(bytes, folder);
	if (download.archive === "zip") return extractZip(bytes, folder);
	const target = insideFolder(folder, executable);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, bytes, { mode: 0o700, flag: "wx" });
}

/**
 * Makes the local server of a catalog entry available to Pi and returns where the executable is in Pi's container. The file is
 * checked against the SHA-256 of the document before anything is unpacked; the cache is keyed by that checksum and filled by an atomic rename.
 */
export async function ensureLocalServer(entry: McpEntry, options: DownloadOptions): Promise<string> {
	const download = entry.downloads?.[options.os];
	if (!download) throw new SetupRejected(`the MCP entry ${entry.name} has no download for ${options.os}`);
	if (!download.url.startsWith("https://")) throw new SetupRejected(`the download for ${entry.name} is not https`);
	const folder = join(options.cacheDir, download.sha256);
	const name = download.archive === "none" ? basename(download.executable) : download.executable;
	const executable = insideFolder(folder, name);
	if (!(await isFile(executable))) {
		const bytes = await (options.fetchBytes ?? fetchHttps)(download.url, MAX_DOWNLOAD_BYTES);
		if (sha256Hex(bytes) !== download.sha256) throw new SetupRejected(`the download for ${entry.name} does not match its SHA-256`);
		const partial = `${folder}.partial-${process.pid}`;
		await rm(partial, { recursive: true, force: true });
		await mkdir(partial, { recursive: true, mode: 0o700 });
		try {
			await unpack(download, name, bytes, partial);
			const unpacked = insideFolder(partial, name);
			if (!(await isFile(unpacked))) throw new SetupRejected(`the download for ${entry.name} does not contain ${download.executable}`);
			await chmod(unpacked, 0o755);
			await rm(folder, { recursive: true, force: true });
			await rename(partial, folder);
		} catch (error) {
			await rm(partial, { recursive: true, force: true });
			throw error;
		}
	}
	const relative = executable.slice(options.cacheDir.length + 1);
	return `${options.containerDir}/${relative.split("\\").join("/")}`;
}
