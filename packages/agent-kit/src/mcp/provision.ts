import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { sha256Hex, type McpDownload } from "../setup/contract.ts";
import { ArchiveError, extractTarGz, extractZip, safeJoin } from "./archive.ts";

/** The largest file a catalog download may be. */
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export class ProvisionError extends Error {}

export type FetchBytes = (url: string, maxBytes: number) => Promise<Uint8Array>;

/** A GET over https only: every redirect must stay on https as well, so a download is never carried in the clear. */
export const fetchOverHttps: FetchBytes = async (url, maxBytes) => {
	let current = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		if (!current.startsWith("https://")) throw new ProvisionError("a download is fetched over https only");
		const response = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(5 * 60_000) });
		if (response.status >= 300 && response.status < 400) {
			const next = response.headers.get("location");
			await response.body?.cancel().catch(() => undefined);
			if (!next) throw new ProvisionError("the download redirects nowhere");
			current = new URL(next, current).toString();
			continue;
		}
		if (!response.ok) throw new ProvisionError(`the download answered HTTP ${response.status}`);
		const declared = Number(response.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > maxBytes) throw new ProvisionError("the download is larger than allowed");
		const reader = response.body?.getReader();
		if (!reader) throw new ProvisionError("the download has no body");
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.length;
			if (total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new ProvisionError("the download is larger than allowed");
			}
			chunks.push(value);
		}
		return Buffer.concat(chunks);
	}
	throw new ProvisionError("the download redirects too often");
};

export interface ProvisionOptions {
	/** `<state>/mcp`. */
	root: string;
	name: string;
	download: McpDownload;
	fetchBytes?: FetchBytes;
}

/**
 * The executable of a catalog entry for this machine, fetched once: into `<root>/<name>/<sha256>/`, so a changed checksum is a changed folder and
 * what is there was checked. The bytes are verified against the SHA-256 before anything is written as executable or unpacked; a folder is made
 * visible only when complete. Returns the executable's absolute path.
 */
export async function provision(options: ProvisionOptions): Promise<string> {
	const { download } = options;
	const folder = resolve(options.root, options.name, download.sha256);
	const executable = safeJoin(folder, download.executable);
	if (existsSync(join(folder, ".verified")) && existsSync(executable)) return executable;
	const bytes = await (options.fetchBytes ?? fetchOverHttps)(download.url, MAX_DOWNLOAD_BYTES);
	if (sha256Hex(bytes) !== download.sha256) throw new ProvisionError(`the download of ${options.name} does not match its checksum`);
	const staging = `${folder}.partial`;
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	try {
		if (download.archive === "none") {
			if (basename(download.executable) !== download.executable) throw new ProvisionError("a download that is the executable itself needs a plain file name");
			writeFileSync(join(staging, download.executable), bytes, { mode: 0o755 });
		} else if (download.archive === "zip") extractZip(bytes, staging);
		else extractTarGz(bytes, staging);
		const staged = safeJoin(staging, download.executable);
		if (!existsSync(staged) || !statSync(staged).isFile()) throw new ProvisionError(`the download of ${options.name} does not contain ${download.executable}`);
		chmodSync(staged, 0o755);
		writeFileSync(join(staging, ".verified"), download.sha256);
		rmSync(folder, { recursive: true, force: true });
		renameSync(staging, folder);
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		if (error instanceof ArchiveError) throw new ProvisionError(error.message);
		throw error;
	}
	return executable;
}
