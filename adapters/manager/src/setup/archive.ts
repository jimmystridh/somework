import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { SetupRejected } from "./contract.ts";

export const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 5000;

/** A path an archive names, checked to stay inside the folder it is extracted to: no absolute path, no `..`, no drive letter or backslash. */
export function insideFolder(folder: string, name: string): string {
	const cleaned = normalize(name);
	if (!name || isAbsolute(name) || name.includes("\\") || name.includes("\0") || /^[A-Za-z]:/.test(name) || cleaned === ".." || cleaned.startsWith(`..${sep}`)) {
		throw new SetupRejected(`the archive names a path outside its folder: ${name.slice(0, 80)}`);
	}
	return join(folder, cleaned);
}

class Budget {
	entries = 0;
	bytes = 0;

	take(size: number): void {
		if (++this.entries > MAX_ENTRIES) throw new SetupRejected(`the archive has more than ${MAX_ENTRIES} entries`);
		this.bytes += size;
		if (this.bytes > MAX_EXTRACTED_BYTES) throw new SetupRejected("the archive unpacks to more than 512 MiB");
	}
}

async function place(folder: string, name: string, data: Buffer, mode: number): Promise<void> {
	const target = insideFolder(folder, name);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, data, { mode: (mode & 0o755) | 0o400, flag: "wx" });
}

const octal = (block: Buffer, from: number, to: number): number => {
	const field = block.subarray(from, to);
	if (field[0]! & 0x80) throw new SetupRejected("the archive uses a size format that is not supported");
	const text = field.toString("latin1").replace(/\0.*$/s, "").trim();
	return text ? Number.parseInt(text, 8) : 0;
};

const text = (block: Buffer, from: number, to: number): string => block.subarray(from, to).toString("utf8").replace(/\0.*$/s, "");

/** Regular files and folders only: a link or device in the archive rejects it. */
export async function extractTarGz(bytes: Buffer, folder: string): Promise<void> {
	let tar: Buffer;
	try {
		tar = gunzipSync(bytes, { maxOutputLength: MAX_EXTRACTED_BYTES + 1024 * 1024 });
	} catch {
		throw new SetupRejected("the download is not a readable tar.gz archive");
	}
	const budget = new Budget();
	let longName: string | undefined;
	for (let at = 0; at + 512 <= tar.length; ) {
		const header = tar.subarray(at, at + 512);
		if (header.every((byte) => byte === 0)) return;
		const size = octal(header, 124, 136);
		const type = String.fromCharCode(header[156] || 48);
		const prefix = text(header, 345, 500);
		const name = longName ?? `${prefix ? `${prefix}/` : ""}${text(header, 0, 100)}`;
		const data = tar.subarray(at + 512, at + 512 + size);
		if (data.length !== size) throw new SetupRejected("the tar archive is cut short");
		at += 512 + Math.ceil(size / 512) * 512;
		if (type === "x" || type === "g") continue;
		if (type === "L") {
			longName = data.toString("utf8").replace(/\0.*$/s, "");
			continue;
		}
		longName = undefined;
		if (type === "5") {
			insideFolder(folder, name);
			continue;
		}
		if (type !== "0") throw new SetupRejected(`the archive holds an entry that is neither a file nor a folder: ${name.slice(0, 80)}`);
		budget.take(size);
		await place(folder, name, Buffer.from(data), octal(header, 100, 108));
	}
	throw new SetupRejected("the tar archive has no end marker");
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Stored and deflated entries without encryption or ZIP64; a symbolic link in the archive rejects it. */
export async function extractZip(bytes: Buffer, folder: string): Promise<void> {
	let end = -1;
	for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65_535); at--) {
		if (bytes.readUInt32LE(at) === EOCD) {
			end = at;
			break;
		}
	}
	if (end < 0) throw new SetupRejected("the download is not a readable zip archive");
	const count = bytes.readUInt16LE(end + 10);
	let at = bytes.readUInt32LE(end + 16);
	if (count === 0xffff || at === 0xffffffff) throw new SetupRejected("zip64 archives are not supported");
	const budget = new Budget();
	for (let index = 0; index < count; index++) {
		if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== CENTRAL) throw new SetupRejected("the zip archive is damaged");
		const flags = bytes.readUInt16LE(at + 8);
		const method = bytes.readUInt16LE(at + 10);
		const compressed = bytes.readUInt32LE(at + 20);
		const size = bytes.readUInt32LE(at + 24);
		const nameLength = bytes.readUInt16LE(at + 28);
		const extraLength = bytes.readUInt16LE(at + 30);
		const commentLength = bytes.readUInt16LE(at + 32);
		const unixMode = bytes.readUInt32LE(at + 38) >>> 16;
		const localAt = bytes.readUInt32LE(at + 42);
		const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
		at += 46 + nameLength + extraLength + commentLength;
		if (flags & 1) throw new SetupRejected("encrypted zip archives are not supported");
		if ((unixMode & 0o170000) === 0o120000) throw new SetupRejected(`the archive holds a symbolic link: ${name.slice(0, 80)}`);
		if (name.endsWith("/")) {
			insideFolder(folder, name);
			continue;
		}
		budget.take(size);
		if (localAt + 30 > bytes.length || bytes.readUInt32LE(localAt) !== LOCAL) throw new SetupRejected("the zip archive is damaged");
		const start = localAt + 30 + bytes.readUInt16LE(localAt + 26) + bytes.readUInt16LE(localAt + 28);
		const raw = bytes.subarray(start, start + compressed);
		if (raw.length !== compressed) throw new SetupRejected("the zip archive is cut short");
		let data: Buffer;
		if (method === 0) data = Buffer.from(raw);
		else if (method === 8) {
			try {
				data = inflateRawSync(raw, { maxOutputLength: size + 1 });
			} catch {
				throw new SetupRejected(`the zip entry ${name.slice(0, 80)} cannot be unpacked`);
			}
		} else throw new SetupRejected(`the zip entry ${name.slice(0, 80)} uses an unsupported compression`);
		if (data.length !== size) throw new SetupRejected(`the zip entry ${name.slice(0, 80)} has the wrong size`);
		await place(folder, name, data, unixMode & 0o777 || 0o644);
	}
}
