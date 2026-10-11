import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

/** What an archive may unpack to: a download is a server binary, not a tree of unbounded size. */
export interface ExtractLimits {
	maxBytes: number;
	maxEntries: number;
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = { maxBytes: 500 * 1024 * 1024, maxEntries: 20_000 };

export class ArchiveError extends Error {}

/** The path of an entry inside `root`, or an error for a name that would land outside it (absolute, `..`, a drive, a NUL). */
export function safeJoin(root: string, name: string): string {
	const portable = name.replaceAll("\\", "/");
	if (portable.includes("\0") || portable.startsWith("/") || /^[A-Za-z]:/.test(portable) || portable.split("/").includes("..")) throw new ArchiveError(`the archive has an entry outside its folder: ${name.slice(0, 80)}`);
	const base = resolve(root);
	const target = resolve(base, portable);
	if (target !== base && !target.startsWith(base + sep)) throw new ArchiveError(`the archive has an entry outside its folder: ${name.slice(0, 80)}`);
	return target;
}

class Budget {
	#bytes = 0;
	#entries = 0;
	readonly #limits: ExtractLimits;

	constructor(limits: ExtractLimits) {
		this.#limits = limits;
	}

	entry(): void {
		if (++this.#entries > this.#limits.maxEntries) throw new ArchiveError("the archive has too many entries");
	}

	bytes(size: number): void {
		this.#bytes += size;
		if (size < 0 || this.#bytes > this.#limits.maxBytes) throw new ArchiveError("the archive unpacks to more than the allowed size");
	}
}

function writeEntry(root: string, name: string, data: Uint8Array, executable: boolean): void {
	const target = safeJoin(root, name);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, data, { mode: executable ? 0o755 : 0o644 });
	chmodSync(target, executable ? 0o755 : 0o644);
}

const octal = (block: Buffer, from: number, to: number): number => {
	const text = block.toString("latin1", from, to).replace(/\0.*$/s, "").trim();
	return text === "" ? 0 : Number.parseInt(text, 8);
};
const cString = (block: Buffer, from: number, to: number): string => block.toString("utf8", from, to).replace(/\0.*$/s, "");

function paxFields(data: Buffer): Record<string, string> {
	const fields: Record<string, string> = {};
	let offset = 0;
	while (offset < data.length) {
		const space = data.indexOf(0x20, offset);
		if (space < 0) break;
		const length = Number.parseInt(data.toString("latin1", offset, space), 10);
		if (!Number.isInteger(length) || length <= 0) break;
		const record = data.toString("utf8", space + 1, offset + length - 1);
		const equals = record.indexOf("=");
		if (equals > 0) fields[record.slice(0, equals)] = record.slice(equals + 1);
		offset += length;
	}
	return fields;
}

/** Unpacks a `.tar.gz` into `root`. Regular files and directories only: a link, a device or a name outside `root` fails the whole archive. */
export function extractTarGz(archive: Uint8Array, root: string, limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS): void {
	let tar: Buffer;
	try {
		tar = gunzipSync(archive, { maxOutputLength: limits.maxBytes + 1024 * 1024 });
	} catch {
		throw new ArchiveError("the archive is not a readable .tar.gz or is larger than the allowed size");
	}
	const budget = new Budget(limits);
	mkdirSync(root, { recursive: true });
	let offset = 0;
	let longName: string | undefined;
	let pax: Record<string, string> = {};
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const type = String.fromCharCode(header[156] === 0 ? 0x30 : header[156]!);
		let size = octal(header, 124, 136);
		const mode = octal(header, 100, 108);
		const prefix = header.toString("latin1", 257, 262) === "ustar" ? cString(header, 345, 500) : "";
		let name = prefix ? `${prefix}/${cString(header, 0, 100)}` : cString(header, 0, 100);
		offset += 512;
		if (type === "x" || type === "g" || type === "L") {
			const body = tar.subarray(offset, offset + size);
			offset += Math.ceil(size / 512) * 512;
			if (type === "L") longName = cString(body, 0, body.length);
			else if (type === "x") pax = paxFields(body);
			continue;
		}
		if (pax.path) name = pax.path;
		else if (longName) name = longName;
		if (pax.size) size = Number.parseInt(pax.size, 10);
		longName = undefined;
		pax = {};
		if (!Number.isInteger(size) || size < 0) throw new ArchiveError("the archive has an entry of invalid size");
		budget.entry();
		if (type === "5") {
			mkdirSync(safeJoin(root, name), { recursive: true });
		} else if (type === "0") {
			budget.bytes(size);
			if (offset + size > tar.length) throw new ArchiveError("the archive is cut short");
			writeEntry(root, name, tar.subarray(offset, offset + size), (mode & 0o100) !== 0);
			offset += Math.ceil(size / 512) * 512;
		} else {
			throw new ArchiveError(`the archive has an entry that is neither a file nor a folder: ${name.slice(0, 80)}`);
		}
	}
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Unpacks a `.zip` into `root` (stored or deflated entries; no encryption, no zip64, no symbolic links). */
export function extractZip(archive: Uint8Array, root: string, limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS): void {
	const zip = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
	let end = -1;
	for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 65_535); at--) {
		if (zip.readUInt32LE(at) === EOCD) {
			end = at;
			break;
		}
	}
	if (end < 0) throw new ArchiveError("the archive is not a readable .zip");
	const count = zip.readUInt16LE(end + 10);
	const centralSize = zip.readUInt32LE(end + 12);
	let offset = zip.readUInt32LE(end + 16);
	if (count === 0xffff || centralSize === 0xffffffff || offset === 0xffffffff) throw new ArchiveError("zip64 archives are not supported");
	if (count > limits.maxEntries) throw new ArchiveError("the archive has too many entries");
	const budget = new Budget(limits);
	mkdirSync(root, { recursive: true });
	for (let index = 0; index < count; index++) {
		if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== CENTRAL) throw new ArchiveError("the archive's directory is damaged");
		const flags = zip.readUInt16LE(offset + 8);
		const method = zip.readUInt16LE(offset + 10);
		const compressed = zip.readUInt32LE(offset + 20);
		const size = zip.readUInt32LE(offset + 24);
		const nameLength = zip.readUInt16LE(offset + 28);
		const extraLength = zip.readUInt16LE(offset + 30);
		const commentLength = zip.readUInt16LE(offset + 32);
		const attributes = zip.readUInt32LE(offset + 38);
		const localAt = zip.readUInt32LE(offset + 42);
		const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength);
		offset += 46 + nameLength + extraLength + commentLength;
		budget.entry();
		if ((flags & 1) !== 0) throw new ArchiveError("the archive has an encrypted entry");
		const unixMode = attributes >>> 16;
		if ((unixMode & 0o170000) === 0o120000) throw new ArchiveError(`the archive has a symbolic link: ${name.slice(0, 80)}`);
		if (name.endsWith("/")) {
			mkdirSync(safeJoin(root, name), { recursive: true });
			continue;
		}
		budget.bytes(size);
		if (localAt + 30 > zip.length || zip.readUInt32LE(localAt) !== LOCAL) throw new ArchiveError("the archive's directory is damaged");
		const dataAt = localAt + 30 + zip.readUInt16LE(localAt + 26) + zip.readUInt16LE(localAt + 28);
		if (dataAt + compressed > zip.length) throw new ArchiveError("the archive is cut short");
		const stored = zip.subarray(dataAt, dataAt + compressed);
		let data: Buffer;
		if (method === 0) data = stored;
		else if (method === 8) {
			try {
				data = inflateRawSync(stored, { maxOutputLength: size + 1 });
			} catch {
				throw new ArchiveError(`the archive entry ${name.slice(0, 80)} is damaged or larger than it says`);
			}
		} else throw new ArchiveError(`the archive uses a compression method this agent does not read (${method})`);
		if (data.length !== size) throw new ArchiveError(`the archive entry ${name.slice(0, 80)} is not the size it says`);
		writeEntry(root, name, data, (unixMode & 0o100) !== 0);
	}
}
